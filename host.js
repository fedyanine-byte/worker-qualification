// host.js — authoritative game host. Runs humans + 100 bots + shadow twins.
import {
  db, GAME, gref, pcol, pref, polcol, evcol,
  doc, setDoc, getDoc, updateDoc, onSnapshot, collection,
  addDoc, serverTimestamp, writeBatch, getDocs, deleteDoc, logEvent
} from './shared.js';

const E = window.Engine;
const P = window.PARAMS;
const N_BOTS = 100;
const N_MINISTERS = 3;
const QUARTER_SECS = 90;
const POLICY_SECS = 30;

// ---------- in-memory authoritative state ----------
let state = null;              // mirror of games/class
let playersDoc = {};           // id -> player doc (from Firestore)
let humans = {};               // id -> engine worker (authoritative)
let humanTwins = {};           // id -> twin worker
let bots = [];                 // engine workers
let botTwins = [];             // twins
let seedBase = 0;
let timerInt = null;
let curView = 'live';

const FAMNAME = ['none', '1 child', '2+ kids', 'parent'];

// ---------- boot ----------
const base = location.href.replace(/[^/]*$/, '');
document.getElementById('joinUrl').textContent = base.replace(/^https?:\/\//, '');
drawQR(base);

onSnapshot(gref(), s => { state = s.exists() ? s.data() : null; renderState(); });
onSnapshot(pcol(), snap => {
  snap.docChanges().forEach(ch => {
    if (ch.type === 'removed') delete playersDoc[ch.doc.id];
    else playersDoc[ch.doc.id] = { id: ch.doc.id, ...ch.doc.data() };
  });
  assignRoles();
  renderAll();
});
onSnapshot(polcol(), () => renderGov());

ensureState();
async function ensureState() {
  const s = await getDoc(gref());
  if (!s.exists()) await setDoc(gref(), freshState());
}
function freshState() {
  return {
    phase: 'lobby', quarter: 0, academyDeal: false, policies: {}, pendingPolicies: {},
    budget: 100000, spent: 0, borrowed: 0, approval: null, reqBump: {},
    timerEnd: null, announcement: '', seedBase: Math.floor(Math.random() * 1e9),
  };
}

// ---------- role assignment ----------
async function assignRoles() {
  if (!state || state.phase !== 'lobby') return;
  const pending = Object.values(playersDoc).filter(p => !p.role);
  const ministers = Object.values(playersDoc).filter(p => p.role === 'minister').length;
  const portfolios = ['Finance', 'Labour & Welfare', 'Education'];
  for (const p of pending) {
    let role, extra = {};
    const mNow = Object.values(playersDoc).filter(x => x.role === 'minister').length;
    if (mNow < N_MINISTERS) { role = 'minister'; extra.portfolio = portfolios[mNow]; }
    else role = 'worker';
    playersDoc[p.id].role = role; Object.assign(playersDoc[p.id], extra);
    const patch = { role, ...extra };
    if (role === 'worker') {
      const w = newHumanWorker(p.id);
      Object.assign(patch, publicWorker(w));
    }
    await updateDoc(pref(p.id), patch).catch(() => {});
  }
}

function newHumanWorker(id) {
  const rng = E.makeRng((state.seedBase ^ hash(id)) >>> 0);
  const prof = E.makeProfile(rng);
  const w = E.makeWorker(prof, 'cautious');
  w.id = id; w.human = true; w.seed = Math.floor(rng() * 1e9);
  humans[id] = w;
  const t = E.twinOf(w); t.human = true; humanTwins[id] = t;
  return w;
}
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function publicWorker(w) {
  return {
    profile: w.profile, skills: w.skills, savings: Math.round(w.savings),
    status: w.status, fit: E.fit(w.skills, Math.max(0, (state.quarter || 1) - 1)),
    pendingChoices: [], submitted: false, lastEvent: null,
  };
}

// ---------- main control button ----------
window.HOST = {
  async mainAction() {
    if (!state) return;
    if (state.phase === 'lobby') return startGame();
    if (state.phase === 'quarter') return resolveQuarter();
    if (state.phase === 'policy') return nextQuarter();
    if (state.phase === 'ended') return;
  },
  tab(v) { curView = v; document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.v === v));
    document.querySelectorAll('.view').forEach(x => x.classList.remove('active'));
    document.getElementById('v-' + v).classList.add('active'); renderAll(); },
  async announce() { const t = prompt('Message to all phones:'); if (t) { await updateDoc(gref(), { announcement: t }); logEvent('announce', '📢 ' + t); } },
  async raiseReq() {
    const sk = prompt('Raise which skill next quarter? (english,digital,data,fleet,teleop,safety,reg,agents,cyber)');
    if (!sk || !P.requirements[sk]) return;
    const bump = { ...(state.reqBump || {}) }; bump[sk] = (bump[sk] || 0) + 1;
    await updateDoc(gref(), { reqBump: bump }); logEvent('system', `⚙️ CapyUber raised the ${sk} requirement`);
  },
  async offerDeal() { await updateDoc(gref(), { academyDeal: !state.academyDeal });
    logEvent('system', state.academyDeal ? 'CapyUber withdrew the experience-waiver deal' : '🤝 CapyUber offers to waive the 2-years clause if gov funds Academy'); },
  async reset() {
    if (!confirm('Reset the whole game?')) return;
    clearInterval(timerInt);
    for (const c of ['players', 'policies', 'events']) {
      const snap = await getDocs(collection(db, 'games', GAME, c));
      const b = writeBatch(db); snap.forEach(d => b.delete(d.ref)); await b.commit();
    }
    humans = {}; humanTwins = {}; bots = []; botTwins = []; playersDoc = {};
    await setDoc(gref(), freshState()); toast('Game reset');
  },
};

// ---------- game flow ----------
async function startGame() {
  const rng = E.makeRng(state.seedBase >>> 0);
  bots = []; botTwins = [];
  const strat = () => { const r = rng(); return r < 0.5 ? 'cautious' : r < 0.8 ? 'ambitious' : 'passive'; };
  for (let i = 0; i < N_BOTS; i++) {
    const w = E.makeWorker(E.makeProfile(rng), strat());
    w.id = 'bot' + i; w.seed = Math.floor(rng() * 1e9);
    bots.push(w); botTwins.push(E.twinOf(w));
  }
  await updateDoc(gref(), { phase: 'quarter', quarter: 1, timerEnd: Date.now() + QUARTER_SECS * 1000 });
  await clearSubmissions();
  logEvent('system', '🟢 Game started — Quarter 1. Drive or study.');
}

function reqSnapshot(qIndex) {
  // apply host reqBump on top of base table
  const req = {};
  E.SKILLS.forEach(k => { req[k] = P.requirements[k][qIndex] + ((state.reqBump || {})[k] || 0); });
  return req;
}
function syncReqBump() { P.reqBump = (state && state.reqBump) || {}; }
function activePolicies() { return state.policies || {}; }

async function resolveQuarter() {
  clearInterval(timerInt);
  syncReqBump();
  const qIdx = state.quarter - 1;
  // pull human submissions
  for (const id in humans) {
    const pd = playersDoc[id];
    humans[id].pendingChoices = (pd && pd.pendingChoices) || [];
    humanTwins[id].pendingChoices = (pd && pd.pendingChoices) || [];
  }
  const polReal = { ...activePolicies(), academyDeal: state.academyDeal };
  const polNone = {};

  const ctxR = mkCtx(polReal), ctxT = mkCtx(polNone);
  const realWorkers = [...Object.values(humans), ...bots];
  const twinWorkers = [...Object.values(humanTwins), ...botTwins];
  const rngR = E.makeRng((state.seedBase ^ (qIdx * 101)) >>> 0);
  const rngT = E.makeRng((state.seedBase ^ (qIdx * 101)) >>> 0);
  for (const w of realWorkers) E.resolveQuarter(w, qIdx, ctxR, rngR);
  for (const w of twinWorkers) E.resolveQuarter(w, qIdx, ctxT, rngT);

  // budget: tax in, policy costs out
  let budget = state.budget + Math.round(ctxR.taxCollected);
  let spent = state.spent + policyCost(polReal, realWorkers, qIdx);
  budget -= policyCost(polReal, realWorkers, qIdx);

  // write human results
  const b = writeBatch(db);
  for (const id in humans) {
    const w = humans[id], t = humanTwins[id];
    b.update(pref(id), {
      skills: w.skills, savings: Math.round(w.savings), status: w.status,
      fit: E.fit(w.skills, qIdx), lastEvent: w.lastEvent || null,
      twinFit: E.fit(t.skills, qIdx), twinStatus: t.status, submitted: false,
    });
  }
  await b.commit().catch(() => {});

  const last = state.quarter >= P.quarters;
  if (last) {
    for (const w of realWorkers) E.hire(w, ctxR);
    for (const w of twinWorkers) E.hire(w, ctxT);
    await writeHiring();
    await updateDoc(gref(), { phase: 'ended', budget, spent, timerEnd: null });
    logEvent('system', '🏁 Hiring round complete. See Results.');
    HOST.tab('results');
  } else {
    await updateDoc(gref(), { phase: 'policy', budget, spent, timerEnd: Date.now() + POLICY_SECS * 1000 });
    logEvent('system', `⏹ Quarter ${state.quarter} resolved. Ministers — 30 seconds.`);
    if (state.quarter === 4) await openVote();
  }
}

function mkCtx(pol) { return { policies: pol || {}, academySeatsLeft: 12, taxCollected: 0, voucherUsedThisQ: {} }; }

function policyCost(pol, workers, qIdx) {
  let c = 0;
  const active = workers.filter(w => w.status === 'active');
  if (pol.incomeSupport) active.forEach(w => c += Math.min(E.activeStudyHours(w), P.incomeSupportCapHrs) * P.incomeSupportPerHour * P.weeksPerQuarter);
  if (pol.childcare) c += active.filter(w => w.profile.fam >= 1).length * 900;
  if (pol.bootcampSubsidy) c += 20000;
  if (pol.voucher) active.forEach(w => { /* approx covered already in fees */ c += 0; });
  return Math.round(c);
}

async function nextQuarter() {
  clearInterval(timerInt);
  // gather approved policies, fold into active (childcare delayed one more quarter)
  const snap = await getDocs(polcol());
  const pol = { ...activePolicies() };
  snap.forEach(d => { const p = d.data(); if (p.approved) {
    if (p.type === 'childcare') { if ((p.approvedQ || 0) + 1 <= state.quarter) pol.childcare = true; }
    else pol[p.type] = true;
  }});
  await updateDoc(gref(), { phase: 'quarter', quarter: state.quarter + 1, policies: pol, timerEnd: Date.now() + QUARTER_SECS * 1000 });
  await clearSubmissions();
  logEvent('system', `🟢 Quarter ${state.quarter + 1} started.`);
}

async function clearSubmissions() { const b = writeBatch(db); for (const id in humans) b.update(pref(id), { submitted: false, pendingChoices: [] }); await b.commit().catch(() => {}); }
async function openVote() { await updateDoc(gref(), { voteOpen: true }); logEvent('system', '🗳 Rate the government on your phone.'); }
async function writeHiring() {
  // persist post-hire status + final fit to each phone
  const b = writeBatch(db);
  for (const id in humans) {
    const w = humans[id], t = humanTwins[id];
    b.update(pref(id), {
      status: w.status, fit: w.finalFit != null ? w.finalFit : E.fit(w.skills, P.quarters - 1),
      twinFit: t.finalFit != null ? t.finalFit : E.fit(t.skills, P.quarters - 1), twinStatus: t.status,
    });
  }
  await b.commit().catch(() => {});
}

// ---------- timer ----------
function startTimer() {
  clearInterval(timerInt);
  const el = document.getElementById('timer');
  if (!state.timerEnd) { el.textContent = '—'; el.className = 'timer'; return; }
  const tick = () => {
    const d = Math.max(0, Math.ceil((state.timerEnd - Date.now()) / 1000));
    el.textContent = Math.floor(d / 60) + ':' + String(d % 60).padStart(2, '0');
    el.className = 'timer' + (d <= 10 ? ' danger' : d <= 30 ? ' warn' : '');
    if (d <= 0) { clearInterval(timerInt); if (state.phase === 'quarter') resolveQuarter(); }
  };
  tick(); timerInt = setInterval(tick, 500);
}

// ---------- rendering ----------
function renderState() {
  if (!state) return;
  document.getElementById('hq').textContent = state.quarter || '—';
  const pb = document.getElementById('phaseBadge'), dot = document.getElementById('dot');
  const names = { lobby: 'Lobby', quarter: 'Quarter active', policy: 'Policy window', ended: 'Game over' };
  pb.textContent = names[state.phase] || state.phase;
  dot.className = 'dot' + (state.phase === 'quarter' ? ' live' : '');
  const btn = document.getElementById('btnMain');
  btn.textContent = { lobby: '▶ Start Game', quarter: '⏹ Resolve Quarter', policy: '▶ Next Quarter', ended: 'Game Complete' }[state.phase];
  btn.disabled = state.phase === 'ended';
  document.getElementById('btnDeal').textContent = state.academyDeal ? '✅ Deal offered' : '🤝 Offer the deal';
  const lobby = state.phase === 'lobby';
  document.getElementById('lobbyBox').style.display = lobby ? 'flex' : 'none';
  document.getElementById('liveStats').style.display = lobby ? 'none' : 'grid';
  document.getElementById('humanTableWrap').style.display = lobby ? 'none' : 'block';
  startTimer();
  renderAll();
}

function renderAll() {
  if (!state) return;
  renderLive();
  if (curView === 'target') renderTarget();
  if (curView === 'gov') renderGov();
  if (curView === 'results') renderResults();
  if (curView === 'model') renderModel();
  document.getElementById('nMin').textContent = N_MINISTERS;
}

function allReal() { return [...Object.values(humans), ...bots]; }
function medianFit() {
  const qIdx = Math.max(0, (state.quarter || 1) - 1);
  const fs = allReal().filter(w => w.status !== 'exited').map(w => E.fit(w.skills, qIdx)).sort((a, b) => a - b);
  return fs.length ? fs[Math.floor(fs.length / 2)] : null;
}

function renderLive() {
  const workers = Object.values(playersDoc).filter(p => p.role === 'worker');
  const all = allReal();
  const qIdx = Math.max(0, (state.quarter || 1) - 1);
  const hired = all.filter(w => w.status === 'hired').length;
  const exited = all.filter(w => w.status === 'exited').length;
  document.getElementById('sWorkers').textContent = workers.length + ' + ' + N_BOTS + ' sim';
  document.getElementById('sHired').textContent = hired;
  document.getElementById('sExited').textContent = exited;
  const mf = medianFit(); document.getElementById('sFit').textContent = mf != null ? Math.round(mf * 100) + '%' : '—';
  document.getElementById('sBudget').textContent = '€' + ((state.budget || 0) / 1000).toFixed(0) + 'k';
  document.getElementById('sTax').textContent = '~€' + Math.round(taxForecast(qIdx) / 1000) + 'k';

  // human rows
  const body = document.getElementById('humanBody');
  body.innerHTML = workers.map(p => {
    const f = Math.round((p.fit || 0) * 100);
    const tf = Math.round((p.twinFit || 0) * 100);
    const col = p.status === 'hired' ? 'hired' : p.status === 'exited' ? 'exited' : p.status === 'active' ? 'active' : 'other';
    const fc = f >= 80 ? 'var(--green)' : f >= 50 ? 'var(--orange)' : 'var(--red)';
    const delta = f - tf;
    return `<tr class="${p.status === 'exited' ? 'dead' : ''}">
      <td>${esc(p.name || '—')}</td><td class="num">${p.profile ? p.profile.age : '—'}</td>
      <td>${p.profile ? FAMNAME[p.profile.fam] : '—'}</td>
      <td><span class="bar"><i style="width:${f}%;background:${fc}"></i></span> <span class="num">${f}%</span></td>
      <td class="num">€${p.savings != null ? p.savings : '—'}</td>
      <td><span class="pill ${col}">${label(p.status)}</span></td>
      <td class="num" style="color:${delta > 0 ? 'var(--green)' : delta < 0 ? 'var(--red)' : 'var(--dim)'}">${delta > 0 ? '+' : ''}${delta || 0}</td></tr>`;
  }).join('') || `<tr><td colspan="7" class="muted">No workers joined yet.</td></tr>`;

  // bot grid
  const grid = document.getElementById('botGrid');
  grid.innerHTML = bots.map(w => {
    const f = E.fit(w.skills, qIdx);
    let c = 'var(--surface2)';
    if (w.status === 'hired') c = 'var(--yellow)';
    else if (w.status === 'exited') c = 'var(--red)';
    else if (f >= 0.75) c = 'var(--green)';
    else if (f >= 0.5) c = 'var(--orange)';
    return `<div class="bot" style="background:${c}" title="age ${w.profile.age}, fit ${Math.round(f * 100)}%"></div>`;
  }).join('');
}

function taxForecast(qIdx) {
  // rough: active workers drive ~ full-time at next rate * 20%
  const n = allReal().filter(w => w.status === 'active').length + 1;
  const rate = P.drivingRate[Math.min(qIdx + 1, 7)] * P.rateMult;
  return n * 40 * P.weeksPerQuarter * rate * 0.20;
}

function label(s) { return ({ hired: 'Hired', interviewed: 'Interviewed', exited: 'Exited', active: 'Active', stillTraining: 'Retraining', publicJob: 'Public job', bridged: 'Bridged' })[s] || s || 'Waiting'; }
function esc(s) { return String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

// ---- moving target chart ----
function renderTarget() {
  const cv = document.getElementById('targetChart'), g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  const W = cv.width, H = cv.height, m = 48;
  const maxReq = 22;
  const X = q => m + (q) / 7 * (W - 2 * m);
  const Y = v => H - m - (v / maxReq) * (H - 2 * m);
  // grid
  g.strokeStyle = '#1E2D40'; g.fillStyle = '#4B6280'; g.font = '11px DM Mono';
  for (let v = 0; v <= maxReq; v += 4) { g.beginPath(); g.moveTo(m, Y(v)); g.lineTo(W - m, Y(v)); g.stroke(); g.fillText(v, 6, Y(v) + 4); }
  for (let q = 0; q < 8; q++) g.fillText('Q' + (q + 1), X(q) - 6, H - 20);
  // requirement line (total)
  g.strokeStyle = '#EF4444'; g.lineWidth = 2.5; g.beginPath();
  for (let q = 0; q < 8; q++) { const tot = E.SKILLS.reduce((s, k) => s + P.requirements[k][q] + ((state.reqBump || {})[k] || 0), 0); const x = X(q), y = Y(tot); q ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.stroke();
  g.fillStyle = '#EF4444'; g.fillText('Required', W - m - 56, Y(22) - 8);
  // workforce fit band: convert fit% to points via *req_total
  const pts = [];
  for (let q = 0; q < 8; q++) {
    const hist = allReal().map(w => (w.history[q] ? w.history[q].fit : null)).filter(x => x != null).sort((a, b) => a - b);
    if (!hist.length) break;
    const tot = E.SKILLS.reduce((s, k) => s + P.requirements[k][q] + ((state.reqBump || {})[k] || 0), 0);
    pts.push({ q, lo: hist[Math.floor(hist.length * .25)] * tot, mid: hist[Math.floor(hist.length * .5)] * tot, hi: hist[Math.floor(hist.length * .75)] * tot });
  }
  if (pts.length) {
    g.fillStyle = 'rgba(59,130,246,.18)'; g.beginPath();
    pts.forEach((p, i) => { const x = X(p.q), y = Y(p.hi); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    for (let i = pts.length - 1; i >= 0; i--) { const x = X(pts[i].q), y = Y(pts[i].lo); g.lineTo(x, y); }
    g.closePath(); g.fill();
    g.strokeStyle = '#3B82F6'; g.lineWidth = 2; g.beginPath();
    pts.forEach((p, i) => { const x = X(p.q), y = Y(p.mid); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
    g.fillStyle = '#3B82F6'; g.fillText('Workforce', X(pts[pts.length - 1].q) - 60, Y(pts[pts.length - 1].mid) + 18);
  }
}

// ---- government ----
async function renderGov() {
  if (!state) return;
  document.getElementById('gBudget').textContent = '€' + Math.round((state.budget || 0) / 1000) + 'k';
  document.getElementById('gSpent').textContent = '€' + Math.round((state.spent || 0) / 1000) + 'k';
  document.getElementById('gApproval').textContent = state.approval != null ? state.approval.toFixed(1) + '/5' : '—';
  const pol = activePolicies();
  const act = Object.keys(pol).filter(k => pol[k]);
  document.getElementById('gActive').textContent = act.length;
  document.getElementById('govPolicies').innerHTML = act.length ? act.map(k => '• ' + polName(k)).join('<br>') : 'None active yet.';
}
function polName(k) { return ({ incomeSupport: 'Income support while training', childcare: 'Childcare support', voucher: 'Training vouchers', bootcampSubsidy: 'Subsidised bootcamp seats', banAgeGate: 'Age-gate ban', jobGuarantee: 'Public job guarantee', bridge: 'Early retirement bridge', robotTax: 'Robot tax' }[k] || k); }

// ---- results ----
function renderResults() {
  const all = allReal();
  const cnt = s => all.filter(w => w.status === s).length;
  document.getElementById('rHired').textContent = cnt('hired') + ' (' + pct('hired') + '%)';
  document.getElementById('rTrain').textContent = cnt('stillTraining') + cnt('interviewed');
  document.getElementById('rExit').textContent = cnt('exited');
  document.getElementById('rPub').textContent = cnt('publicJob') + cnt('bridged');
  const realHired = all.filter(w => w.status === 'hired').length / all.length;
  const twinHired = [...Object.values(humanTwins), ...botTwins].filter(w => w.status === 'hired').length / all.length;
  document.getElementById('rLift').textContent = Math.round(twinHired * 100) + '% → ' + Math.round(realHired * 100) + '%';
  // scatter age vs fit
  const cv = document.getElementById('scatter'), g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height);
  const W = cv.width, H = cv.height, m = 44;
  g.strokeStyle = '#1E2D40'; g.fillStyle = '#4B6280'; g.font = '11px DM Mono';
  for (let f = 0; f <= 100; f += 20) { const y = H - m - f / 100 * (H - 2 * m); g.beginPath(); g.moveTo(m, y); g.lineTo(W - m, y); g.stroke(); g.fillText(f + '%', 6, y + 4); }
  for (let a = 25; a <= 58; a += 5) { const x = m + (a - 25) / 33 * (W - 2 * m); g.fillText(a, x - 6, H - 18); }
  // 80% bar
  const yBar = H - m - 0.8 * (H - 2 * m); g.strokeStyle = '#10B981'; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(m, yBar); g.lineTo(W - m, yBar); g.stroke(); g.setLineDash([]);
  all.forEach(w => {
    const x = m + (w.profile.age - 25) / 33 * (W - 2 * m);
    const y = H - m - (w.finalFit || 0) * (H - 2 * m);
    g.fillStyle = w.status === 'hired' ? '#F5BE00' : w.status === 'exited' ? 'rgba(239,68,68,.5)' : 'rgba(124,148,173,.5)';
    g.beginPath(); g.arc(x, y, 3, 0, 7); g.fill();
  });
}
function pct(s) { const all = allReal(); return all.length ? Math.round(all.filter(w => w.status === s).length / all.length * 100) : 0; }

// ---- model reveal ----
function renderModel() {
  document.getElementById('modelBody').innerHTML = `
  <p><strong style="color:var(--text)">The hidden filter:</strong> candidates aged ${P.ageFilterThreshold}+ silently needed ${Math.round(P.ageFilterFitPenalty * 100)} extra points of fit to be hired. Nobody was told. This is the algorithmic-bias slide, live.</p>
  <p style="margin-top:10px"><strong style="color:var(--text)">The 2-years clause:</strong> without CapyUber Academy you needed ${Math.round(P.noAcademyFit * 100)}% fit, not ${Math.round(P.interviewFit * 100)}%. The deal removed it — that was regulatory capture.</p>
  <p style="margin-top:10px"><strong style="color:var(--text)">Study capacity:</strong> ${P.capacityBase}h/week, minus ${P.capacityPenaltyPerDecadeOver35}h per decade over 35, minus ${P.capacityHighFamilyPenalty}h with heavy family load. Age acts through <em>time</em>, never intelligence.</p>
  <p style="margin-top:10px"><strong style="color:var(--text)">Wages:</strong> fell from €${(P.drivingRate[0] * P.rateMult).toFixed(1)} to €${(P.drivingRate[7] * P.rateMult).toFixed(1)}/hour as robotaxis spread. Requirements rose every quarter. That is the moving target.</p>
  <p style="margin-top:10px"><strong style="color:var(--text)">The bots</strong> use a stylized age/family spread, not real Latvian workforce data. Ask: would real data make the gradient steeper or flatter?</p>
  <p style="margin-top:14px;color:var(--orange)">Every number here is a choice the designer made. Which one would you challenge?</p>`;
}

function drawQR(url) {
  const img = new Image();
  img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=' + encodeURIComponent(url);
  img.width = 150; img.height = 150; img.alt = 'join QR';
  const box = document.getElementById('qr'); box.innerHTML = ''; box.appendChild(img);
}
function toast(m) { const t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2200); }
