const E = require('./engine.js');
const scen = {
  'No policy': {},
  'Good mix (free/universal ceiling)': { incomeSupport:true, childcare:true, academyDeal:true, banAgeGate:true },
  'Money only (vouchers+bootcamp)': { voucher:true, bootcampSubsidy:true },
};
const N = 1000;
function seg(w,kind){ const p=w.profile,f=p.fam;
  if(kind==='young') return p.age<35&&f===0;
  if(kind==='mid')   return p.age>=40&&p.age<50;
  if(kind==='old')   return p.age>=50&&f>=1;
}
const rows=[];
for (const [name,pol] of Object.entries(scen)) {
  let hired=0,tot=0,ex=0,pub=0,br=0; const segc={young:[0,0],mid:[0,0],old:[0,0]};
  for(let g=0;g<N;g++){ const {pop}=E.runGame(g*7919+1,110,pol);
    for(const w of pop){ tot++;
      if(w.status==='hired')hired++; if(w.status==='exited')ex++;
      for(const k of ['young','mid','old']) if(seg(w,k)){segc[k][1]++; if(w.status==='hired')segc[k][0]++;} } }
  rows.push({name,hired:100*hired/tot,exit:100*ex/tot,
    young:100*segc.young[0]/segc.young[1],mid:100*segc.mid[0]/segc.mid[1],old:100*segc.old[0]/segc.old[1]});
}
console.log('scenario'.padEnd(36),'hired%  exit% | young% mid% old%');
for(const r of rows) console.log(r.name.padEnd(36),
  r.hired.toFixed(1).padStart(5),r.exit.toFixed(1).padStart(6),'|',
  r.young.toFixed(0).padStart(6),r.mid.toFixed(0).padStart(5),r.old.toFixed(0).padStart(5));
// emit chart data
require('fs').writeFileSync('calibration.json',JSON.stringify(rows,null,1));
