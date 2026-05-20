/* Validation harness — runs the projection engine against the source spreadsheet's expected outputs.
 *
 * Inputs:
 *   C1: age 66, FT $165k, PT @ 67 $60k, freedom 72, super $290k, super return 6%
 *   C2: age 65, FT $58k,  PT @ 66 $80k, freedom 72, super $185k, super return 6%
 *   Shared: 2% inflation, 12% SGC, 5.5% drawdown return, $140k desired, no non-super, no pension
 *
 * Expected (from spreadsheet):
 *   Total balance at retirement ≈ $781,614
 *   Desired balance        ≈ $1,911,185
 *   Gap                    ≈ $1,129,571
 *   Funds deplete at age 78
 */

import { readFileSync } from 'node:fs';

// --- Re-create constants from app.js ---
const PENSION = {
  asAt: "20 March 2026", eligibleAge: 67, maxAnnualCouple: 47070, maxFortnightlyCouple: 1810.40,
  assetFull: { homeowner: 481500, nonHomeowner: 739500 },
  assetCut:  { homeowner: 1085000, nonHomeowner: 1343000 },
  taperPerThousand: 78, incomeFreeAreaPF: 380, incomeTaper: 0.5,
  deemThresholdCouple: 106200, deemLow: 0.0125, deemHigh: 0.0325, workBonusPF: 300,
};
const SUPER_TAX = 0.15;
const CONCESSIONAL_CAP = 30000;
const NCC_BRINGFWD3 = 360000;

const state = {
  clients: [
    { currentAge: 66, ftIncome: 165000, ptAge: 67, ptIncome: 60000, freedomAge: 72, superBalance: 290000, additionalConcessional: 0, superReturn: 0.06 },
    { currentAge: 65, ftIncome: 58000,  ptAge: 66, ptIncome: 80000, freedomAge: 72, superBalance: 185000, additionalConcessional: 0, superReturn: 0.06 },
  ],
  shared: { inflation: 0.02, sgcRate: 0.12, nonSuper: 0, additionalInvestment: 0, investReturn: 0.055, drawdownReturn: 0.055, desiredIncome: 140000, planToAge: 90 },
  debt: { balance: 0, rate: 0, annualPayment: 0, fromCashflow: true },
  inheritance: { amount: 0, ageReceived: 75, destination: "nonSuper" },
  pension: { include: false, homeowner: true, pensionAge: 67 }, // disabled to match spreadsheet
};

function accumulateSuper(opening, salary, sgcRate, addConcessional, returnRate) {
  const contribGross = salary * sgcRate + addConcessional;
  const contribCapped = Math.min(contribGross, CONCESSIONAL_CAP);
  const grossReturn = (opening + contribCapped / 2) * returnRate;
  const tax = (contribCapped + grossReturn) * SUPER_TAX;
  return { closing: opening + contribCapped + grossReturn - tax, contribGross: contribCapped, grossReturn, tax };
}
function compoundSuperPostWork(opening, returnRate) {
  const grossReturn = opening * returnRate;
  const tax = grossReturn * SUPER_TAX;
  return { closing: opening + grossReturn - tax, grossReturn, tax };
}
function requiredBalance(desiredIncome, inflation, drawdownReturn, years) {
  const g = inflation, r = drawdownReturn;
  if (years <= 0) return 0;
  if (Math.abs(r - g) < 1e-9) return desiredIncome * years * (1 + r);
  const ratio = (1 + g) / (1 + r);
  return desiredIncome * (1 + r) * (1 - Math.pow(ratio, years)) / (r - g);
}

function runProjection() {
  const c = state.clients, s = state.shared;
  const olderStart = Math.min(c[0].currentAge, c[1].currentAge);
  const totalYears = Math.max(50, s.planToAge - olderStart + 5);
  const cs = c.map(x => ({ age: x.currentAge, super: x.superBalance, superAtFreedom: null }));
  let invest = s.nonSuper;
  let drawdownStarted = false, drawdownYearIndex = 0, combinedBalance = null;
  let depletionAge = null, lastPositiveAge = null, yearsFullyFunded = 0;
  const rows = [];

  for (let t = 1; t <= totalYears; t++) {
    const row = { t, age: [cs[0].age, cs[1].age] };
    for (let i = 0; i < 2; i++) {
      const cli = c[i], st = cs[i];
      if (st.age < cli.freedomAge) {
        const isPT = st.age >= cli.ptAge;
        const baseSalary = isPT ? cli.ptIncome : cli.ftIncome;
        const salary = baseSalary * Math.pow(1 + s.inflation, t - 1);
        const acc = accumulateSuper(st.super, salary, s.sgcRate, cli.additionalConcessional, cli.superReturn);
        row[`salary${i}`] = salary;
        row[`super${i}_open`] = st.super;
        row[`return${i}`] = acc.grossReturn;
        row[`contrib${i}`] = acc.contribGross;
        st.super = acc.closing;
        row[`super${i}_close`] = st.super;
      } else {
        if (st.superAtFreedom === null) st.superAtFreedom = st.super;
        const cmp = compoundSuperPostWork(st.super, cli.superReturn);
        row[`super${i}_open`] = st.super;
        st.super = cmp.closing;
        row[`super${i}_close`] = st.super;
      }
    }

    if (drawdownStarted) {
      drawdownYearIndex++;
      const desiredThisYear = s.desiredIncome * Math.pow(1 + s.inflation, drawdownYearIndex - 1);
      const grossReturn = combinedBalance * s.drawdownReturn;
      const newBalance = combinedBalance + grossReturn - desiredThisYear;
      row.dd = drawdownYearIndex; row.startBalance = combinedBalance;
      row.drawdownIncome = desiredThisYear; row.investReturn = grossReturn;
      row.endBalance = Math.max(0, newBalance);
      if (newBalance > 0) lastPositiveAge = cs[0].age;
      if (newBalance <= 0 && depletionAge === null) depletionAge = lastPositiveAge ?? cs[0].age;
      const nextYearReq = desiredThisYear * (1 + s.inflation);
      if (newBalance >= nextYearReq) yearsFullyFunded++;
      combinedBalance = Math.max(0, newBalance);
      row.totalWealth = combinedBalance;
    } else {
      row.totalWealth = cs[0].super + cs[1].super + invest;
    }
    rows.push(row);

    cs[0].age++; cs[1].age++;
    if (!drawdownStarted && cs[0].age >= c[0].freedomAge && cs[1].age >= c[1].freedomAge) {
      const bal0 = cs[0].superAtFreedom ?? cs[0].super;
      const bal1 = cs[1].superAtFreedom ?? cs[1].super;
      combinedBalance = bal0 + bal1 + invest;
      drawdownStarted = true;
    }
  }

  const planYears = Math.max(1, s.planToAge - Math.max(c[0].freedomAge, c[1].freedomAge));
  const requiredLump = requiredBalance(s.desiredIncome, s.inflation, s.drawdownReturn, planYears);
  const retirementBalance = (cs[0].superAtFreedom ?? 0) + (cs[1].superAtFreedom ?? 0);
  return { rows, requiredLump, retirementBalance, depletionAge, yearsFullyFunded };
}

const r = runProjection();
console.log("=== Year-by-year (accumulation: t1..t8, drawdown: t8..t14) ===");
for (const row of r.rows.slice(0, 14)) {
  const dd = row.dd ? ` DD${row.dd} start=${row.startBalance.toFixed(0)} draw=${row.drawdownIncome.toFixed(0)} end=${row.endBalance.toFixed(0)}` : "";
  console.log(`t=${row.t} ages=${row.age[0]}/${row.age[1]} S1=${(row.super0_close??0).toFixed(0)} S2=${(row.super1_close??0).toFixed(0)} total=${row.totalWealth.toFixed(0)}${dd}`);
}

console.log("\n=== Summary ===");
console.log(`Retirement balance: $${r.retirementBalance.toFixed(0)}     (spreadsheet: $781,614)`);
console.log(`Required lump sum : $${r.requiredLump.toFixed(0)}    (spreadsheet: $1,911,185)`);
console.log(`Funding gap       : $${(r.requiredLump - r.retirementBalance).toFixed(0)}    (spreadsheet: $1,129,571)`);
console.log(`Funds deplete age : ${r.depletionAge}                   (spreadsheet: 78)`);
console.log(`Years fully funded: ${r.yearsFullyFunded}                    (spreadsheet: 5)`);

// Compute deltas
const targets = { rb: 781614, lump: 1911185, gap: 1129571, dep: 78, funded: 5 };
const got = { rb: r.retirementBalance, lump: r.requiredLump, gap: r.requiredLump - r.retirementBalance, dep: r.depletionAge, funded: r.yearsFullyFunded };
console.log("\n=== Deltas ===");
console.log(`Retirement balance Δ: ${((got.rb - targets.rb)/targets.rb*100).toFixed(2)}%`);
console.log(`Required lump      Δ: ${((got.lump - targets.lump)/targets.lump*100).toFixed(2)}%`);
console.log(`Gap                Δ: ${((got.gap - targets.gap)/targets.gap*100).toFixed(2)}%`);
console.log(`Deplete age        Δ: ${got.dep - targets.dep}`);
console.log(`Years funded       Δ: ${got.funded - targets.funded}`);
