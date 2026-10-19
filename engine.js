// engine.js — CapyUber: Autopilot simulation core. Browser + Node.
(function (root) {
'use strict';

const P = (typeof require !== 'undefined') ? require('./params.js') : root;
const { PARAMS, FAMILY, COURSES, SKILLS, LIFE_EVENTS } = P;

// ---- seeded RNG (mulberry32) ----
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ri = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// ---- profile generation ----
function makeProfile(rng) {
  const age = ri(rng, 25, 58);
  const fam = ri(rng, 0, 3);
  const savingsBase = ri(rng, PARAMS.savingsLo, PARAMS.savingsHi) + (age - 25) * PARAMS.savingsPerYear;
  const education = ri(rng, 0, 2);    // 0 secondary, 1 vocational, 2 bachelor
  const english = ri(rng, 1, 3);      // A2/B1/B2
  const digital = ri(rng, 0, 2);
  return { age, fam, education, english, digital, savings: savingsBase };
}

function chrs(c) { return Math.max(2, Math.round(c.hrs * PARAMS.hoursMult)); }

function initSkills(profile) {
  const s = {};
  SKILLS.forEach(k => s[k] = 0);
  s.english = profile.english;
  s.digital = profile.digital;
  s.safety = PARAMS.startingSafety;
  return s;
}

function capacity(profile) {
  let c = PARAMS.capacityBase;
  if (profile.age > 35) c -= Math.floor((profile.age - 35) / 10 + 1e-9) * PARAMS.capacityPenaltyPerDecadeOver35;
  if (FAMILY[profile.fam].level >= 2) c -= PARAMS.capacityHighFamilyPenalty;
  return Math.max(6, c);
}

function requiredAt(q) {
  const r = {};
  SKILLS.forEach(k => r[k] = PARAMS.requirements[k][q]);
  return r;
}

function fit(skills, q) {
  const req = requiredAt(q);
  let have = 0, need = 0;
  SKILLS.forEach(k => { have += Math.min(skills[k], req[k]); need += req[k]; });
  return need ? have / need : 1;
}

// ---- worker ----
function makeWorker(profile, strategy) {
  return {
    profile, strategy,
    skills: initSkills(profile),
    savings: profile.savings,
    rentExtra: 0,
    status: 'active',          // active | exited | hired | interviewed | notHired | publicJob | bridged | stillTraining
    enroll: [],                // {id, remaining, lastLoad}
    done: {},                  // completed course ids
    history: [],
  };
}

function activeStudyHours(w) { return w.enroll.reduce((h, e) => h + chrs(courseById(e.id)), 0); }
function courseById(id) { return COURSES.find(c => c.id === id); }

// ---- decision heuristic (bots + twins) ----
const STRAT = {
  passive:   { loadCap: 0.5,  buffer: 1500, freeOnly: true  },
  cautious:  { loadCap: 1.1,  buffer: 650,  freeOnly: false },
  ambitious: { loadCap: 1.3,  buffer: 150,  freeOnly: false },
};

// priority weight: enablers first, then skills below final requirement
function courseScore(c, w) {
  const finalReq = requiredAt(PARAMS.quarters - 1);
  let score = 0;
  for (const k in c.gain) {
    const below = Math.max(0, finalReq[k] - w.skills[k]);
    if (below > 0) score += below * 10;
  }
  // enablers unlock downstream courses
  if (c.gain.english || c.gain.digital || c.gain.safety) score += 6;
  if (c.academy) score += 8; // free, high value
  if (c.restore) score += 15; // fix obsolescence urgently
  return score;
}

function chooseCourses(w, q, ctx) {
  if (w.status !== 'active') return [];
  const st = STRAT[w.strategy];
  const cap = capacity(w.profile);
  const inProgress = new Set(w.enroll.map(e => e.id));
  let hoursUsed = activeStudyHours(w);
  let feeBudget = w.savings - st.buffer;

  const candidates = COURSES.filter(c => {
    if (inProgress.has(c.id)) return false;
    if (w.done[c.id] && !c.restore) return false;
    if ((c.available || 0) > q) return false;
    if (st.freeOnly && c.fee > 0) return false;
    // academy age gate may be lifted by policy
    if (c.academy && ctx.policies.banAgeGate) {
      if (w.profile.education < 1) return false;
    } else if (!c.req(w.skills, w.profile)) return false;
    if (c.restore && w.skills.fleet >= requiredAt(q).fleet) return false; // only if actually behind
    if (courseScore(c, w) <= 0 && !c.restore) return false; // nothing useful
    // academy seat limit
    if (c.academy && ctx.academySeatsLeft <= 0) return false;
    return true;
  }).sort((a, b) => courseScore(b, w) - courseScore(a, w));

  const chosen = [];
  for (const c of candidates) {
    const netFee = effectiveFee(c, w, q, ctx);
    const newLoad = (hoursUsed + chrs(c)) / cap;
    if (newLoad > st.loadCap) continue;
    if (netFee > feeBudget) continue;
    chosen.push(c.id);
    hoursUsed += chrs(c);
    feeBudget -= netFee;
    if (c.academy) ctx.academySeatsLeft--;
  }
  return chosen;
}

function effectiveFee(c, w, q, ctx) {
  let fee = c.fee;
  if (c.id === 'data_boot' && ctx.policies.bootcampSubsidy) fee *= 0.5;
  if (ctx.policies.voucher) {
    const covered = Math.min(fee, Math.max(0, 1500 - (ctx.voucherUsedThisQ[w.id] || 0)));
    fee -= covered;
  }
  return fee;
}

// ---- quarter resolution ----
function resolveQuarter(w, q, ctx, rng) {
  if (w.status !== 'active') return;
  const cap = capacity(w.profile);
  const fam = FAMILY[w.profile.fam];

  // enroll new courses
  const newIds = chooseCourses(w, q, ctx);
  for (const id of newIds) {
    const c = courseById(id);
    let fee = effectiveFee(c, w, q, ctx);
    if (ctx.policies.voucher) ctx.voucherUsedThisQ[w.id] = (ctx.voucherUsedThisQ[w.id] || 0) + Math.min(c.fee, 1500);
    w.savings -= fee;
    w.enroll.push({ id, remaining: c.quarters, feePaid: fee });
  }

  // hours & load
  let freeHours = fam.freeHours;
  if (ctx.policies.childcare && fam.level >= 1) freeHours += PARAMS.childcareHours;
  let study = activeStudyHours(w);
  // event hour penalty applied below may reduce; compute load on study vs capacity
  const load = study / cap;

  // income
  let drivingH = Math.max(0, freeHours - study);
  let income = drivingH * PARAMS.weeksPerQuarter * (PARAMS.drivingRate[q]*PARAMS.rateMult);

  // income support policy: pays per study hour up to 15/wk
  if (ctx.policies.incomeSupport) {
    income += Math.min(study, PARAMS.incomeSupportCapHrs) * PARAMS.incomeSupportPerHour * PARAMS.weeksPerQuarter;
  }

  // life event
  let event = null;
  if (rng() < PARAMS.eventChance) {
    event = pick(rng, LIFE_EVENTS);
    if (event.incomeMult) income *= event.incomeMult;
    if (event.cash) w.savings += event.cash;
    if (event.rentRise) w.rentExtra += event.rentRise;
    if (event.hours) { // reduce effective study this quarter -> may raise dropout, modeled as load bump
      // fewer hours available: if it cuts into driving, income already set; approximate income loss
      income -= Math.max(0, -event.hours) * (PARAMS.drivingRate[q]*PARAMS.rateMult);
    }
  }

  const living = PARAMS.livingBase + fam.level * PARAMS.livingPerFamilyLevel + w.rentExtra;
  w.savings += income - living;
  ctx.taxCollected += Math.max(0, income) * 0.20; // 20% tax base (driving income approx)

  // burnout: one random active course fails
  if (load > PARAMS.loadBurnoutThreshold && w.enroll.length > 0) {
    const victim = pick(rng, w.enroll);
    w.enroll = w.enroll.filter(e => e !== victim);
  }

  // advance enrollments, complete & roll dropout
  const stillIn = [];
  for (const e of w.enroll) {
    e.remaining -= 1;
    if (e.remaining <= 0) {
      const c = courseById(e.id);
      let drop = c.drop;
      if (load > PARAMS.loadWarnThreshold) drop *= 2;
      if (rng() < drop) {
        // dropped: fee+hours lost, no gain
      } else {
        for (const k in c.gain) w.skills[k] = Math.min(4, w.skills[k] + c.gain[k]);
        w.done[e.id] = true;
      }
    } else {
      stillIn.push(e);
    }
  }
  w.enroll = stillIn;

  // obsolescence (end of fleet v2 quarter)
  if (q === PARAMS.fleetV2Quarter) {
    if (!w.done['fleet_v2']) w.skills.fleet = Math.max(0, w.skills.fleet - 1);
  }

  // exit if broke
  if (w.savings < 0) {
    w.status = 'exited';
    w.exitQ = q;
  }
  w.history.push({ q, fit: fit(w.skills, q), savings: Math.round(w.savings), status: w.status });
}

// ---- hiring ----
function hire(w, ctx) {
  if (w.status === 'exited' || w.status === 'publicJob' || w.status === 'bridged') return;
  const f = fit(w.skills, PARAMS.quarters - 1);
  let threshold = w.done['academy'] ? PARAMS.interviewFit : (ctx.policies.academyDeal ? PARAMS.interviewFit : PARAMS.noAcademyFit);
  if (w.profile.age >= PARAMS.ageFilterThreshold) threshold += PARAMS.ageFilterFitPenalty;
  w.finalFit = f;
  w.status = (f >= threshold) ? 'hired' : (f >= PARAMS.interviewFit ? 'interviewed' : 'stillTraining');
}

// ---- population ----
function makePopulation(rng, nBots) {
  const pop = [];
  const strat = () => { const r = rng(); return r < 0.5 ? 'cautious' : r < 0.8 ? 'ambitious' : 'passive'; };
  for (let i = 0; i < nBots; i++) {
    const w = makeWorker(makeProfile(rng), strat());
    w.id = 'bot' + i;
    pop.push(w);
  }
  return pop;
}

// ---- run a whole game (bots only; policies = scenario object) ----
function runGame(seed, nBots, policies) {
  const rng = makeRng(seed);
  const pop = makePopulation(rng, nBots);
  const ctx = {
    policies: policies || {},
    academySeatsLeft: 12,
    taxCollected: 0,
    voucherUsedThisQ: {},
  };
  for (let q = 0; q < PARAMS.quarters; q++) {
    ctx.academySeatsLeft = 12; // seats reset per 2-quarter intake cycle (approx)
    ctx.voucherUsedThisQ = {};
    for (const w of pop) resolveQuarter(w, q, ctx, rng);
  }
  for (const w of pop) hire(w, ctx);
  return { pop, ctx };
}

const API = { makeRng, makeProfile, initSkills, capacity, requiredAt, fit, makeWorker,
  chooseCourses, resolveQuarter, hire, makePopulation, runGame, STRAT, PARAMS, COURSES, SKILLS, FAMILY };
if (typeof module !== 'undefined') module.exports = API;
else root.Engine = API;
})(typeof self !== 'undefined' ? self : this);
