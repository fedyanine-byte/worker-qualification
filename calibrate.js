// calibrate.js — Monte Carlo over many games; reports hired share by scenario & segment.
const E = require('./engine.js');

const scenarios = {
  'No policy': {},
  'Good mix': { incomeSupport: true, childcare: true, academyDeal: true, banAgeGate: true },
  'Money only': { voucher: true, bootcampSubsidy: true },
};

function share(pop, pred) {
  const sub = pop.filter(pred);
  if (!sub.length) return NaN;
  return sub.filter(w => w.status === 'hired').length / sub.length;
}

function run(nGames = 400, nBots = 110) {
  const out = {};
  for (const [name, pol] of Object.entries(scenarios)) {
    let hired = 0, total = 0, exited = 0, interviewed = 0;
    let youngSingle = [0, 0], oldFamily = [0, 0];
    const fits = [];
    for (let g = 0; g < nGames; g++) {
      const { pop } = E.runGame(g * 7919 + 1, nBots, pol);
      for (const w of pop) {
        total++;
        if (w.status === 'hired') hired++;
        if (w.status === 'exited') exited++;
        if (w.status === 'interviewed') interviewed++;
        if (w.finalFit != null) fits.push(w.finalFit);
        const young = w.profile.age < 35 && w.profile.fam === 0;
        const old = w.profile.age >= 50 && w.profile.fam >= 1;
        if (young) { youngSingle[1]++; if (w.status === 'hired') youngSingle[0]++; }
        if (old)   { oldFamily[1]++;   if (w.status === 'hired') oldFamily[0]++; }
      }
    }
    out[name] = {
      hired: (100 * hired / total).toFixed(1),
      interviewed: (100 * interviewed / total).toFixed(1),
      exited: (100 * exited / total).toFixed(1),
      youngSingle: youngSingle[1] ? (100 * youngSingle[0] / youngSingle[1]).toFixed(1) : 'n/a',
      oldFamily: oldFamily[1] ? (100 * oldFamily[0] / oldFamily[1]).toFixed(1) : 'n/a',
      medianFit: (100 * fits.sort((a, b) => a - b)[Math.floor(fits.length / 2)]).toFixed(0),
    };
  }
  return out;
}

const res = run();
console.log('Scenario             Hired%  Intvw%  Exited%  Young&single%  50+&family%  MedianFit%');
for (const [name, r] of Object.entries(res)) {
  console.log(
    name.padEnd(20),
    String(r.hired).padStart(5),
    String(r.interviewed).padStart(7),
    String(r.exited).padStart(7),
    String(r.youngSingle).padStart(12),
    String(r.oldFamily).padStart(12),
    String(r.medianFit).padStart(10),
  );
}
