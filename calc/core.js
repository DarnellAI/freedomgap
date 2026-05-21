import { INFLATION, SUPER, RETURN_PROFILES } from '../data/parameters.js';
import { accumStep, accumCompound, pensionCompound, convertToPension, minDrawdownAmount, calcNetIncome } from './tax.js';
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
  const rawDebts = params.debts ?? (params.debt ? [{ name: 'Loan', balance: params.debt.balance ?? 0, rate: params.debt.rate ?? 0.06, repayment: params.debt.annualPayment ?? 0, frequency: 'annual' }] : []);
  function freqMult(f) { return { weekly: 52, fortnightly: 26, monthly: 12, annual: 1 }[f] ?? 12; }
  const debtState = rawDebts.filter(d => d.balance > 0).map(d => ({
    name: d.name || 'Debt',
    balance: d.balance,
    rate: d.rate ?? 0.06,
    annualRep: (d.repayment ?? 0) * freqMult(d.frequency ?? 'monthly'),
  }));
  const inhList = params.inheritances ?? (params.inheritance ? [params.inheritance] : []);
  const pen  = params.pension ?? { include: true, homeowner: true, pensionAge: 67 };
  const initialHomeValue = pen.homeValue ?? 0;
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
    working:        true,   // still earning salary; stops at freedomAge
    freedomBalance: null,
    alive:          true,
    lifeExpectancy: x.lifeExpectancy ?? 87,
    gender:         x.gender ?? 'male',
  }));

  let nonSuper       = s.nonSuper ?? 0;
  let debtRepaymentThisYear = 0;
  let agedCareBal    = null;
  let survivorMode   = false;
  let bothAlive      = true;
  let drawdownStarted = false;
  let drawdownYear   = 0;
  let drawdownStartAge = null;
  let combinedBal    = 0;
  let pensionBal     = 0;  // pension phase portion within combinedBal (for min-drawdown tracking)
  let depletionAge   = null;
  let lastPositiveAge = null;
  let yearsFullyFunded = 0;
  let firstDDYear    = true;
  let retirementCombined = 0;
  let pensionStartAge = null;
  let firstPensionResult = null;
  let lastPensionResult = null;
  const rows         = [];

  for (let t = 1; t <= totalYears; t++) {
    const chartAge = olderStart + t - 1;  // stable x-axis: older person's age at start of year
    const row = { t, chartAge, ages: [cs[0].age, cs[1].age], alive: [cs[0].alive, cs[1].alive] };

    // ── Debt ───────────────────────────────────────────────────────────────────
    debtRepaymentThisYear = 0;
    const debtDetails = [];
    for (const db of debtState) {
      if (db.balance <= 0) { debtDetails.push({ opening: 0, interest: 0, repayment: 0, closing: 0 }); continue; }
      const opening   = db.balance;
      const interest  = opening * db.rate;
      const totalOwed = opening + interest;
      const repayment = Math.min(db.annualRep, totalOwed);
      db.balance      = Math.max(0, totalOwed - repayment);
      debtRepaymentThisYear += repayment;
      debtDetails.push({ opening, interest, repayment, closing: db.balance });
    }
    row.debtBalances = debtState.map(db => db.balance);
    row.debtDetails  = debtDetails;
    row.totalDebt    = row.debtBalances.reduce((s, v) => s + v, 0);

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
        row.sgcTotal    = (row.sgcTotal    ?? 0) + acc.contribGross;
        row.returnAccum = (row.returnAccum ?? 0) + acc.grossReturn;
        row.taxAccum    = (row.taxAccum    ?? 0) + acc.tax;
        row[`sgc${i}`]    = acc.contribGross;
        row[`return${i}`] = acc.grossReturn;
        row[`tax${i}`]    = acc.tax;
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
          st.working   = false;
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

    // ── Inheritances ───────────────────────────────────────────────────────────
    let rowInhAmount = 0, rowInhDebtPayoff = 0, rowInhToPool = 0;
    for (const inh of inhList) {
      if (!inh.amount || inh.amount <= 0) continue;
      const inhTriggerYear = (inh.ageReceived ?? 75) - c[0].currentAge + 1;
      if (t !== inhTriggerYear) continue;
      let inhRemaining = inh.amount;
      let inhDebtPayoff = 0;
      if (inh.applyToDebtFirst) {
        const sorted = [...debtState].sort((a, b) => b.rate - a.rate);
        for (const db of sorted) {
          if (db.balance <= 0 || inhRemaining <= 0) continue;
          const payoff = Math.min(inhRemaining, db.balance);
          db.balance   -= payoff;
          inhRemaining -= payoff;
          inhDebtPayoff += payoff;
        }
        row.debtBalances = debtState.map(db => db.balance);
        row.totalDebt    = row.debtBalances.reduce((s, v) => s + v, 0);
      }
      rowInhAmount     += inh.amount;
      rowInhDebtPayoff += inhDebtPayoff;
      rowInhToPool     += inhRemaining;
      if (inhRemaining > 0) {
        if (drawdownStarted) {
          combinedBal += inhRemaining;
        } else if (inh.destination === 'super') {
          const toSuper  = Math.min(inhRemaining, SUPER.nccAnnual);
          const toInvest = inhRemaining - toSuper;
          const inhIdx = cs[0].tbcUsed <= cs[1].tbcUsed ? 0 : 1;
          cs[inhIdx].accum += toSuper;
          nonSuper         += toInvest;
        } else {
          nonSuper += inhRemaining;
        }
      }
    }
    if (rowInhAmount > 0) {
      row.inheritanceAmount     = rowInhAmount;
      row.inheritanceDebtPayoff = rowInhDebtPayoff;
      row.inheritanceToPool     = rowInhToPool;
    }

    // ── Survivor check ─────────────────────────────────────────────────────────
    for (let i = 0; i < 2; i++) {
      const st = cs[i];
      if (st.alive && st.age >= st.lifeExpectancy && bothAlive) {
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

    // ── Start drawdown when any client reaches freedom AND income gap exists ───
    const anyAtFreedom = cs.some(st => !st.alive || st.atFreedom);
    const allAtFreedom = cs.every(st => !st.alive || st.atFreedom);
    if (anyAtFreedom && !drawdownStarted) {
      // Working net income from still-working clients
      let workingCheck = 0;
      for (let i = 0; i < 2; i++) {
        const st = cs[i];
        if (!st.alive || st.atFreedom) continue;
        const cli = c[i];
        const base = st.age >= cli.ptAge ? cli.ptIncome : cli.ftIncome;
        workingCheck += calcNetIncome(base * Math.pow(1 + INFLATION, t - 1));
      }
      // Desired income in nominal terms at this year
      let phaseBaseCheck = s.desiredIncome ?? 0;
      const phasesCheck  = s.incomePhases;
      if (phasesCheck && phasesCheck.length > 0) {
        for (const ph of phasesCheck) {
          phaseBaseCheck = ph.income ?? 0;
          if (ph.untilAge == null || chartAge < ph.untilAge) break;
        }
      }
      const desiredCheck = phaseBaseCheck * Math.pow(1 + INFLATION, t - 1);
      if (allAtFreedom || workingCheck < desiredCheck + debtRepaymentThisYear) {
        pensionBal  = cs.reduce((sum, st) => sum + ((!st.alive || st.atFreedom) ? st.pension : 0), 0);
        combinedBal = pensionBal
                    + cs.reduce((sum, st) => sum + ((!st.alive || st.atFreedom) ? st.accum : 0), 0)
                    + nonSuper;
        retirementCombined = combinedBal;
        drawdownStarted    = true;
        drawdownStartAge   = chartAge;
        row.retirementStart = true;
      }
    }

    // Debt repayments during accumulation reduce non-super savings.
    // In retirement they are included in the drawdown below.
    if (!drawdownStarted) {
      nonSuper = Math.max(0, nonSuper - debtRepaymentThisYear);
    }

    // ── Drawdown ───────────────────────────────────────────────────────────────
    if (drawdownStarted) {
      drawdownYear++;
      row.startBalance = combinedBal; // opening balance before any intra-year changes

      // Super merges at pension access age (67) OR freedom age, whichever is first —
      // so depletion detection always uses total accessible household wealth.
      // Working income offset continues until freedom age, regardless of when super merged.
      let workingNetIncome  = 0;
      let workingGrossIncome = 0;
      const pensionAccessAge = pen.pensionAge ?? 67;
      for (let i = 0; i < 2; i++) {
        const st  = cs[i];
        const cli = c[i];
        if (!st.alive) continue;
        if (st.atFreedom && !st.working) continue; // fully retired, skip

        const base   = st.age >= cli.ptAge ? cli.ptIncome : cli.ftIncome;
        const salary = base * Math.pow(1 + INFLATION, t - 1);

        if (!st.atFreedom) {
          // Super not yet in pool — accumulate separately (skip in retirementStart year)
          if (!row.retirementStart) {
            row[`salary${i}`] = salary;
            const addCC = Math.min(cli.additionalConcessional ?? 0, SUPER.concessionalCap);
            const acc   = accumStep(st.accum, salary, s.sgcRate ?? 0.12, addCC, returnRate);
            st.accum    = acc.closing;
            row[`sgc${i}`]    = acc.contribGross;
            row[`return${i}`] = acc.grossReturn;
            row[`tax${i}`]    = acc.tax;
          }
          // Merge into pool at pension access age (67) or freedom age, whichever first
          if (st.age >= Math.min(cli.freedomAge, pensionAccessAge)) {
            if (cli.downsizer?.active && st.age >= 55) {
              st.accum += Math.min(cli.downsizer.amount ?? 0, SUPER.downsizer.maxPerPerson);
            }
            const conv  = convertToPension(st.accum, st.tbcUsed);
            st.pension  = conv.pensionAdded;
            st.accum    = conv.accumRemaining;
            st.tbcUsed  = conv.newTbcUsed;
            st.atFreedom = true;
            combinedBal += st.pension + st.accum;
            pensionBal  += st.pension;
            st.pension = 0;
            st.accum   = 0;
            row.partnerJoinsRetirement = true;
          }
        } else {
          // Super already in pool (merged at 67 before freedom age) — still earning.
          // SGC goes directly into pool as net contribution; return flows with pool.
          if (!row.retirementStart) {
            row[`salary${i}`] = salary;
            const addCC        = Math.min(cli.additionalConcessional ?? 0, SUPER.concessionalCap);
            const contribGross = Math.min(salary * (s.sgcRate ?? 0.12) + addCC, SUPER.concessionalCap);
            const contribTax   = contribGross * SUPER.accumTaxRate;
            combinedBal       += contribGross - contribTax;
            row[`sgc${i}`]     = contribGross;
            row[`tax${i}`]     = contribTax;
          }
        }

        // Income offset continues until freedom age
        if (st.working) {
          workingNetIncome   += calcNetIncome(salary);
          workingGrossIncome += salary;
          if (st.age >= cli.freedomAge) {
            st.working = false;
            if (!row.partnerJoinsRetirement) row.partnerJoinsRetirement = true;
          }
        }

        row[`accum${i}`]   = st.accum;
        row[`pension${i}`] = st.pension;
      }
      row.workingNetIncome   = workingNetIncome;
      row.workingGrossIncome = workingGrossIncome;

      const survivalFactor = survivorMode ? (surv.expenseFactor ?? 0.70) : 1.0;
      // Phased income: look up which phase applies at this age (today's dollars)
      const phases = s.incomePhases;
      let phaseBase = s.desiredIncome ?? 0;
      if (phases && phases.length > 0) {
        for (const ph of phases) {
          phaseBase = ph.income ?? 0;
          if (ph.untilAge == null || chartAge < ph.untilAge) break;
        }
      }
      const desiredBase    = phaseBase * survivalFactor;
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

      // Age Pension — working partner's super not yet in pool (below 67) is still assessable
      const stillWorkingSuper = cs.reduce(
        (sum, st) => (!st.alive || st.atFreedom) ? sum : sum + st.accum + st.pension, 0
      );
      const pensionTotalAssets = combinedBal + stillWorkingSuper;
      row.pensionTotalAssets = pensionTotalAssets;
      row.pensionBothAlive   = bothAlive;
      let pensionIncome = 0;
      if (pen.include) {
        const aliveAges   = cs.filter(s => s.alive).map(s => s.age);
        const youngestAge = Math.min(...aliveAges);
        if (youngestAge >= (pen.pensionAge ?? 67)) {
          const penRes = calcPension({
            assets:          pensionTotalAssets,
            financialAssets: pensionTotalAssets,
            earnedIncome:    workingGrossIncome,
            homeowner:       pen.homeowner ?? true,
            bothAlive,
            pensionYear:     drawdownYear - 1,
          });
          pensionIncome = penRes.annualPension;
          lastPensionResult = penRes;
          if (pensionStartAge === null && pensionIncome > 0) {
            pensionStartAge    = youngestAge;
            firstPensionResult = penRes;
          }
          row.pension = penRes;
        }
      }

      // Min drawdown enforcement
      const oldestAliveAge = Math.max(...cs.filter(s => s.alive).map(s => s.age));
      const minDraw = minDrawdownAmount(pensionBal, oldestAliveAge);
      // Net portfolio flow: inflows offset outflows; surplus is saved back into the pool
      const totalInflow   = pensionIncome + workingNetIncome;
      const totalOutflow  = desiredNominal + debtRepaymentThisYear;
      const netDraw       = Math.max(0, totalOutflow - totalInflow);
      const surplusSaving = Math.max(0, totalInflow - totalOutflow);
      const excessMinDraw = Math.max(0, minDraw - netDraw);
      const effectiveDraw = netDraw;
      row.minDrawdown   = minDraw;
      row.excessMinDraw = excessMinDraw;
      row.surplusSaving = surplusSaving;

      const grossReturn = combinedBal * returnRate;
      const newBal      = combinedBal + grossReturn - effectiveDraw + surplusSaving;

      row.dd              = drawdownYear;
      row.pensionIncome   = pensionIncome;
      row.desiredNominal  = desiredNominal;
      row.debtRepaymentYr = debtRepaymentThisYear;
      row.drawdownDraw    = effectiveDraw;
      row.grossReturn     = grossReturn;
      row.endBalance      = Math.max(0, newBal);

      // Pension balance grows alongside combined; cap prevents drift above total pool
      pensionBal = Math.min(Math.max(0, pensionBal * (1 + returnRate) - minDraw), combinedBal);

      // Depletion detection (balance < bequest target, or zero if no bequest)
      const bequestTarget = beq.active ? (beq.amount ?? 0) : 0;
      const depleted      = newBal < bequestTarget || newBal <= 0;
      if (!depleted) lastPositiveAge = chartAge;
      if (depleted && depletionAge === null) depletionAge = lastPositiveAge ?? chartAge;

      if (drawdownYear <= planYears && newBal >= desiredNominal * (1 + INFLATION)) yearsFullyFunded++;

      combinedBal   = Math.max(0, newBal);
      row.stillWorkingSuper = stillWorkingSuper;
      row.totalWealth = combinedBal + stillWorkingSuper + (agedCareBal ?? 0);
    } else {
      row.totalWealth = cs.reduce((sum, st) => sum + st.pension + st.accum, 0) + nonSuper;
    }

    row.homeValue = initialHomeValue > 0 ? Math.round(initialHomeValue * Math.pow(1.03, t - 1)) : 0;
    rows.push(row);
    cs.forEach(st => { if (st.alive) st.age++; });
  }

  // Summary outputs — use first phase income for required lump (conservative: assumes phase-1 spending for life)
  const firstPhaseIncome = s.incomePhases?.[0]?.income ?? s.desiredIncome ?? 0;
  const requiredLump     = requiredBalance(firstPhaseIncome, returnRate, planYears);
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
    desiredIncome: firstPhaseIncome,
    debtNames: debtState.map(db => db.name),
    pensionStartAge,
    firstPensionResult,
    lastPensionResult,
    safeEarn: safeEarnAmount(true),
    safeEarnSingle: safeEarnAmount(false),
    clientStartAges: [c[0].currentAge, c[1].currentAge],
    youngerStart: olderStart,
    drawdownStartAge,
    initialHomeValue,
  };
}
