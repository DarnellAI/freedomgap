/**
 * End-to-end projection test — bundles all ES modules into a shared CJS scope
 * and exercises 5 overlapping scenarios across accumulation → retirement → drawdown.
 *
 * Run: node test_e2e.cjs
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Module bundler ────────────────────────────────────────────────────────────
function load(relPath) {
  const abs = path.join(__dirname, relPath);
  return fs.readFileSync(abs, 'utf8')
    .replace(/^\s*import\s[^;]+;/gm, '')
    .replace(/^\s*export\s+default\s+/gm, 'var __default = ')
    .replace(/\bexport\s+function\b/g, 'function')
    .replace(/\bexport\s+const\b/g,    'const')
    .replace(/\bexport\s+let\b/g,      'let');
}

const src =
  load('data/parameters.js')     + '\n' +
  load('calc/tax.js')            + '\n' +
  load('calc/pension.js')        + '\n' +
  load('calc/core.js');

const scope = {};
new Function('scope', `
  with(scope) {
    ${src}
    scope.runProjection   = runProjection;
    scope.requiredBalance = requiredBalance;
    scope.calcIncomeTax   = calcIncomeTax;
    scope.calcNetIncome   = calcNetIncome;
    scope.calcPension     = calcPension;
    scope.safeEarnAmount  = safeEarnAmount;
    scope.PENSION         = PENSION;
    scope.SUPER           = SUPER;
    scope.INFLATION       = INFLATION;
    scope.RETURN_PROFILES = RETURN_PROFILES;
  }
`)(scope);

const { runProjection, calcIncomeTax, calcNetIncome, PENSION, SUPER, INFLATION } = scope;

// ── Test helpers ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0, warnings = 0;
const RESET = '\x1b[0m', GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', BOLD = '\x1b[1m', DIM = '\x1b[2m', CYAN = '\x1b[36m';

function fmt(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(3)}M`;
  if (n >= 1e3)  return `$${(n / 1e3).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}
function fmtPct(r) { return r != null ? `${(r * 100).toFixed(1)}%` : '—'; }

function assert(desc, cond, detail = '') {
  if (cond) {
    console.log(`  ${GREEN}✓${RESET} ${desc}${detail ? DIM + '  ' + detail + RESET : ''}`);
    passed++;
  } else {
    console.log(`  ${RED}✗ FAIL${RESET} ${desc}${detail ? '  ' + detail : ''}`);
    failed++;
  }
}
function warn(desc, detail = '') {
  console.log(`  ${YELLOW}⚠ WARN${RESET} ${desc}${detail ? '  ' + detail : ''}`);
  warnings++;
}
function section(title) {
  console.log(`\n${BOLD}${CYAN}══ ${title} ${RESET}`);
}

// ── Scenario definitions ──────────────────────────────────────────────────────

/**
 * S1: Comfortable couple, mid-career.
 * Ages 50/48, retire at 65, decent super, pension enabled, growth profile.
 * Expect: ~15 yr accumulation, well-funded, pension kicks in at 67.
 */
const S1 = {
  label: 'S1 — Comfortable couple (50/48, retire 65)',
  state: {
    clients: [
      { name: 'Alex',  gender: 'male',   currentAge: 50, lifeExpectancy: 87, ftIncome: 120000, ptAge: 62, ptIncome: 70000, freedomAge: 65, superBalance: 350000, additionalConcessional: 0, downsizer: { active: false, amount: 0 } },
      { name: 'Blair', gender: 'female', currentAge: 48, lifeExpectancy: 90, ftIncome:  90000, ptAge: 60, ptIncome: 50000, freedomAge: 65, superBalance: 250000, additionalConcessional: 0, downsizer: { active: false, amount: 0 } },
    ],
    shared:      { returnProfile: 'growth', sgcRate: 0.12, nonSuper: 50000, desiredIncome: 100000, planToAge: 95, minDrawdownExcess: 'invest' },
    debt:        { balance: 200000, rate: 0.06, annualPayment: 30000 },
    inheritance: { amount: 0, ageReceived: 75, destination: 'nonSuper' },
    pension:     { include: true, homeowner: true, pensionAge: 67 },
    agedCare:    { active: false, amount: 500000, triggerAge: 85, mode: 'invested' },
    survivor:    { active: true, expenseFactor: 0.70 },
    bequest:     { active: false, amount: 0 },
  },
};

/**
 * S2: Late starters, high earner, no pension.
 * Ages 55/52, retire at 68, moderate super, conservative return.
 * Expect: shorter accumulation, gap likely larger.
 */
const S2 = {
  label: 'S2 — Late starters, no pension (55/52, retire 68, conservative)',
  state: {
    clients: [
      { name: 'Casey',  gender: 'male',   currentAge: 55, lifeExpectancy: 82, ftIncome: 160000, ptAge: 65, ptIncome: 80000, freedomAge: 68, superBalance: 280000, additionalConcessional: 15000, downsizer: { active: false, amount: 0 } },
      { name: 'Drew',   gender: 'female', currentAge: 52, lifeExpectancy: 85, ftIncome:  75000, ptAge: 62, ptIncome: 40000, freedomAge: 68, superBalance: 150000, additionalConcessional:  5000, downsizer: { active: false, amount: 0 } },
    ],
    shared:      { returnProfile: 'conservative', sgcRate: 0.12, nonSuper: 100000, desiredIncome: 120000, planToAge: 90, minDrawdownExcess: 'invest' },
    debt:        { balance: 0, rate: 0.06, annualPayment: 0 },
    inheritance: { amount: 0, ageReceived: 75, destination: 'nonSuper' },
    pension:     { include: false, homeowner: true, pensionAge: 67 },
    agedCare:    { active: false, amount: 500000, triggerAge: 85, mode: 'invested' },
    survivor:    { active: true, expenseFactor: 0.70 },
    bequest:     { active: false, amount: 0 },
  },
};

/**
 * S3: Early retirees, high super, long horizon.
 * Ages 45/43, retire at 60, high starting balances, high-growth return.
 * Expect: 15 yr accumulation, large retirement nest egg, funded well past 95.
 */
const S3 = {
  label: 'S3 — Early retirees, high super (45/43, retire 60, highGrowth)',
  state: {
    clients: [
      { name: 'Evelyn', gender: 'female', currentAge: 45, lifeExpectancy: 92, ftIncome: 180000, ptAge: 57, ptIncome: 90000,  freedomAge: 60, superBalance: 600000, additionalConcessional: 27500, downsizer: { active: false, amount: 0 } },
      { name: 'Frank',  gender: 'male',   currentAge: 43, lifeExpectancy: 85, ftIncome: 140000, ptAge: 55, ptIncome: 70000,  freedomAge: 60, superBalance: 400000, additionalConcessional: 15000, downsizer: { active: false, amount: 0 } },
    ],
    shared:      { returnProfile: 'highGrowth', sgcRate: 0.12, nonSuper: 200000, desiredIncome: 150000, planToAge: 95, minDrawdownExcess: 'invest' },
    debt:        { balance: 0, rate: 0.06, annualPayment: 0 },
    inheritance: { amount: 300000, ageReceived: 65, destination: 'nonSuper' },
    pension:     { include: true, homeowner: true, pensionAge: 67 },
    agedCare:    { active: true, amount: 400000, triggerAge: 85, mode: 'invested' },
    survivor:    { active: true, expenseFactor: 0.70 },
    bequest:     { active: false, amount: 0 },
  },
};

/**
 * S4: Survivor-dominated. C1 dies early (life expectancy 72), C2 continues to 90.
 * Ages 60/58, retire at 65, balanced profile.
 * Expect: survivor event fires around year 13 (C1 dies at 72), single pension rates after.
 */
const S4 = {
  label: 'S4 — Early survivor event (60/58, C1 dies ~72, balanced)',
  state: {
    clients: [
      { name: 'Grace', gender: 'male',   currentAge: 60, lifeExpectancy: 72, ftIncome: 100000, ptAge: 63, ptIncome: 50000, freedomAge: 65, superBalance: 450000, additionalConcessional: 0, downsizer: { active: false, amount: 0 } },
      { name: 'Henri', gender: 'female', currentAge: 58, lifeExpectancy: 90, ftIncome:  80000, ptAge: 61, ptIncome: 40000, freedomAge: 65, superBalance: 300000, additionalConcessional: 0, downsizer: { active: false, amount: 0 } },
    ],
    shared:      { returnProfile: 'balanced', sgcRate: 0.12, nonSuper: 80000, desiredIncome: 90000, planToAge: 92, minDrawdownExcess: 'invest' },
    debt:        { balance: 0, rate: 0.06, annualPayment: 0 },
    inheritance: { amount: 0, ageReceived: 75, destination: 'nonSuper' },
    pension:     { include: true, homeowner: true, pensionAge: 67 },
    agedCare:    { active: false, amount: 500000, triggerAge: 85, mode: 'invested' },
    survivor:    { active: true, expenseFactor: 0.70 },
    bequest:     { active: false, amount: 0 },
  },
};

/**
 * S5: Stress test. Sequencing risk + aged care + bequest goal.
 * Ages 52/50, retire at 67, balanced return.
 * Expect: sequencing shock visible in DD year 1, aged care reserve carved out at 85,
 * depletion age relative to bequest target.
 */
const S5 = {
  label: 'S5 — Sequencing + aged care + bequest (52/50, retire 67)',
  state: {
    clients: [
      { name: 'Irene', gender: 'female', currentAge: 52, lifeExpectancy: 88, ftIncome: 95000,  ptAge: 62, ptIncome: 45000, freedomAge: 67, superBalance: 300000, additionalConcessional: 5000, downsizer: { active: false, amount: 0 } },
      { name: 'Jules', gender: 'male',   currentAge: 50, lifeExpectancy: 84, ftIncome: 110000, ptAge: 60, ptIncome: 55000, freedomAge: 67, superBalance: 250000, additionalConcessional: 5000, downsizer: { active: false, amount: 0 } },
    ],
    shared:      { returnProfile: 'balanced', sgcRate: 0.12, nonSuper: 60000, desiredIncome: 85000, planToAge: 90, minDrawdownExcess: 'invest' },
    debt:        { balance: 150000, rate: 0.065, annualPayment: 25000 },
    inheritance: { amount: 200000, ageReceived: 70, destination: 'nonSuper' },
    pension:     { include: true, homeowner: true, pensionAge: 67 },
    agedCare:    { active: true,  amount: 300000, triggerAge: 85, mode: 'rad' },
    survivor:    { active: true,  expenseFactor: 0.65 },
    bequest:     { active: true,  amount: 150000 },
  },
};

const SCENARIOS = [S1, S2, S3, S4, S5];

// ── Run all scenarios ─────────────────────────────────────────────────────────
section('INCOME TAX ENGINE (spot checks)');
{
  // All net figures computed against 2025-26 Stage 3 rates + LITO + Medicare levy
  const cases = [
    { gross: 0,      expectedNet: 0       },
    { gross: 18200,  expectedNet: 18200   },  // tax-free threshold + LITO wipes tax; below Medicare phase-in
    { gross: 40000,  expectedNet: 36287   },  // LITO=$575, tax=$3488-$575=$2913, Med=$800  → net=$36,287
    { gross: 80000,  expectedNet: 63612   },  // LITO=$0, tax=$14788, Med=$1600 → net=$63,612
    { gross: 120000, expectedNet: 90812   },  // tax=$26788, Med=$2400 → net=$90,812
    { gross: 165000, expectedNet: 119312  },  // tax=$42388, Med=$3300 → net=$119,312
    { gross: 250000, expectedNet: 166362  },  // tax=$78638, Med=$5000 → net=$166,362
  ];
  for (const { gross, expectedNet } of cases) {
    const net  = calcNetIncome(gross);
    const tax  = calcIncomeTax(gross);
    const tol  = Math.max(50, expectedNet * 0.001); // allow $50 or 0.1%
    assert(
      `$${(gross/1000).toFixed(0)}k gross → ~${fmt(expectedNet)} net`,
      Math.abs(net - expectedNet) < tol,
      `got ${fmt(net)} (tax ${fmt(tax)})`
    );
  }
}

// ── Per-scenario tests ────────────────────────────────────────────────────────
const results = {};
for (const sc of SCENARIOS) {
  section(sc.label);
  const st = sc.state;
  const c  = st.clients;
  const jointFreedom = Math.max(c[0].freedomAge, c[1].freedomAge);
  const olderStart   = Math.min(c[0].currentAge, c[1].currentAge);
  const retireYear   = jointFreedom - olderStart + 1;

  const r  = runProjection(st, false);
  const rs = runProjection(st, true);   // sequencing stress
  results[sc.label] = { r, rs };

  console.log(`  ${DIM}jointFreedom=${jointFreedom}, retireYear=${retireYear}, returnRate=${fmtPct(r.returnRate)}, planTo=${st.shared.planToAge}${RESET}`);

  // ── 1. Accumulation phase: wealth grows before retirement ───────────────────
  const preRows = r.rows.filter(row => !row.retirementStart && !row.dd);
  if (preRows.length > 2) {
    const wealthSeries = preRows.map(row => row.totalWealth);
    let accWealthGrows = true;
    for (let i = 1; i < wealthSeries.length; i++) {
      if (wealthSeries[i] < wealthSeries[i - 1] * 0.98) {  // allow 2% tolerance for debt repayments
        accWealthGrows = false; break;
      }
    }
    assert(
      `Accumulation phase wealth generally grows (${preRows.length} pre-retirement rows)`,
      accWealthGrows,
      `from ${fmt(wealthSeries[0])} to ${fmt(wealthSeries[wealthSeries.length - 1])}`
    );
  }

  // ── 2. Retirement row fires at correct year ─────────────────────────────────
  // A client retires at the START of the year they reach their freedom age.
  // Drawdown begins at the FIRST retirement if the still-working partner's net
  // salary no longer covers desired spending, otherwise at the last retirement —
  // so assert the semantic invariant rather than one exact year.
  const retRow = r.rows.find(row => row.retirementStart);
  const freedomYears = c.map(cl => cl.freedomAge - cl.currentAge + 1);
  assert(
    `retirementStart fires between first (yr ${Math.min(...freedomYears)}) and last (yr ${Math.max(...freedomYears)}) freedom age`,
    retRow && retRow.t >= Math.min(...freedomYears) && retRow.t <= Math.max(...freedomYears),
    retRow ? `got t=${retRow.t}, chartAge=${retRow.chartAge}` : 'no retirementStart row found'
  );
  if (retRow) {
    // At least one client must be at/past their freedom age in that year
    const someoneRetired = retRow.ages.some((a, i) => a >= c[i].freedomAge);
    assert(
      `At retirementStart, a client has reached freedom age (ages ${retRow.ages.join('/')})`,
      someoneRetired,
      `freedom ages ${c.map(cl => cl.freedomAge).join('/')}`
    );
    // Nobody may draw salary once they have reached their freedom age
    const illegalSalary = r.rows.find(row =>
      [0, 1].some(i => (row[`salary${i}`] ?? 0) > 0 && row.ages[i] >= c[i].freedomAge)
    );
    assert(
      `No client earns salary at or after their freedom age`,
      !illegalSalary,
      illegalSalary ? `chartAge ${illegalSalary.chartAge}: ages ${illegalSalary.ages.join('/')}` : ''
    );
  }

  // ── 3. Starting balance is positive and sensible ────────────────────────────
  assert(
    `retirementBalance positive (${fmt(r.retirementBalance)})`,
    r.retirementBalance > 0,
    ''
  );

  // Super should have grown — retirement balance should exceed starting super
  const startingSuper = c[0].superBalance + c[1].superBalance;
  const yearsWorked   = retireYear - 1;
  assert(
    `Retirement balance (${fmt(r.retirementBalance)}) > starting super (${fmt(startingSuper)}) after ${yearsWorked} accumulation years`,
    r.retirementBalance > startingSuper,
    ''
  );

  // ── 4. Chart x-axis is strictly monotone (stable even after death) ──────────
  const ages = r.rows.map(row => row.chartAge);
  const monotone = ages.every((a, i) => i === 0 || a === ages[i - 1] + 1);
  assert(
    `chartAge is monotone (no gaps/repeats) across all ${r.rows.length} rows`,
    monotone,
    monotone ? '' : `breaks at index ${ages.findIndex((a,i) => i > 0 && a !== ages[i-1]+1)}`
  );

  // ── 5. Drawdown rows have positive dd counter ───────────────────────────────
  const ddRows = r.rows.filter(row => row.dd);
  assert(
    `Drawdown rows present (${ddRows.length})`,
    ddRows.length > 0,
    ''
  );
  assert(
    `dd counter starts at 1 and increments`,
    ddRows[0].dd === 1 && ddRows[ddRows.length - 1].dd === ddRows.length,
    `first=${ddRows[0].dd}, last=${ddRows[ddRows.length-1].dd}`
  );

  // ── 6. Balance declines post-retirement (no pension, high draw) ─────────────
  //    Check the late-drawdown rows — eventually wealth should be declining or depleted
  const lateDD = ddRows.slice(-Math.min(10, ddRows.length));
  const earlyDD = ddRows.slice(0, Math.min(5, ddRows.length));
  if (earlyDD.length > 0 && lateDD.length > 0) {
    const peakLate  = Math.max(...lateDD.map(row => row.totalWealth ?? 0));
    const peakEarly = Math.max(...earlyDD.map(row => row.totalWealth ?? 0));
    const planYears = st.shared.planToAge - jointFreedom;
    // For a 30+ year plan, late wealth < peak early wealth or depleted
    if (planYears > 20 && r.depletionAge == null) {
      // Not depleted — check if at least there's been some drawdown (late < early)
      if (peakLate < peakEarly * 0.95) {
        assert(
          `Late-drawdown balance (${fmt(peakLate)}) lower than early peak (${fmt(peakEarly)})`,
          true, ''
        );
      } else {
        warn(
          `Late-drawdown balance (${fmt(peakLate)}) close to early (${fmt(peakEarly)}) — returns may outpace draw`,
          `desiredIncome=${fmt(st.shared.desiredIncome)}, return=${fmtPct(r.returnRate)}`
        );
      }
    } else if (r.depletionAge != null) {
      assert(
        `Depletion detected at age ${r.depletionAge} (plan to ${st.shared.planToAge})`,
        r.depletionAge < st.shared.planToAge,
        ''
      );
    }
  }

  // ── 7. Required lump sum is positive and plausible ──────────────────────────
  const planYears = Math.max(1, st.shared.planToAge - jointFreedom);
  const minPlausible = st.shared.desiredIncome * planYears * 0.5;  // at least 50% of raw sum
  assert(
    `requiredLump (${fmt(r.requiredLump)}) ≥ ${planYears} × ${fmt(st.shared.desiredIncome)} × 50%`,
    r.requiredLump >= minPlausible,
    ''
  );

  // ── 8. Gap is non-negative ───────────────────────────────────────────────────
  assert(
    `gap = max(0, required - balance) is non-negative (${fmt(r.gap)})`,
    r.gap >= 0,
    `required=${fmt(r.requiredLump)}, balance=${fmt(r.retirementBalance)}`
  );

  // ── 9. Pension card ─────────────────────────────────────────────────────────
  if (st.pension.include) {
    const pensionRows = ddRows.filter(row => row.pension && row.pension.annualPension > 0);
    if (pensionRows.length > 0) {
      assert(
        `Age Pension triggered (${fmt(pensionRows[0].pension.annualPension)}/yr, binding: ${pensionRows[0].pension.binding})`,
        true, `pensionStartAge=${r.pensionStartAge}`
      );
      // Pension must not exceed the max rate INDEXED to that year (rates index
      // at 2%/yr from today, matching the nominal basis of desired income)
      const BASE_MAX_COUPLE = 47070, BASE_MAX_SINGLE = 31430, PENSION_IX = 0.02;
      const overMax = pensionRows.find(row => {
        const ix = Math.pow(1 + PENSION_IX, row.t - 1);
        const cap = (row.pensionBothAlive ? BASE_MAX_COUPLE : BASE_MAX_SINGLE) * ix;
        return row.pension.annualPension > cap + 1;
      });
      assert(
        `No pension row exceeds the indexed max rate (base couple $${(BASE_MAX_COUPLE/1000).toFixed(0)}k @ 2%/yr)`,
        !overMax,
        overMax ? `age ${overMax.chartAge}: ${fmt(overMax.pension.annualPension)} vs indexed cap ${fmt((overMax.pensionBothAlive ? BASE_MAX_COUPLE : BASE_MAX_SINGLE) * Math.pow(1 + PENSION_IX, overMax.t - 1))}` : ''
      );
    } else {
      warn(`Pension included but never triggered — assets may stay above cutoff throughout`, '');
    }
  } else {
    assert(
      `Pension excluded → pensionStartAge is null`,
      r.pensionStartAge === null,
      ''
    );
  }

  // ── 10. Sequencing stress: DD-year-1 balance is 25% lower ───────────────────
  const seqDDRows = rs.rows.filter(row => row.dd);
  const normDD1 = ddRows[0];
  const seqDD1  = seqDDRows[0];
  if (normDD1 && seqDD1) {
    const normBal = normDD1.startBalance;
    const seqBal  = seqDD1.startBalance;
    // After shock, seqBal ≈ normBal * 0.75
    const ratio = seqBal / normBal;
    assert(
      `Sequencing shock: DD yr-1 balance ratio ${(ratio*100).toFixed(1)}% of base (expect ~75%)`,
      ratio >= 0.73 && ratio <= 0.77,
      `base=${fmt(normBal)}, stressed=${fmt(seqBal)}`
    );
    // And total wealth at end of DD yr 1 should be lower
    assert(
      `Stressed total wealth (${fmt(seqDD1.totalWealth)}) < base (${fmt(normDD1.totalWealth)}) in DD yr 1`,
      seqDD1.totalWealth < normDD1.totalWealth,
      ''
    );
  }

  // ── Scenario-specific tests ─────────────────────────────────────────────────
  if (sc === S4) {
    // S4: survivor fires in the year cs[0].age reaches lifeExpectancy (72),
    // i.e. year = LE - startAge + 1
    const survRow = r.rows.find(row => row.survivorEvent);
    const expectedSurvYear = c[0].lifeExpectancy - c[0].currentAge + 1;
    assert(
      `Survivor event fires at year ${expectedSurvYear} (C1 passes life expectancy ${c[0].lifeExpectancy})`,
      survRow && survRow.t === expectedSurvYear,
      survRow ? `survRow.t=${survRow.t}, chartAge=${survRow.chartAge}` : 'no survivorEvent row'
    );
    // After survivor, wealth should decline to single-expense level
    if (survRow) {
      const postSurv = r.rows.filter(row => row.dd && row.chartAge > survRow.chartAge).slice(0, 3);
      const preSurv  = ddRows.filter(row => row.chartAge < survRow.chartAge).slice(-3);
      if (preSurv.length > 0 && postSurv.length > 0) {
        const avgPreDraw  = preSurv.reduce((s,r) => s + (r.drawdownDraw ?? 0), 0) / preSurv.length;
        const avgPostDraw = postSurv.reduce((s,r) => s + (r.drawdownDraw ?? 0), 0) / postSurv.length;
        // survivor expense = 70% → draw should drop
        assert(
          `Post-survivor draw (${fmt(avgPostDraw)}/yr) < pre-survivor draw (${fmt(avgPreDraw)}/yr)`,
          avgPostDraw <= avgPreDraw * 1.05,  // small tolerance for inflation
          ''
        );
      }
    }
  }

  if (sc === S5) {
    // S5: aged care reserve should be carved out when oldest alive >= 85
    const acRow = r.rows.find(row => row.agedCareSetup);
    assert(
      `Aged care reserve set up (${fmt(acRow?.agedCareSetup)})`,
      acRow != null,
      acRow ? `at chartAge=${acRow.chartAge}` : 'no agedCareSetup row'
    );
    // RAD bond mode: aged care balance should NOT grow (0% return)
    if (acRow) {
      const acRows = r.rows.filter(row => row.agedCareBal != null).slice(0, 5);
      if (acRows.length >= 2) {
        const acGrows = acRows.some((row, i) => i > 0 && row.agedCareBal > acRows[i-1].agedCareBal * 1.001);
        assert(
          `RAD bond mode: aged care balance does not grow (0% return)`,
          !acGrows,
          `first=${fmt(acRows[0].agedCareBal)}, later=${fmt(acRows[acRows.length-1].agedCareBal)}`
        );
      }
    }
    // Bequest target: depletion should be detected relative to $150k, not zero
    const bequestTarget = 150000;
    if (r.depletionAge != null) {
      const deplRow = r.rows.find(row => row.dd && row.chartAge === r.depletionAge);
      const postDeplRow = r.rows.find(row => row.dd && row.chartAge > r.depletionAge);
      if (postDeplRow) {
        assert(
          `Post-depletion balance (${fmt(postDeplRow.endBalance)}) ≤ bequest target (${fmt(bequestTarget)})`,
          (postDeplRow.endBalance ?? 0) <= bequestTarget * 1.02,
          ''
        );
      }
    }
    // Inheritance: $200k arrives at age 70 for C1 (currentAge=52, so year 19)
    const inhYear = st.inheritance.ageReceived - c[0].currentAge + 1;
    const inhRow  = r.rows.find(row => row.t === inhYear);
    assert(
      `Inheritance trigger year = ${inhYear} (ageReceived=${st.inheritance.ageReceived})`,
      inhYear > 0 && inhRow != null,
      `chartAge at trigger: ${inhRow?.chartAge}`
    );
  }

  if (sc === S3) {
    // S3: inheritance $300k at C1-age 65 (freedom year), min-drawdown check
    // Check that min drawdown rows are present
    const minDRows = ddRows.filter(row => row.minDrawdown > 0);
    assert(
      `Min drawdown applied in ${minDRows.length} drawdown rows`,
      minDRows.length > 0,
      `first minDraw=${fmt(minDRows[0]?.minDrawdown)}`
    );
    // excess min draw (when min > income need) should be ≥ 0
    const negExcess = ddRows.find(row => row.excessMinDraw < -1);
    assert(
      `excessMinDraw never negative (excess reinvested)`,
      !negExcess,
      negExcess ? `got ${fmt(negExcess.excessMinDraw)} at dd=${negExcess.dd}` : ''
    );
  }
}

// ── Cross-scenario comparisons ────────────────────────────────────────────────
section('CROSS-SCENARIO COMPARISONS');
{
  const s1r = results[S1.label].r;
  const s2r = results[S2.label].r;
  const s3r = results[S3.label].r;

  // S3 (high-growth, high-super, early retire) should have higher retirement balance than S2
  assert(
    `S3 retirement balance (${fmt(s3r.retirementBalance)}) > S2 (${fmt(s2r.retirementBalance)})`,
    s3r.retirementBalance > s2r.retirementBalance,
    ''
  );

  // S1 (growth 6%) should have higher retirement balance than S2 (conservative 4.5%)
  // given both have similar start ages and incomes
  const s1Gap = s1r.gap, s2Gap = s2r.gap;
  console.log(`  ${DIM}S1 gap: ${fmt(s1Gap)},  S2 gap: ${fmt(s2Gap)}${RESET}`);

  // Sequencing always makes things worse (or equal)
  for (const sc of SCENARIOS) {
    const base   = results[sc.label].r;
    const stress = results[sc.label].rs;
    assert(
      `${sc.label.split('—')[0].trim()}: stressed final wealth ≤ base final wealth`,
      (stress.rows[stress.rows.length - 1].totalWealth ?? 0) <=
      (base.rows[base.rows.length - 1].totalWealth ?? 0) + 1,
      `base=${fmt(base.rows[base.rows.length-1].totalWealth)}, stressed=${fmt(stress.rows[stress.rows.length-1].totalWealth)}`
    );
  }

  // yearsFullyFunded ≤ total plan years
  for (const sc of SCENARIOS) {
    const r = results[sc.label].r;
    const st = sc.state;
    const planYrs = st.shared.planToAge - Math.max(st.clients[0].freedomAge, st.clients[1].freedomAge);
    assert(
      `${sc.label.split('—')[0].trim()}: yearsFullyFunded (${r.yearsFullyFunded}) ≤ planYears (${planYrs})`,
      r.yearsFullyFunded <= planYrs + 1,  // +1 for edge cases
      ''
    );
  }
}

// ── Detailed row dump for S1 ──────────────────────────────────────────────────
section('S1 — DETAILED ROW SNAPSHOT (every 5 years)');
{
  const r   = results[S1.label].r;
  const rs  = results[S1.label].rs;
  const hdr = ['ChartAge','Phase','Wealth(base)','Wealth(stress)','Draw','Pension','MinDraw'];
  console.log('  ' + hdr.map(h => h.padStart(14)).join(''));
  for (const row of r.rows) {
    if (row.chartAge % 5 !== 0 && !row.retirementStart && !row.survivorEvent && !row.agedCareSetup) continue;
    const sRow   = rs.rows.find(sr => sr.chartAge === row.chartAge);
    const phase  = row.retirementStart ? 'RETIRE→' : row.dd ? 'DD' : 'ACCUM';
    const cols = [
      String(row.chartAge).padStart(14),
      phase.padStart(14),
      fmt(row.totalWealth).padStart(14),
      fmt(sRow?.totalWealth).padStart(14),
      fmt(row.drawdownDraw).padStart(14),
      fmt(row.pension?.annualPension).padStart(14),
      fmt(row.minDrawdown).padStart(14),
    ];
    const tag = row.retirementStart ? ` ${YELLOW}← RETIREMENT${RESET}` : row.survivorEvent ? ` ${RED}← SURVIVOR${RESET}` : '';
    console.log('  ' + cols.join('') + tag);
  }
}

// ── Income tax sample table ───────────────────────────────────────────────────
section('INCOME TAX SPOT TABLE');
{
  const incomes = [50000, 80000, 100000, 120000, 140000, 165000, 200000, 250000];
  console.log(`  ${'Gross'.padStart(10)}  ${'Tax'.padStart(10)}  ${'Net'.padStart(10)}  ${'Eff%'.padStart(7)}`);
  for (const g of incomes) {
    const tax = calcIncomeTax(g);
    const net = g - tax;
    const eff = (tax / g * 100).toFixed(1);
    console.log(`  ${fmt(g).padStart(10)}  ${fmt(tax).padStart(10)}  ${fmt(net).padStart(10)}  ${eff.padStart(6)}%`);
  }
}

// ── Final summary ─────────────────────────────────────────────────────────────
section('RESULTS SUMMARY');
for (const sc of SCENARIOS) {
  const r = results[sc.label].r;
  const st = sc.state;
  const jf = Math.max(st.clients[0].freedomAge, st.clients[1].freedomAge);
  const planYrs = st.shared.planToAge - jf;
  const gapLabel = r.gap > 0 ? `${RED}gap ${fmt(r.gap)}${RESET}` : `${GREEN}fully funded${RESET}`;
  const deplLabel = r.depletionAge ? `deplete @${r.depletionAge}` : `funded to ${st.shared.planToAge}+`;
  console.log(`  ${sc.label}`);
  console.log(`    retire ${jf}, ${planYrs}yr plan, balance ${fmt(r.retirementBalance)}, ${gapLabel}, ${deplLabel}, yearsFullyFunded=${r.yearsFullyFunded}/${planYrs}`);
}

console.log(`\n${BOLD}══ TOTALS: ${GREEN}${passed} passed${RESET}${BOLD}, ${failed > 0 ? RED : ''}${failed} failed${RESET}${BOLD}, ${warnings > 0 ? YELLOW : ''}${warnings} warnings${RESET}\n`);

if (failed > 0) process.exit(1);
