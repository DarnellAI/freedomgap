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
  if (Math.abs(r - g) < 1e-9) return desiredIncome * years;
  return desiredIncome * (1 + r) * (1 - Math.pow((1 + g) / (1 + r), years)) / (r - g);
}

/**
 * Solve the extra annual saving required to close a funding gap.
 *
 * Answers the client question "what do I need to put away each year, starting
 * now, to get there?" — solved against the projection engine itself so the
 * answer is exactly consistent with the model rather than an approximation.
 *
 * Concessional (salary-sacrifice) capacity is used first because it is the most
 * tax-effective; once the $30k concessional cap is reached, the remainder is
 * solved as after-tax savings outside super.
 *
 * @param {object} params - Same state object as runProjection
 * @param {'sustain'|'selfFunded'} target
 *        'sustain'    — portfolio (with Age Pension) lasts to plan-to age
 *        'selfFunded' — reach the self-funded lump sum, ignoring Age Pension
 * @returns {object} { alreadyMet, years, concessional, afterTax, totalAnnual,
 *                     monthly, capReached, unreachable }
 */
export function solveSavingsGap(params, target = 'sustain') {
  const base = runProjection(params);
  const planTo  = base.planToAge;
  const sgcRate = params.shared.sgcRate ?? 0.12;

  // Years of saving available: from today until drawdown begins
  const years = Math.max(0, (base.drawdownStartAge ?? base.freedomAge) - base.youngerStart);

  const met = res => target === 'selfFunded'
    ? res.retirementBalance >= res.requiredLump - 1
    : (res.depletionAge == null || res.depletionAge >= planTo);

  const blank = { alreadyMet: true, years, concessional: 0, afterTax: 0, totalAnnual: 0, monthly: 0, capReached: false, unreachable: false };
  if (met(base)) return blank;
  if (years <= 0) return { ...blank, alreadyMet: false, unreachable: true };

  // Concessional headroom per client, on today's salary basis. A client who is
  // already retired (or earns nothing) cannot salary sacrifice.
  const heads = params.clients.map(cli => {
    if (cli.freedomAge <= cli.currentAge) return 0;
    const sal = cli.currentAge >= cli.ptAge ? cli.ptIncome : cli.ftIncome;
    if (sal <= 0) return 0;
    return Math.max(0, SUPER.concessionalCap - sal * sgcRate - (cli.additionalConcessional ?? 0));
  });
  const headTotal = heads[0] + heads[1];

  function trial(conc, after) {
    const p = JSON.parse(JSON.stringify(params));
    if (headTotal > 0 && conc > 0) {
      p.clients.forEach((cli, i) => {
        cli.additionalConcessional = (cli.additionalConcessional ?? 0) + conc * heads[i] / headTotal;
      });
    }
    p.shared.extraSavings = (p.shared.extraSavings ?? 0) + after;
    return runProjection(p);
  }
  // Bisect to the nearest dollar (tolerance-based — far fewer projections than
  // a fixed iteration count, which matters because this runs on every keystroke)
  function solve(lo, hi, build) {
    let guard = 0;
    while (hi - lo > 1 && guard++ < 40) {
      const mid = (lo + hi) / 2;
      if (met(build(mid))) hi = mid; else lo = mid;
    }
    return hi;
  }

  // 1. Try to close the gap with salary sacrifice alone
  if (headTotal > 0 && met(trial(headTotal, 0))) {
    const conc = solve(0, headTotal, x => trial(x, 0));
    return { alreadyMet: false, years, concessional: conc, afterTax: 0,
             totalAnnual: conc, monthly: conc / 12, capReached: false, unreachable: false };
  }

  // 2. Max out salary sacrifice, then solve the remainder as after-tax savings
  const conc = headTotal;
  let hi = 1000;
  while (hi < 5e6 && !met(trial(conc, hi))) hi *= 2;
  if (!met(trial(conc, hi))) {
    return { alreadyMet: false, years, concessional: conc, afterTax: 0,
             totalAnnual: conc, monthly: conc / 12, capReached: headTotal > 0, unreachable: true };
  }
  const after = solve(0, hi, x => trial(conc, x));
  return { alreadyMet: false, years, concessional: conc, afterTax: after,
           totalAnnual: conc + after, monthly: (conc + after) / 12,
           capReached: headTotal > 0, unreachable: false };
}

/**
 * Run a full year-by-year projection.
 *
 * Year conventions (all events at START of the projection year):
 *  - A client whose age has reached their freedom age is retired for that
 *    entire year — no salary, no SGC. Their super converts to pension phase
 *    (subject to TBC) at the start of the year.
 *  - A still-working partner's super merges into the retirement pool at
 *    pension access age (67) or their freedom age, whichever comes first;
 *    the merged balance then earns the pool return for the full year and
 *    their ongoing SGC flows into the pool net of contributions tax.
 *  - Income drawn is annuity-due: a full year of (inflated) desired income is
 *    withdrawn each drawdown year, offset by Age Pension and any net salary.
 *
 * @param {object} params   - Full state (clients, shared, debts, inheritances, pension, agedCare, survivor, bequest)
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
  const sgcRate      = s.sgcRate ?? 0.12;
  const extraSavings = s.extraSavings ?? 0;   // recurring after-tax savings p.a.
  const jointFreedom = Math.max(c[0].freedomAge, c[1].freedomAge);
  const youngerStartAge = Math.min(c[0].currentAge, c[1].currentAge);
  const totalYears   = (s.planToAge ?? 95) - youngerStartAge + 2;
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

  // Phased income lookup — phase income is in today's dollars
  function phaseIncomeAt(chartAge) {
    const phases = s.incomePhases;
    let base = s.desiredIncome ?? 0;
    if (phases && phases.length > 0) {
      for (const ph of phases) {
        base = ph.income ?? 0;
        if (ph.untilAge == null || chartAge < ph.untilAge) break;
      }
    }
    return base;
  }

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
  let retirementInflationFactor = 1;  // (1+infl)^years-from-today-to-retirement
  let pensionStartAge = null;
  let firstPensionResult = null;
  let lastPensionResult = null;
  const rows         = [];

  for (let t = 1; t <= totalYears; t++) {
    const chartAge = youngerStartAge + t - 1;  // stable x-axis: younger person's age at start of year
    const inflator = Math.pow(1 + INFLATION, t - 1);
    const row = { t, chartAge, ages: [cs[0].age, cs[1].age], alive: [cs[0].alive, cs[1].alive] };

    // Opening household wealth (before anything happens this year) — audit trail
    row.openingWealth = drawdownStarted
      ? combinedBal + cs.reduce((sum, st) => sum + st.accum + st.pension, 0) + (agedCareBal ?? 0)
      : cs.reduce((sum, st) => sum + st.accum + st.pension, 0) + nonSuper;

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

    // ── Start-of-year retirement conversions & drawdown-start decision ────────
    if (!drawdownStarted) {
      // A client whose age has reached their freedom age stops work NOW — before
      // any salary or growth is applied for this year. Super converts to pension
      // phase only from preservation age (60): an earlier retiree's super stays
      // in accumulation, compounding, until it becomes accessible.
      for (let i = 0; i < 2; i++) {
        const cli = c[i], st = cs[i];
        if (!st.alive || st.atFreedom) continue;
        if (st.working && st.age >= cli.freedomAge) st.working = false;
        if (!st.working && st.age >= SUPER.preservationAge) {
          if (cli.downsizer?.active && st.age >= 55) {
            const dsAmount = Math.min(cli.downsizer.amount ?? 0, SUPER.downsizer.maxPerPerson);
            st.accum += dsAmount;
            row.downsizerAdded = (row.downsizerAdded ?? 0) + dsAmount;
          }
          const conv = convertToPension(st.accum, st.tbcUsed);
          st.pension  += conv.pensionAdded;
          st.accum     = conv.accumRemaining;
          st.tbcUsed   = conv.newTbcUsed;
          st.freedomBalance = st.pension + st.accum;
          st.atFreedom = true;
        }
      }

      // Drawdown starts when any client is retired AND the household income
      // no longer covers desired spending + debt service (or everyone is retired).
      // "Retired" includes a pre-preservation-age retiree: their spending gap is
      // funded from accessible (non-super) money while super stays locked.
      const anyAtFreedom = cs.some(st => !st.alive || st.atFreedom || !st.working);
      const allAtFreedom = cs.every(st => !st.alive || st.atFreedom || !st.working);
      if (anyAtFreedom) {
        let workingCheck = 0;
        for (let i = 0; i < 2; i++) {
          const st = cs[i];
          if (!st.alive || st.atFreedom || !st.working) continue;
          const cli = c[i];
          const base = st.age >= cli.ptAge ? cli.ptIncome : cli.ftIncome;
          workingCheck += calcNetIncome(base * inflator);
        }
        const survFactorCheck = survivorMode ? (surv.expenseFactor ?? 0.70) : 1.0;
        const desiredCheck = phaseIncomeAt(chartAge) * survFactorCheck * inflator;
        if (allAtFreedom || workingCheck < desiredCheck + debtRepaymentThisYear) {
          // Build the retirement pool from balances as at the END of last year —
          // pool return is applied below in the drawdown block, so no growth is
          // double-counted in the transition year. ALL pension-phase money is
          // accessible and joins the pool (including a death-benefit pension
          // held by a still-working survivor); only a working client's
          // accumulation super stays separate until they merge.
          pensionBal  = cs.reduce((sum, st) => sum + st.pension, 0);
          combinedBal = pensionBal
                      + cs.reduce((sum, st) => sum + (st.atFreedom ? st.accum : 0), 0)
                      + nonSuper;
          nonSuper = 0;
          // Household retirement balance = the retiring partner's pool PLUS any
          // still-working partner's super (real wealth, just not yet in the pool).
          retirementCombined = combinedBal
                      + cs.reduce((sum, st) => sum + ((st.alive && !st.atFreedom) ? st.accum : 0), 0);
          retirementInflationFactor = inflator;
          for (const st of cs) {
            st.pension = 0;
            if (st.atFreedom) st.accum = 0;
          }
          drawdownStarted    = true;
          drawdownStartAge   = chartAge;
          row.retirementStart = true;
        }
      }
    }

    // ── Accumulation year (no drawdown yet) ───────────────────────────────────
    if (!drawdownStarted) {
      for (let i = 0; i < 2; i++) {
        const cli = c[i], st = cs[i];
        if (!st.alive) { row[`accum${i}`] = 0; row[`pension${i}`] = 0; continue; }

        if (!st.atFreedom && st.working) {
          // Working year
          const base   = st.age >= cli.ptAge ? cli.ptIncome : cli.ftIncome;
          const salary = base * inflator;
          row[`salary${i}`] = salary;

          const addCC = Math.min(cli.additionalConcessional ?? 0, SUPER.concessionalCap);
          const acc   = accumStep(st.accum, salary, sgcRate, addCC, returnRate);
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
            row.returnAccum = (row.returnAccum ?? 0) + p.grossReturn;
          }
        } else {
          // Retired (converted, or pre-preservation-age with super still in
          // accumulation) — grow both components
          if (st.pension > 0) {
            const p = pensionCompound(st.pension, returnRate);
            st.pension = p.closing;
            row.returnAccum = (row.returnAccum ?? 0) + p.grossReturn;
          }
          if (st.accum > 0) {
            const a = accumCompound(st.accum, returnRate);
            st.accum = a.closing;
            row.returnAccum = (row.returnAccum ?? 0) + a.grossReturn;
            row.taxAccum    = (row.taxAccum    ?? 0) + a.tax;
          }
        }
        row[`accum${i}`] = st.accum;
        row[`pension${i}`] = st.pension;
      }

      // Non-super savings earn the portfolio return, then service debt repayments.
      // Any repayment beyond available savings is met from salary cashflow.
      if (nonSuper > 0) {
        row.nonSuperGrowth = nonSuper * returnRate;
        nonSuper += row.nonSuperGrowth;
      }
      const debtFromSavings = Math.min(nonSuper, debtRepaymentThisYear);
      row.debtFromSavings = debtFromSavings;
      nonSuper -= debtFromSavings;

      // Recurring after-tax savings (added at year end, so growth starts next
      // year — the conservative convention). Used by the savings-gap solver.
      if (extraSavings > 0 && cs.some((st, i) => st.alive && st.working)) {
        nonSuper += extraSavings;
        row.extraSavings = extraSavings;
      }
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
        } else {
          // During drawdown the pool already holds merged balances; if the
          // deceased still had separate (working) super, it flows to the
          // survivor as a death benefit — roll it into the pool.
          const totalDeceased = st.pension + st.accum;
          if (totalDeceased > 0) {
            combinedBal += totalDeceased;
            st.pension = 0; st.accum = 0;
          }
        }
      }
    }

    // ── Drawdown ───────────────────────────────────────────────────────────────
    if (drawdownStarted) {
      drawdownYear++;
      row.dd = drawdownYear;

      // Sequencing shock — a −25% market fall at the start of the first
      // retirement year hits every invested balance, including a still-working
      // partner's separate super. Applied before merges and contributions so
      // the year's audit trail reconciles from the post-shock opening balance.
      if (applySequencing && firstDDYear) {
        let shockLoss = combinedBal * 0.25;
        combinedBal *= 0.75;
        pensionBal  *= 0.75;
        for (const st of cs) {
          if (!st.alive) continue;
          shockLoss  += (st.accum + st.pension) * 0.25;
          st.accum   *= 0.75;
          st.pension *= 0.75;
        }
        row.sequencingLoss  = shockLoss;
        row.sequencingShock = true;
      }
      if (firstDDYear) firstDDYear = false;

      row.startBalance = combinedBal; // pool opening balance (before merges/flows)

      // Super merges at pension access age (67) OR freedom age, whichever is first —
      // so depletion detection always uses total accessible household wealth.
      // Working income offset continues until freedom age, regardless of when super merged.
      let workingNetIncome   = 0;
      let workingGrossIncome = 0;
      const workingGrossList = [];
      let sgcNetPool         = 0;
      const pensionAccessAge = pen.pensionAge ?? 67;
      for (let i = 0; i < 2; i++) {
        const st  = cs[i];
        const cli = c[i];
        if (!st.alive) continue;

        // Start-of-year: reaching freedom age ends work for the whole year
        if (st.working && st.age >= cli.freedomAge) {
          st.working = false;
          row.partnerJoinsRetirement = true;
        }
        // Start-of-year: merge into pool at pension access age (67) or freedom
        // age, whichever first — but never before preservation age (60), when
        // super first becomes accessible. The merged balance earns the pool
        // return below — no accumulation-side growth is applied in the merge year.
        const mergeAge = Math.max(Math.min(cli.freedomAge, pensionAccessAge), SUPER.preservationAge);
        if (!st.atFreedom && st.age >= mergeAge) {
          if (cli.downsizer?.active && st.age >= 55) {
            const dsAmount = Math.min(cli.downsizer.amount ?? 0, SUPER.downsizer.maxPerPerson);
            st.accum += dsAmount;
            row.downsizerAdded = (row.downsizerAdded ?? 0) + dsAmount;
          }
          const conv   = convertToPension(st.accum, st.tbcUsed);
          // Any existing pension-phase balance (e.g. a death-benefit pension)
          // joins the pool along with the converted accumulation account.
          combinedBal += st.pension + conv.pensionAdded + conv.accumRemaining;
          pensionBal  += st.pension + conv.pensionAdded;
          st.tbcUsed   = conv.newTbcUsed;
          st.pension = 0;
          st.accum   = 0;
          st.atFreedom = true;
          row.partnerJoinsRetirement = true;
        }

        if (st.working) {
          const base   = st.age >= cli.ptAge ? cli.ptIncome : cli.ftIncome;
          const salary = base * inflator;
          row[`salary${i}`] = salary;
          const addCC = Math.min(cli.additionalConcessional ?? 0, SUPER.concessionalCap);

          if (!st.atFreedom) {
            // Separate super still accumulating (below 67 and below freedom age)
            const acc = accumStep(st.accum, salary, sgcRate, addCC, returnRate);
            st.accum  = acc.closing;
            row[`sgc${i}`]    = acc.contribGross;
            row[`return${i}`] = acc.grossReturn;
            row[`tax${i}`]    = acc.tax;
          } else {
            // Super already merged into the pool — SGC flows in net of
            // contributions tax; the pool return covers growth.
            const contribGross = Math.min(salary * sgcRate + addCC, SUPER.concessionalCap);
            const contribTax   = contribGross * SUPER.accumTaxRate;
            combinedBal       += contribGross - contribTax;
            sgcNetPool        += contribGross - contribTax;
            row[`sgc${i}`]     = contribGross;
            row[`tax${i}`]     = contribTax;
          }

          workingNetIncome   += calcNetIncome(salary);
          workingGrossIncome += salary;
          workingGrossList.push(salary);
        } else if (!st.atFreedom && st.accum > 0) {
          // Retired before preservation age — super stays in accumulation,
          // compounding (with 15% earnings tax) until it can merge at 60.
          const a = accumCompound(st.accum, returnRate);
          st.accum = a.closing;
          row[`return${i}`] = a.grossReturn;
          row[`tax${i}`]    = a.tax;
        }

        row[`accum${i}`]   = st.accum;
        row[`pension${i}`] = st.pension;
      }
      row.workingNetIncome   = workingNetIncome;
      row.workingGrossIncome = workingGrossIncome;
      row.sgcNetPool         = sgcNetPool;

      const survivalFactor = survivorMode ? (surv.expenseFactor ?? 0.70) : 1.0;
      const desiredBase    = phaseIncomeAt(chartAge) * survivalFactor;
      // Income is entered in today's dollars — inflate from today (t), not from
      // the start of drawdown, so the years before retirement are captured.
      const desiredNominal = desiredBase * inflator;

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
            earnedIncomes:   workingGrossList,
            homeowner:       pen.homeowner ?? true,
            bothAlive,
            // Pension rates & thresholds index from TODAY (t=1), keeping them on
            // the same nominal basis as the inflated desired income.
            pensionYear:     t - 1,
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

      // Pool return for the year — SGC contributions arrive mid-year on average,
      // so they earn half a year of return (same convention as accumStep).
      const grossReturn = (combinedBal - sgcNetPool / 2) * returnRate;
      const newBal      = combinedBal + grossReturn - effectiveDraw + surplusSaving;

      row.pensionIncome   = pensionIncome;
      row.desiredNominal  = desiredNominal;
      row.debtRepaymentYr = debtRepaymentThisYear;
      row.drawdownDraw    = effectiveDraw;
      row.grossReturn     = grossReturn;
      row.endBalance      = Math.max(0, newBal);

      // Pension balance grows alongside combined; cap prevents drift above total pool
      pensionBal = Math.min(Math.max(0, pensionBal * (1 + returnRate) - minDraw), combinedBal);

      // Depletion detection at the HOUSEHOLD level — a still-working partner's
      // super is real wealth, so an empty pool alone is not depletion.
      const bequestTarget = beq.active ? (beq.amount ?? 0) : 0;
      const householdBal  = newBal + stillWorkingSuper;
      const depleted      = householdBal < bequestTarget || householdBal <= 0;
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
  // Income is in today's dollars; inflate it to retirement start so the self-funded
  // target and the household balance at retirement are on the same nominal basis.
  const firstPhaseIncome = (s.incomePhases?.[0]?.income ?? s.desiredIncome ?? 0) * retirementInflationFactor;
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
    youngerStart: youngerStartAge,
    drawdownStartAge,
    initialHomeValue,
  };
}
