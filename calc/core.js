import { INFLATION, SUPER, RETURN_PROFILES } from '../data/parameters.js';
import { accumStep, accumCompound, pensionCompound, convertToPension, minDrawdownAmount } from './tax.js';
import { calcPension, safeEarnAmount } from './pension.js';

function getReturnRate(profile) {
  const p = RETURN_PROFILES.find(r => r.id === profile);
  return p ? p.rate : 0.06;
}

// Annuity-due formula — present value of inflation-adjusted income stream
export function requiredBalance(desiredIncome, returnRate, years) {
  const g = INFLATION, r = returnRate;
  if (years <= 0) return 0;
  if (Math.abs(r - g) < 1e-9) return desiredIncome * years * (1 + r);
  return desiredIncome * (1 + r) * (1 - Math.pow((1 + g) / (1 + r), years)) / (r - g);
}

/**
 * Run a full year-by-year projection.
 * @param {object} params   - Full state (clients, shared, debt, inheritance, pension, agedCare, survivor, bequest)
 * @param {boolean} applySequencing - Apply -25% sequencing shock to opening balance in year 1 of retirement
 * @returns {object} { rows, requiredLump, retirementBalance, depletionAge, yearsFullyFunded, freedomAge,
 *                     pensionStartAge, pensionDetail, safeEarn }
 */
export function runProjection(params, applySequencing = false) {
  const c = params.clients;
  const s = params.shared;
  const debt = params.debt   ?? { balance: 0, rate: 0, annualPayment: 0 };
  const inh  = params.inheritance ?? { amount: 0, ageReceived: 75, destination: 'nonSuper' };
  const pen  = params.pension ?? { include: true, homeowner: true, pensionAge: 67 };
  const ac   = params.agedCare  ?? { active: false, amount: 500000, triggerAge: 85, mode: 'invested' };
  const surv = params.survivor  ?? { active: true, expenseFactor: 0.70 };
  const beq  = params.bequest   ?? { active: false, amount: 0 };

  const returnRate   = getReturnRate(s.returnProfile);
  const jointFreedom = Math.max(c[0].freedomAge, c[1].freedomAge);
  const olderStart   = Math.min(c[0].currentAge, c[1].currentAge);
  const totalYears   = (s.planToAge ?? 95) - olderStart + 2;
  const planYears    = Math.max(1, (s.planToAge ?? 95) - jointFreedom);

  // Per-client mutable state
  const cs = c.map(x => ({
    age:            x.currentAge,
    accum:          x.superBalance,
    pension:        0,
    tbcUsed:        0,
    atFreedom:      false,
    freedomBalance: null,
    alive:          true,
    lifeExpectancy: x.lifeExpectancy ?? 87,
    gender:         x.gender ?? 'male',
  }));

  let nonSuper       = s.nonSuper ?? 0;
  let debtBal        = debt.balance ?? 0;
  let agedCareBal    = null;
  let survivorMode   = false;
  let bothAlive      = true;
  let drawdownStarted = false;
  let drawdownYear   = 0;
  let combinedBal    = 0;
  let pensionBal     = 0;  // pension phase portion within combinedBal (for min-drawdown tracking)
  let depletionAge   = null;
  let lastPositiveAge = null;
  let yearsFullyFunded = 0;
  let firstDDYear    = true;
  let retirementCombined = 0;
  let pensionStartAge = null;
  let lastPensionResult = null;
  const rows         = [];

  for (let t = 1; t <= totalYears; t++) {
    const chartAge = olderStart + t - 1;  // stable x-axis: older person's age at start of year
    const row = { t, chartAge, ages: [cs[0].age, cs[1].age], alive: [cs[0].alive, cs[1].alive] };

    // ── Debt ───────────────────────────────────────────────────────────────────
    if (debtBal > 0 && debt.annualPayment > 0) {
      const interest = debtBal * (debt.rate ?? 0.06);
      debtBal = Math.max(0, debtBal + interest - debt.annualPayment);
      row.debtBalance = debtBal;
    }

    // ── Per-client accumulation (only before drawdown starts) ─────────────────
    for (let i = 0; i < 2; i++) {
      const cli = c[i], st = cs[i];
      if (!st.alive) { row[`accum${i}`] = 0; row[`pension${i}`] = 0; continue; }

      if (!drawdownStarted && !st.atFreedom) {
        // Working phase
        const isPT   = st.age >= cli.ptAge;
        const base   = isPT ? cli.ptIncome : cli.ftIncome;
        const salary = base * Math.pow(1 + INFLATION, t - 1);
        row[`salary${i}`] = salary;

        const addCC = Math.min(cli.additionalConcessional ?? 0, SUPER.concessionalCap);
        const acc   = accumStep(st.accum, salary, s.sgcRate ?? 0.12, addCC, returnRate);
        st.accum    = acc.closing;
        // Grow any pension balance received via survivor transfer while still working
        if (st.pension > 0) {
          const p = pensionCompound(st.pension, returnRate);
          st.pension = p.closing;
        }

        // Downsizer: applied when client reaches their freedom age
        if (st.age >= cli.freedomAge && !st.atFreedom) {
          // Downsizer contribution before converting to pension
          if (cli.downsizer?.active && st.age >= 55) {
            const dsAmount = Math.min(cli.downsizer.amount ?? 0, SUPER.downsizer.maxPerPerson);
            st.accum += dsAmount;
          }
          const conv = convertToPension(st.accum, st.tbcUsed);
          st.pension  += conv.pensionAdded;
          st.accum     = conv.accumRemaining;
          st.tbcUsed   = conv.newTbcUsed;
          st.freedomBalance = st.pension + st.accum;
          st.atFreedom = true;
        }
      } else if (!drawdownStarted && st.atFreedom) {
        // Post-freedom pre-drawdown: grow both components
        if (st.pension > 0) {
          const p = pensionCompound(st.pension, returnRate);
          st.pension = p.closing;
        }
        if (st.accum > 0) {
          const a = accumCompound(st.accum, returnRate);
          st.accum = a.closing;
        }
      }
      row[`accum${i}`] = st.accum;
      row[`pension${i}`] = st.pension;
    }

    // ── Inheritance ────────────────────────────────────────────────────────────
    // Trigger based on calendar year (t), not cs[0].age — cs[0] may die before ageReceived
    const inhTriggerYear = inh.ageReceived - c[0].currentAge + 1;
    if (inh.amount > 0 && t === inhTriggerYear) {
      if (drawdownStarted) {
        combinedBal += inh.amount;
      } else if (inh.destination === 'super') {
        const toSuper  = Math.min(inh.amount, SUPER.nccAnnual);
        const toInvest = inh.amount - toSuper;
        const idx = cs[0].tbcUsed <= cs[1].tbcUsed ? 0 : 1;
        cs[idx].accum += toSuper;
        nonSuper      += toInvest;
      } else {
        nonSuper += inh.amount;
      }
    }

    // ── Survivor check ─────────────────────────────────────────────────────────
    for (let i = 0; i < 2; i++) {
      const st = cs[i];
      if (st.alive && st.age > st.lifeExpectancy && bothAlive) {
        st.alive     = false;
        bothAlive    = false;
        survivorMode = true;
        row.survivorEvent = true;

        if (!drawdownStarted) {
          // Transfer pre-retirement: move deceased's super to partner within TBC
          const partner      = cs[1 - i];
          const totalDeceased = st.pension + st.accum;
          const headroom      = Math.max(0, SUPER.tbc - partner.tbcUsed);
          const toPension     = Math.min(totalDeceased, headroom);
          partner.pension  += toPension;
          partner.tbcUsed  += toPension;
          nonSuper         += totalDeceased - toPension;
          st.pension = 0; st.accum = 0;
        }
        // During drawdown: combined pool already holds both balances — only flags change
      }
    }

    // ── Start drawdown when both at freedom ────────────────────────────────────
    const allAtFreedom = cs.every(st => !st.alive || st.atFreedom);
    if (allAtFreedom && !drawdownStarted) {
      pensionBal         = cs.reduce((sum, st) => sum + st.pension, 0);
      combinedBal        = pensionBal + cs.reduce((sum, st) => sum + st.accum, 0) + nonSuper;
      retirementCombined = combinedBal;
      drawdownStarted    = true;
      row.retirementStart = true;
    }

    // ── Drawdown ───────────────────────────────────────────────────────────────
    if (drawdownStarted) {
      drawdownYear++;
      const survivalFactor = survivorMode ? (surv.expenseFactor ?? 0.70) : 1.0;
      const desiredBase    = s.desiredIncome * survivalFactor;
      const desiredNominal = desiredBase * Math.pow(1 + INFLATION, drawdownYear - 1);

      // Sequencing shock
      if (applySequencing && firstDDYear) {
        combinedBal *= 0.75;
        pensionBal  *= 0.75;
        row.sequencingShock = true;
      }
      if (firstDDYear) firstDDYear = false;

      // Aged care reserve
      if (ac.active) {
        const oldestAlive = Math.max(...cs.filter(st => st.alive).map(st => st.age), 0);
        if (agedCareBal === null && oldestAlive >= ac.triggerAge) {
          const deduct = Math.min(ac.amount ?? 0, combinedBal);
          combinedBal  -= deduct;
          agedCareBal   = deduct;
          row.agedCareSetup = deduct;
        }
        if (agedCareBal !== null) {
          const r = ac.mode === 'rad' ? 0 : returnRate;
          agedCareBal *= (1 + r);
          row.agedCareBal = agedCareBal;
        }
      }

      // Age Pension
      let pensionIncome = 0;
      if (pen.include) {
        const aliveAges   = cs.filter(s => s.alive).map(s => s.age);
        const youngestAge = Math.min(...aliveAges);
        if (youngestAge >= (pen.pensionAge ?? 67)) {
          const penRes = calcPension({
            assets:          combinedBal,
            financialAssets: combinedBal,
            earnedIncome:    0,
            homeowner:       pen.homeowner ?? true,
            bothAlive,
          });
          pensionIncome = penRes.annualPension;
          lastPensionResult = penRes;
          if (pensionStartAge === null && pensionIncome > 0) pensionStartAge = youngestAge;
          row.pension = penRes;
        }
      }

      // Min drawdown enforcement
      const oldestAliveAge = Math.max(...cs.filter(s => s.alive).map(s => s.age));
      const minDraw = minDrawdownAmount(pensionBal, oldestAliveAge);
      const netDraw = Math.max(0, desiredNominal - pensionIncome);
      // Excess min draw above income needs is reinvested (stays in pool as non-super savings)
      const excessMinDraw = Math.max(0, minDraw - netDraw);
      const effectiveDraw = netDraw;  // pool only loses what's actually consumed for living
      row.minDrawdown = minDraw;
      row.excessMinDraw = excessMinDraw;

      const grossReturn = combinedBal * returnRate;
      const newBal      = combinedBal + grossReturn - effectiveDraw;

      row.dd              = drawdownYear;
      row.startBalance    = combinedBal;
      row.pensionIncome   = pensionIncome;
      row.drawdownDraw    = effectiveDraw;
      row.grossReturn     = grossReturn;
      row.endBalance      = Math.max(0, newBal);

      // Pension balance grows alongside combined
      pensionBal = Math.max(0, pensionBal * (1 + returnRate) - minDraw);

      // Depletion detection (balance < bequest target, or zero if no bequest)
      const bequestTarget = beq.active ? (beq.amount ?? 0) : 0;
      const depleted      = newBal < bequestTarget || newBal <= 0;
      const currentAge    = cs.find(s => s.alive)?.age ?? cs[0].age;
      if (!depleted) lastPositiveAge = currentAge;
      if (depleted && depletionAge === null) depletionAge = lastPositiveAge ?? currentAge;

      if (drawdownYear <= planYears && newBal >= desiredNominal * (1 + INFLATION)) yearsFullyFunded++;

      combinedBal   = Math.max(0, newBal);
      row.totalWealth = combinedBal + (agedCareBal ?? 0);
    } else {
      row.totalWealth = cs.reduce((sum, st) => sum + st.pension + st.accum, 0) + nonSuper;
    }

    rows.push(row);
    cs.forEach(st => { if (st.alive) st.age++; });
  }

  // Summary outputs
  const requiredLump     = requiredBalance(s.desiredIncome, returnRate, planYears);
  const retirementBalance = retirementCombined > 0 ? retirementCombined : (cs.reduce((sum, st) => sum + (st.freedomBalance ?? 0), 0) + (s.nonSuper ?? 0));

  return {
    rows,
    requiredLump,
    retirementBalance,
    gap: Math.max(0, requiredLump - retirementBalance),
    depletionAge,
    yearsFullyFunded,
    freedomAge: jointFreedom,
    returnRate,
    planToAge: s.planToAge ?? 95,
    desiredIncome: s.desiredIncome,
    pensionStartAge,
    lastPensionResult,
    safeEarn: safeEarnAmount(true),
    safeEarnSingle: safeEarnAmount(false),
  };
}
