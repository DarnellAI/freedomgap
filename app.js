import { DEFAULT_STATE, PENSION, SCENARIO_COLORS, SCENARIO_NAMES, MAX_SCENARIOS, RETURN_PROFILES } from './data/parameters.js';
import { runProjection } from './calc/core.js';
import { safeEarnAmount } from './calc/pension.js';
import { initChart, updateChart, initDebtChart, updateDebtChart } from './ui/chart.js';
import { renderInputs } from './ui/inputs.js';
import {
  defaultScenario, loadScenarios, saveScenarios,
  exportJSON, importJSON,
  renderScenarioTabs, renderSequencingToggle,
} from './ui/scenarios.js';

// ── Fractional age from birth date + plan date ─────────────────────────────────
function computeFractionalAge(birthYear, birthMonth, planDateStr) {
  if (!birthYear || !birthMonth) return null;
  const today = planDateStr ? new Date(planDateStr + 'T00:00:00') : new Date();
  const birth = new Date(birthYear, birthMonth - 1, 1);
  if (isNaN(birth.getTime()) || isNaN(today.getTime())) return null;
  return (today - birth) / (365.25 * 24 * 60 * 60 * 1000);
}

// ── State migration (old single-debt format → debts array) ────────────────────
function migrateState(state) {
  if (state.debt !== undefined && !state.debts) {
    state.debts = (state.debt?.balance > 0) ? [{
      name: 'Loan',
      balance: state.debt.balance ?? 0,
      rate: state.debt.rate ?? 0.06,
      repayment: state.debt.annualPayment ?? 0,
      frequency: 'annual',
    }] : [];
    delete state.debt;
  }
  if (!state.debts) state.debts = [];
  // Migrate single desiredIncome → incomePhases array
  if (!state.shared.incomePhases) {
    state.shared.incomePhases = [{ income: state.shared.desiredIncome ?? 100000, untilAge: null }];
  }
  // Ensure required top-level keys exist (pre-v2 imports may be missing them)
  if (!state.survivor)  state.survivor  = { active: true,  expenseFactor: 0.70 };
  if (!state.bequest)   state.bequest   = { active: false, amount: 0 };
  if (!state.agedCare)  state.agedCare  = { active: false, amount: 500000, triggerAge: 85, mode: 'invested' };
  if (!state.pension)   state.pension   = { include: true, homeowner: true, pensionAge: 67 };
  if (state.pension.homeValue === undefined) state.pension.homeValue = 0;
  // Migrate old single inheritance → inheritances array
  if (state.inheritance !== undefined && !state.inheritances) {
    state.inheritances = (state.inheritance?.amount > 0) ? [{
      name: '',
      amount: state.inheritance.amount,
      ageReceived: state.inheritance.ageReceived ?? 75,
      destination: state.inheritance.destination ?? 'nonSuper',
      applyToDebtFirst: state.inheritance.applyToDebtFirst ?? false,
    }] : [];
    delete state.inheritance;
  }
  if (!state.inheritances) state.inheritances = [];
  // Birth date and plan date (added for fractional age display)
  state.clients.forEach(cl => {
    if (cl.birthYear  === undefined) cl.birthYear  = null;
    if (cl.birthMonth === undefined) cl.birthMonth = null;
  });
  if (state.shared.planDate === undefined) state.shared.planDate = null;
  return state;
}

// ── State ──────────────────────────────────────────────────────────────────────
let scenarios   = loadScenarios().map(sc => { sc.state = migrateState(sc.state); return sc; });
let activeId    = scenarios[0]?.id ?? 0;
let chart       = null;
let debtChart   = null;

function activeScenario() { return scenarios.find(s => s.id === activeId) ?? scenarios[0]; }

// ── Projection ─────────────────────────────────────────────────────────────────
function recalc() {
  const results = [];
  for (const sc of scenarios) {
    if (!sc.visible) continue;
    const result    = runProjection(sc.state);
    const seqResult = sc.showSequencing ? runProjection(sc.state, true) : null;
    // Attach fractional ages for chart label display
    const pd = sc.state.shared.planDate;
    const f0 = computeFractionalAge(sc.state.clients[0].birthYear, sc.state.clients[0].birthMonth, pd);
    const f1 = computeFractionalAge(sc.state.clients[1].birthYear, sc.state.clients[1].birthMonth, pd);
    if (f0 != null && f1 != null) {
      result.fractionalStartAges = [f0, f1];
      if (seqResult) seqResult.fractionalStartAges = [f0, f1];
    }
    results.push({ scenario: sc, result, sequencingResult: seqResult });
  }

  const primary = results.find(r => r.scenario.id === activeId) ?? results[0];
  if (primary) updateOutputs(primary.result);
  updateChart(results);
  updateChartLegend(results);
  updateDebtChart(results);
  if (primary) updateWorkingsTable(primary.result, primary.scenario.state);
  saveScenarios(scenarios);
}

// ── Formatted outputs ──────────────────────────────────────────────────────────
function fmt(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3)  return `$${(n / 1e3).toFixed(0)}k`;
  return `$${Math.round(n).toLocaleString()}`;
}
function fmtPct(r) { return r != null ? `${(r * 100).toFixed(1)}%` : '—'; }

function updateOutputs(result) {
  const {
    retirementBalance, requiredLump, gap,
    depletionAge, yearsFullyFunded,
    pensionStartAge, firstPensionResult, returnRate,
  } = result;

  // Risk card
  const card  = document.getElementById('riskCard');
  const state = activeScenario().state;
  const planTo = state.shared.planToAge ?? 95;
  card.className = 'rounded-2xl shadow-sm p-6 transition-all duration-300 ';
  const depEl = document.getElementById('riskAge');
  const lbl   = document.getElementById('riskLabel');
  const sub   = document.getElementById('riskSubtext');

  if (!depletionAge || depletionAge >= planTo) {
    card.className += 'risk-good';
    depEl.textContent = planTo + '+';
    lbl.textContent   = 'Fully funded ✓';
    sub.textContent   = `Wealth lasts past your plan-to age (${planTo})`;
  } else {
    const gap_yrs = planTo - depletionAge;
    if (gap_yrs <= 5) {
      card.className += 'risk-warn';
      lbl.textContent = `${gap_yrs} year${gap_yrs !== 1 ? 's' : ''} short`;
    } else {
      card.className += 'risk-bad';
      lbl.textContent = `${gap_yrs} years short`;
    }
    depEl.textContent = depletionAge;
    sub.textContent   = `Funds deplete ~${gap_yrs} year${gap_yrs !== 1 ? 's' : ''} before plan-to age ${planTo}`;
  }

  // Home equity on risk card — shows estate backstop even if portfolio depletes
  const homeEquityEl = document.getElementById('homeEquityLine');
  if (homeEquityEl) {
    const homeVal = result.initialHomeValue ?? 0;
    if (homeVal > 0) {
      const displayAge = (depletionAge && depletionAge < planTo) ? depletionAge : planTo;
      const ageRow = result.rows.find(r => r.chartAge === displayAge) ?? result.rows[result.rows.length - 1];
      const heVal  = ageRow?.homeValue ?? 0;
      const label  = (depletionAge && depletionAge < planTo)
        ? `Home equity at depletion (age ${displayAge}): ~${fmt(heVal)}`
        : `Home equity at age ${displayAge}: ~${fmt(heVal)}`;
      homeEquityEl.textContent = label;
      homeEquityEl.classList.remove('hidden');
    } else {
      homeEquityEl.classList.add('hidden');
    }
  }

  // Opening balance / self-funded gap card
  setText('gapAmount',    gap > 0 ? fmt(gap) : 'Self-funded ✓');
  setText('balAmount',    fmt(retirementBalance));
  setText('targetAmount', fmt(requiredLump));
  setText('returnRate',   fmtPct(returnRate));
  document.getElementById('gapAmount').style.color = gap > 0 ? '#991b1b' : '#15803d';

  // Pension card — use first-year result so it reflects actual entitlement at eligibility age
  if (pensionStartAge) {
    setText('pensionStartAge', `Age ${pensionStartAge}`);
    if (firstPensionResult) {
      const ann = firstPensionResult.annualPension;
      setText('pensionStatus',  firstPensionResult.fullPension ? 'Full pension' : firstPensionResult.partPension ? 'Part pension' : '');
      setText('pensionDetail',  `~${fmt(ann)}/yr — ${firstPensionResult.binding} test applies`);
    }
  } else {
    setText('pensionStartAge', state.pension.include ? 'Not eligible' : 'Excluded');
    setText('pensionStatus', '');
    setText('pensionDetail', state.pension.include ? '' : 'Enable in Age Pension settings');
  }

  // Pension explainer
  setText('ap_full', fmt(PENSION.assetFull.couple.homeowner));
  setText('ap_cut',  fmt(PENSION.assetCut.couple.homeowner));
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text ?? '—';
}

// ── Calculation workings table ─────────────────────────────────────────────────
let lastExportData = null; // full result + state stored for XLSX export

function updateWorkingsTable(result, state) {
  lastExportData = { result, state };
  const tbody = document.getElementById('workingsBody');
  const debtHeader = document.getElementById('debtColHeader');
  if (!tbody) return;

  const r       = result.returnRate;
  const rPct    = (r * 100).toFixed(1);
  const maxAge  = result.planToAge ?? 95;
  const hasDebt = (result.debtNames ?? []).length > 0;

  if (debtHeader) debtHeader.classList.toggle('hidden', !hasDebt);

  // dollar formatter — full precision for the table
  function d(n) {
    if (n == null || isNaN(n)) return '—';
    const abs = Math.abs(n);
    const s = abs >= 1e6 ? `$${(abs / 1e6).toFixed(3)}M`
            : abs >= 1e3 ? `$${(abs / 1e3).toFixed(1)}k`
            : `$${Math.round(abs)}`;
    return n < 0 ? `−${s}` : s;
  }

  const rows = result.rows.filter(row => row.chartAge != null && row.chartAge <= maxAge);
  tbody.innerHTML = '';

  for (const row of rows) {
    const inDrawdown = row.dd != null;
    const age        = row.chartAge;
    const wealth     = row.totalWealth ?? 0;
    const totalDebt  = row.totalDebt ?? 0;

    // ── Build formula string ─────────────────────────────────────────────────
    let formula = '';
    const events = [];
    if (row.retirementStart)  events.push('Retirement begins');
    if (row.sequencingShock)  events.push('−25% sequencing shock applied');
    if (row.survivorEvent)    events.push('Survivor mode — partner deceased');
    if (row.agedCareSetup)    events.push(`Aged care reserve: ${d(row.agedCareSetup)} set aside`);

    if (!inDrawdown) {
      // Accumulation
      const superTotal = (row.accum0 ?? 0) + (row.pension0 ?? 0) + (row.accum1 ?? 0) + (row.pension1 ?? 0);
      const nonSuper   = wealth - superTotal;
      const sgc    = row.sgcTotal    ?? 0;
      const ret    = row.returnAccum ?? 0;
      const tax    = row.taxAccum    ?? 0;
      const parts  = [];
      if (sgc  > 0) parts.push(`+${d(sgc)} SGC (${(((state.shared.sgcRate ?? 0.12) * 100).toFixed(0))}%)`);
      if (ret  > 0) parts.push(`+${d(ret)} growth (${rPct}%)`);
      if (tax  > 0) parts.push(`−${d(tax)} contributions tax (15%)`);
      if (totalDebt > 0) parts.push(`−${d(totalDebt)} debt balance`);
      formula = `Super: ${d(superTotal)}${parts.length ? '  [' + parts.join('  ') + ']' : ''}`;
      if (nonSuper > 0) formula += `  ·  Non-super: ${d(nonSuper)}`;
    } else {
      // Drawdown
      const open   = row.startBalance ?? 0;
      const growth = row.grossReturn  ?? 0;
      const draw   = row.drawdownDraw ?? 0;
      const pens   = row.pensionIncome ?? 0;
      const debt   = totalDebt > 0 ? (draw - Math.max(0, draw - totalDebt)) : 0;
      const close  = row.endBalance ?? 0;
      formula = `${d(open)} opening  +${d(growth)} return (${rPct}%)  −${d(draw)} withdrawn`;
      const breakdown = [];
      if (pens > 0) breakdown.push(`Age Pension: ${d(pens)}/yr`);
      if (row.debtBalances?.some(b => b > 0)) breakdown.push(`incl. debt repayments`);
      if (row.minDrawdown > 0) breakdown.push(`min drawdown: ${d(row.minDrawdown)}`);
      if (breakdown.length) formula += `  [${breakdown.join('  ·  ')}]`;
      formula += `  =  ${d(Math.max(0, close))} closing`;
    }

    if (events.length) formula = events.join(' · ') + '  |  ' + formula;

    // ── Phase label ──────────────────────────────────────────────────────────
    const phaseLabel = inDrawdown ? `Drawdown yr ${row.dd}` : 'Accumulation';

    // ── DOM row ──────────────────────────────────────────────────────────────
    const tr = document.createElement('tr');
    if (row.retirementStart) tr.className = 'phase-change';

    const phaseTag = inDrawdown
      ? `<span class="tag tag-drawdown">Drawdown</span>`
      : `<span class="tag tag-accum">Accumulation</span>`;
    const eventTag = events.length ? `<span class="tag tag-event">Event</span>` : '';

    tr.innerHTML = `
      <td>${age}</td>
      <td>${phaseTag}${eventTag}</td>
      <td class="balance">${d(wealth)}</td>
      ${hasDebt ? `<td class="debt-col">${totalDebt > 0 ? d(totalDebt) : '—'}</td>` : ''}
      <td class="formula">${formula.replace(/</g, '&lt;')}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ── XLSX audit export (multi-sheet) ───────────────────────────────────────────

function applyColFormat(ws, cols, fmt, rowCount) {
  for (let r = 1; r <= rowCount; r++) {
    for (const c of cols) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (ws[addr] && typeof ws[addr].v === 'number') ws[addr].z = fmt;
    }
  }
}

function exportWorkingsXLSX() {
  if (!lastExportData || typeof XLSX === 'undefined') return;
  const { result, state } = lastExportData;
  const { returnRate, planToAge, freedomAge, debtNames = [], clientStartAges = [], youngerStart = 0 } = result;
  const rPct   = (returnRate * 100).toFixed(1);
  const maxAge = planToAge ?? 95;
  const c      = state.clients;
  const n0     = c[0].name, n1 = c[1].name;
  const hasDebt = debtNames.length > 0;
  const CUR = '$#,##0';

  function ageLabel(chartAge) {
    const off = chartAge - youngerStart;
    return `${clientStartAges[0] + off}/${clientStartAges[1] + off}`;
  }
  function clientAge(i, chartAge) { return clientStartAges[i] + (chartAge - youngerStart); }

  const validRows = result.rows.filter(r => r.chartAge != null && r.chartAge <= maxAge);
  const drawRows  = validRows.filter(r => r.dd != null);

  const wb = XLSX.utils.book_new();

  // ── Sheet 1: Overview (unchanged) ──────────────────────────────────────────
  const rp     = RETURN_PROFILES.find(p => p.id === state.shared.returnProfile);
  const phases = state.shared.incomePhases ?? [{ income: state.shared.desiredIncome ?? 0, untilAge: null }];
  const sum = [
    ['FREEDOM GAP CALCULATOR — AUDIT REPORT', ''],
    ['Generated:', new Date().toLocaleDateString('en-AU')],
    [],
    ['── PROJECTION SETTINGS', ''],
    ['Return profile:', rp ? `${rp.label} (${(rp.rate * 100).toFixed(1)}%)` : state.shared.returnProfile],
    ['SGC rate:', `${((state.shared.sgcRate ?? 0.12) * 100).toFixed(0)}%`],
    ['Plan to age:', planToAge],
    ['Joint freedom age:', freedomAge],
    [],
    ["── DESIRED RETIREMENT INCOME (today's $)", ''],
    ...phases.map((ph, i) => [`Phase ${i + 1}${ph.untilAge ? ` (until age ${ph.untilAge})` : ' (ongoing)'}:`, ph.income]),
    [],
    ['── CLIENT 1', c[0].name],
    ['Gender:', c[0].gender],
    ['Current age:', c[0].currentAge],
    ['Life expectancy:', c[0].lifeExpectancy],
    ['Full-time salary:', c[0].ftIncome],
    [`Part-time from age / salary:`, `${c[0].ptAge} / $${(c[0].ptIncome ?? 0).toLocaleString()}`],
    ['Freedom age:', c[0].freedomAge],
    ['Super balance (now):', c[0].superBalance],
    ['Additional concessional:', c[0].additionalConcessional ?? 0],
    ['Downsizer:', c[0].downsizer?.active ? `$${(c[0].downsizer.amount ?? 0).toLocaleString()}` : 'Not used'],
    [],
    ['── CLIENT 2', c[1].name],
    ['Gender:', c[1].gender],
    ['Current age:', c[1].currentAge],
    ['Life expectancy:', c[1].lifeExpectancy],
    ['Full-time salary:', c[1].ftIncome],
    [`Part-time from age / salary:`, `${c[1].ptAge} / $${(c[1].ptIncome ?? 0).toLocaleString()}`],
    ['Freedom age:', c[1].freedomAge],
    ['Super balance (now):', c[1].superBalance],
    ['Additional concessional:', c[1].additionalConcessional ?? 0],
    ['Downsizer:', c[1].downsizer?.active ? `$${(c[1].downsizer.amount ?? 0).toLocaleString()}` : 'Not used'],
    [],
    ['── AGE PENSION', ''],
    ['Included:', state.pension?.include ? 'Yes' : 'No'],
    ['Homeowner:', state.pension?.homeowner ? 'Yes' : 'No'],
    ['Current home value:', state.pension?.homeValue > 0 ? state.pension.homeValue : 'Not set'],
    ['Eligibility age:', state.pension?.pensionAge ?? 67],
    [],
  ];
  const validInhs = (state.inheritances ?? []).filter(inh => inh.amount > 0);
  if (validInhs.length > 0) {
    sum.push(['── INHERITANCES', '']);
    for (const inh of validInhs) {
      sum.push([inh.name || 'Inheritance', '']);
      sum.push(['  Amount:', inh.amount]);
      sum.push(['  Age received (Client 1):', inh.ageReceived]);
      sum.push(['  Destination:', inh.destination]);
      sum.push(['  Apply to debt first:', inh.applyToDebtFirst ? 'Yes' : 'No']);
    }
    sum.push([]);
  }
  if (hasDebt) {
    sum.push(['── DEBTS', '']);
    for (const d of state.debts) {
      sum.push([d.name, d.balance, `${(d.rate * 100).toFixed(2)}% p.a.`, `$${d.repayment}/${d.frequency}`]);
    }
    sum.push([]);
  }
  sum.push(['── KEY OUTPUTS', '']);
  sum.push(['Retirement balance at freedom (household):', result.retirementBalance]);
  sum.push(['Required balance (self-funded, no pension):', result.requiredLump]);
  sum.push(['Funding gap (excl. pension, excl. estate target):', result.gap]);
  sum.push(['Portfolio depletes at age:', result.depletionAge ?? `${planToAge}+ (fully funded)`]);
  const planYearsFromFreedom = Math.max(1, planToAge - result.freedomAge);
  sum.push([`Plan years portfolio sustained desired income (from joint freedom age ${result.freedomAge}):`, `${result.yearsFullyFunded} of ${planYearsFromFreedom}`]);
  sum.push(['Age Pension commences:', result.pensionStartAge ? `Age ${result.pensionStartAge}` : 'Not reached']);
  // Use last pension result within the plan-to age (not the extra trailing year)
  const finalPensionRow = [...drawRows].reverse().find(r => r.pension);
  const finalPension = finalPensionRow?.pension;
  if (finalPension) {
    sum.push(['Final year Age Pension (within plan):', finalPension.annualPension]);
    const firstBinding = result.firstPensionResult?.binding;
    const lastBinding  = finalPension.binding;
    sum.push(['Pension binding test:', firstBinding && firstBinding !== lastBinding
      ? `${firstBinding} → ${lastBinding} (see Aged Pension sheet for year-by-year)`
      : (lastBinding ?? '—')]);
  }
  const ws1 = XLSX.utils.aoa_to_sheet(sum);
  ws1['!cols'] = [{ wch: 42 }, { wch: 28 }, { wch: 20 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'Overview');

  // ── Sheet 2: Portfolio Balance (all years, combined household) ─────────────
  // Combined balance schedule driven by SGC contributions and investment returns.
  // Surplus cashflow from Sheet 3 is treated as an NCC contribution.
  // Portfolio drawdown from Sheet 3 reduces the balance.
  const hasHomeValue = (state.pension?.homeValue ?? 0) > 0;
  const hasNonSuper  = validRows.some(r => (r.nonSuperGrowth ?? 0) > 0.5);
  const pb2Hdr = [
    'Age (C1/C2)', 'Phase',
    'Combined Starting Balance',
    `SGC — ${n0}`, `SGC — ${n1}`,
    'Surplus Contribution',
    `Investment Return — ${n0}`, `Investment Return — ${n1}`,
    ...(hasNonSuper ? ['Non-super Return'] : []),
    `Tax — ${n0}`, `Tax — ${n1}`,
    'Portfolio Drawdown',
    'Combined Ending Balance',
    ...(hasHomeValue ? ['Home Equity (3% p.a.)'] : []),
    'Notes',
  ];
  const pb2Body = validRows.map((row, idx) => {
    const inDD   = row.dd != null;
    const prevRow = validRows[idx - 1];
    const startBal = idx === 0
      ? (c[0].superBalance ?? 0) + (c[1].superBalance ?? 0) + (state.shared.nonSuper ?? 0)
      : (prevRow.totalWealth ?? 0);
    const sgc0 = row.sgc0 ?? 0;
    const sgc1 = row.sgc1 ?? 0;
    const surplus = inDD ? (row.surplusSaving ?? 0) : 0;
    // During drawdown the combined pool return goes in the C1 column; any separate
    // below-67 working super return is in the respective client column.
    const ret0 = inDD
      ? (row.grossReturn ?? 0) + (row.return0 ?? 0)
      : (row.return0 ?? 0);
    const ret1 = row.return1 ?? 0;
    const nsRet = row.nonSuperGrowth ?? 0;
    const tax0 = row.tax0 ?? 0;
    const tax1 = row.tax1 ?? 0;
    // In retirement the drawdown is the net portfolio draw; during accumulation
    // debt service comes from non-super savings first (a real portfolio outflow),
    // with any shortfall met from salary (not a portfolio outflow).
    const debtRepaid      = !inDD ? (row.debtDetails?.reduce((s, d) => s + d.repayment, 0) ?? 0) : 0;
    const debtFromSavings = !inDD ? (row.debtFromSavings ?? 0) : 0;
    const debtFromSalary  = Math.max(0, debtRepaid - debtFromSavings);
    const portfolioDraw = inDD ? (row.drawdownDraw ?? 0) : debtFromSavings;
    const endBal = row.totalWealth ?? 0;
    const notes = [
      row.retirementStart        ? 'Retirement begins'                                                       : '',
      row.partnerJoinsRetirement ? 'Working partner joins pool'                                               : '',
      row.survivorEvent          ? 'Survivor — partner deceased'                                              : '',
      row.sequencingShock        ? '−25% sequencing shock'                                                    : '',
      row.agedCareSetup          ? `Aged care reserve set aside: $${Math.round(row.agedCareSetup).toLocaleString()}` : '',
      row.inheritanceToPool > 0  ? `Inheritance to portfolio: $${Math.round(row.inheritanceToPool).toLocaleString()}`  : '',
      row.downsizerAdded > 0     ? `Downsizer contribution: $${Math.round(row.downsizerAdded).toLocaleString()}` : '',
      debtFromSavings > 0        ? `Debt repaid from savings: $${Math.round(debtFromSavings).toLocaleString()}` : '',
      debtFromSalary > 0         ? `Debt repaid from salary: $${Math.round(debtFromSalary).toLocaleString()} (not from portfolio)` : '',
    ].filter(Boolean).join('; ');
    return [
      ageLabel(row.chartAge),
      inDD ? `Drawdown yr ${row.dd}` : 'Accumulation',
      startBal, sgc0, sgc1, surplus, ret0, ret1,
      ...(hasNonSuper ? [nsRet] : []),
      tax0, tax1, portfolioDraw, endBal,
      ...(hasHomeValue ? [row.homeValue ?? 0] : []),
      notes,
    ];
  });
  const ws2 = XLSX.utils.aoa_to_sheet([pb2Hdr, ...pb2Body]);
  const pb2NumCols = 10 + (hasHomeValue ? 1 : 0) + (hasNonSuper ? 1 : 0);
  ws2['!cols'] = [{ wch: 12 }, { wch: 16 }, ...Array(pb2NumCols).fill({ wch: 22 }), { wch: 50 }];
  applyColFormat(ws2, Array.from({ length: pb2NumCols }, (_, i) => i + 2), CUR, pb2Body.length);
  XLSX.utils.book_append_sheet(wb, ws2, 'Portfolio Balance');

  // ── Sheet 3: Drawdowns (cashflow surplus / deficit) ─────────────────────────
  // Formula: Drawdown Req = Desired Income + Debt Repayments − Aged Pension − Combined Net Income
  // Positive = deficit → portfolio drawdown; Negative = surplus → NCC contribution to Sheet 2.
  const dd3Hdr = [
    'Age (C1/C2)', 'Retirement Year',
    'Desired Income (nominal)',
    'Debt Repayments',
    'Aged Pension Received',
    'Combined Net Working Income',
    'Drawdown Requirement',
    'Direction',
    'Notes',
  ];
  const dd3Body = drawRows.map(row => {
    const desired  = row.desiredNominal  ?? 0;
    const debt     = row.debtRepaymentYr ?? 0;
    const pension  = row.pensionIncome   ?? 0;
    const netInc   = row.workingNetIncome ?? 0;
    const req      = desired + debt - pension - netInc; // positive = draw, negative = surplus
    const notes = [
      row.retirementStart        ? 'Retirement begins'               : '',
      row.partnerJoinsRetirement ? 'Working partner joins pool'       : '',
      row.survivorEvent          ? 'Survivor — partner deceased'      : '',
      row.sequencingShock        ? '−25% sequencing shock applied'    : '',
      row.agedCareSetup          ? `Aged care reserve: $${Math.round(row.agedCareSetup).toLocaleString()}` : '',
      row.inheritanceToPool > 0  ? `Inheritance to pool: $${Math.round(row.inheritanceToPool).toLocaleString()}` : '',
    ].filter(Boolean).join('; ');
    return [
      ageLabel(row.chartAge), row.dd,
      desired, debt, pension, netInc,
      Math.abs(req),
      req > 0 ? 'Drawdown' : req < 0 ? 'Surplus' : 'Neutral',
      notes,
    ];
  });
  const ws3 = XLSX.utils.aoa_to_sheet([dd3Hdr, ...dd3Body]);
  ws3['!cols'] = [
    { wch: 12 }, { wch: 14 },
    { wch: 22 }, { wch: 18 }, { wch: 22 }, { wch: 26 },
    { wch: 22 }, { wch: 12 }, { wch: 40 },
  ];
  applyColFormat(ws3, [2, 3, 4, 5, 6], CUR, dd3Body.length);
  XLSX.utils.book_append_sheet(wb, ws3, 'Drawdowns');

  // ── Sheet 4: Debt Schedule (with inheritance attribution) ──────────────────
  if (hasDebt) {
    const dbHdr = ['Age (C1/C2)', 'Phase'];
    for (const name of debtNames) {
      dbHdr.push(
        `${name} — Opening`,
        `${name} — Interest`,
        `${name} — Regular Repayment`,
        `${name} — Inheritance Applied`,
        `${name} — Closing Balance`,
      );
    }
    dbHdr.push('Total Remaining', 'Notes');
    const debtRows = validRows.filter(r =>
      r.debtDetails && r.debtDetails.some(d => d.opening > 0 || d.repayment > 0 || d.closing > 0)
    );
    const dbBody = debtRows.map(row => {
      const inDD = row.dd != null;
      const rowData = [
        ageLabel(row.chartAge),
        inDD ? `Drawdown yr ${row.dd}` : 'Accumulation',
      ];
      for (let i = 0; i < debtNames.length; i++) {
        const d = (row.debtDetails ?? [])[i] ?? { opening: 0, interest: 0, repayment: 0, closing: 0 };
        // Inheritance payoff = difference between normal closing and final closing (post-inheritance)
        const finalClosing  = (row.debtBalances ?? [])[i] ?? d.closing;
        const inhApplied    = Math.max(0, d.closing - finalClosing);
        rowData.push(d.opening, d.interest, d.repayment, inhApplied, finalClosing);
      }
      const notes = [
        row.inheritanceDebtPayoff > 0
          ? `Inheritance payoff: $${Math.round(row.inheritanceDebtPayoff).toLocaleString()}`
          : '',
        row.inheritanceToPool > 0
          ? `Remaining inheritance to portfolio: $${Math.round(row.inheritanceToPool).toLocaleString()}`
          : '',
      ].filter(Boolean).join('; ');
      rowData.push(row.totalDebt ?? 0, notes);
      return rowData;
    });
    const ws4 = XLSX.utils.aoa_to_sheet([dbHdr, ...dbBody]);
    const dbCols = [{ wch: 12 }, { wch: 16 }];
    debtNames.forEach(() => dbCols.push(...Array(5).fill({ wch: 22 })));
    dbCols.push({ wch: 16 }, { wch: 45 });
    ws4['!cols'] = dbCols;
    const numCols4 = Array.from({ length: dbHdr.length - 3 }, (_, i) => i + 2);
    applyColFormat(ws4, numCols4, CUR, dbBody.length);
    XLSX.utils.book_append_sheet(wb, ws4, 'Debt Schedule');
  }

  // ── Sheet 5: Aged Pension (eligibility and test detail) ────────────────────
  // Single source of truth for pension calculations. Sheet 3 takes only the annual
  // entitlement figure from here.
  const ap5Hdr = [
    'Age (C1/C2)', 'Retirement Year',
    'Household',
    'Total Assessable Assets',
    'Max Annual Pension',
    'Assets Test Result',
    'Income Test Result',
    'Deemed Income',
    'Earned Income (post Work Bonus)',
    'Binding Test',
    'Annual Pension Entitlement',
    'Status',
  ];
  const pensionAge = state.pension?.pensionAge ?? 67;
  const ap5Body = drawRows.map(row => {
    const pr = row.pension;
    const household = row.pensionBothAlive ? 'Couple' : 'Single';
    let status;
    if (!state.pension?.include) {
      status = 'Excluded from model';
    } else if (!pr) {
      status = `Not yet eligible (below age ${pensionAge})`;
    } else if (pr.annualPension <= 0) {
      status = 'Over threshold — nil pension';
    } else if (pr.fullPension) {
      status = 'Full pension';
    } else {
      status = 'Part pension';
    }
    return [
      ageLabel(row.chartAge), row.dd,
      household,
      row.pensionTotalAssets ?? 0,
      pr?.maxAnnual       ?? 0,
      pr?.assetPension    ?? 0,
      pr?.incomePension   ?? 0,
      pr?.deemedIncome    ?? 0,
      pr?.assessableEarned ?? 0,
      pr?.binding         ?? '—',
      pr?.annualPension   ?? 0,
      status,
    ];
  });
  const ws5 = XLSX.utils.aoa_to_sheet([ap5Hdr, ...ap5Body]);
  ws5['!cols'] = [
    { wch: 12 }, { wch: 14 }, { wch: 10 },
    { wch: 24 }, { wch: 20 }, { wch: 20 }, { wch: 20 },
    { wch: 18 }, { wch: 26 }, { wch: 14 }, { wch: 24 }, { wch: 28 },
  ];
  applyColFormat(ws5, [3, 4, 5, 6, 7, 8, 10], CUR, ap5Body.length);
  XLSX.utils.book_append_sheet(wb, ws5, 'Aged Pension');

  // ── Sheet 6: Assumptions & Conventions ─────────────────────────────────────
  const asm = [
    ['ASSUMPTIONS & MODELLING CONVENTIONS', ''],
    [],
    ['── ECONOMIC ASSUMPTIONS', ''],
    ['Inflation (CPI, applied to salaries & desired income):', '2.5% p.a.'],
    ['Age Pension indexation (rates & thresholds):', '2.0% p.a. (deliberately below CPI — conservative)'],
    ['Portfolio return:', rp ? `${rp.label} — ${(rp.rate * 100).toFixed(1)}% p.a. net` : ''],
    ['Home value indexation (estate context only):', '3.0% p.a.'],
    [],
    ['── TAX', ''],
    ['Personal income tax:', '2025-26 resident rates (16% / 30% / 37% / 45%) + LITO + 2% Medicare levy'],
    ['Tax brackets:', 'Held constant in nominal terms (bracket creep makes later net incomes conservative)'],
    ['Super contributions & accumulation earnings tax:', '15%'],
    ['Pension-phase earnings tax:', '0%'],
    [],
    ['── SUPERANNUATION RULES', ''],
    ['Preservation age (earliest super access):', '60 — enforced even if freedom age entered is lower'],
    ['Concessional contributions cap:', '$30,000 p.a. (held constant)'],
    ['Transfer Balance Cap:', '$2,000,000 per person; excess stays in accumulation'],
    ['Downsizer contribution:', 'Max $300,000 per person, from age 55, at retirement'],
    ['ATO minimum drawdown rates:', 'Applied by age bracket; any excess above spending is retained in the portfolio'],
    [],
    ['── AGE PENSION RULES (as at 20 March 2026 base)', ''],
    ['Assets test taper:', '$78/yr per $1,000 over the full-pension threshold'],
    ['Deeming rates:', '0.75% / 2.75% (from 1 Jul 2025)'],
    ['Work Bonus:', '$300/fortnight per person, offset against that person\'s own employment income'],
    ['RAD (aged care bond):', 'Exempt from pension assets test'],
    [],
    ['── MODELLING CONVENTIONS', ''],
    ['Retirement timing:', 'A client retires at the START of the year they reach freedom age (no salary that year)'],
    ['Income drawdown:', 'Annuity-due — a full year of desired income is drawn each year, offset by pension & net salary'],
    ['Contributions timing:', 'SGC earns half a year of return (assumed spread across the year)'],
    ['Pool merging:', 'A working partner\'s super joins the retirement pool at 67 (or their freedom age if earlier, but never before 60)'],
    ['Survivor:', 'On first death, balances transfer to survivor within TBC; spending drops to the survivor expense factor'],
    ['Income phases:', 'Phase boundaries are keyed to the YOUNGER partner\'s age shown on the chart'],
    [],
    ['── KNOWN LIMITATIONS', ''],
    ['1.', 'Investment returns are deterministic (single rate) — no market volatility beyond the optional −25% stress test'],
    ['2.', 'Earnings on pool amounts above the Transfer Balance Cap are not taxed at 15% inside the pool (slightly generous for balances > $2M/person)'],
    ['3.', 'Non-super investment earnings are assumed to compound at the portfolio rate without personal income tax or CGT'],
    ['4.', 'If retirement precedes age 60, spending is funded from non-super savings only until super becomes accessible at 60'],
    ['5.', 'Age Pension Work Bonus income bank accrual is not modelled'],
    ['6.', 'This is a projection tool, not personal financial advice'],
  ];
  const ws6 = XLSX.utils.aoa_to_sheet(asm);
  ws6['!cols'] = [{ wch: 52 }, { wch: 95 }];
  XLSX.utils.book_append_sheet(wb, ws6, 'Assumptions');

  // Trigger browser download
  const buf  = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = 'freedom-gap-audit.xlsx';
  a.click();
  URL.revokeObjectURL(a.href);
}

function updateChartLegend(results) {
  const container = document.getElementById('chartLegend');
  if (!container) return;
  container.innerHTML = '';
  for (const { scenario } of results) {
    if (!scenario.visible) continue;
    const wrap = document.createElement('span');
    wrap.className = 'flex items-center';
    const dot  = document.createElement('span');
    dot.className = 'legend-dot';
    dot.style.background = scenario.color;
    wrap.appendChild(dot);
    wrap.appendChild(document.createTextNode(scenario.name));
    container.appendChild(wrap);
  }
}

// ── Scenario management ────────────────────────────────────────────────────────
function refreshUI() {
  renderScenarioTabs(
    scenarios, activeId,
    id => { activeId = id; refreshUI(); recalc(); },
    () => {
      if (scenarios.length >= MAX_SCENARIOS) return;
      const newId = Math.max(...scenarios.map(s => s.id)) + 1;
      const sc    = defaultScenario(newId);
      sc.color    = SCENARIO_COLORS[scenarios.length % SCENARIO_COLORS.length];
      sc.name     = SCENARIO_NAMES[scenarios.length] ?? `Scenario ${scenarios.length + 1}`;
      sc.state    = JSON.parse(JSON.stringify(activeScenario().state));
      scenarios.push(sc);
      activeId = newId;
      refreshUI();
      recalc();
    },
    id => {
      scenarios = scenarios.filter(s => s.id !== id);
      if (activeId === id) activeId = scenarios[0].id;
      refreshUI();
      recalc();
    },
    (id, visible) => {
      const sc = scenarios.find(s => s.id === id);
      if (sc) sc.visible = visible;
      refreshUI();
      recalc();
    },
    (id, show) => {
      const sc = scenarios.find(s => s.id === id);
      if (sc) sc.showSequencing = show;
      refreshUI();
      recalc();
    },
  );

  renderSequencingToggle(
    activeScenario(),
    (id, show) => {
      const sc = scenarios.find(s => s.id === id);
      if (sc) sc.showSequencing = show;
      refreshUI();
      recalc();
    }
  );

  renderInputs(activeScenario().state, () => recalc());
}

// ── Example data ───────────────────────────────────────────────────────────────
const EXAMPLE = {
  clients: [
    { name: 'Client 1', gender: 'male',   currentAge: 66, lifeExpectancy: 87, ftIncome: 165000, ptAge: 67, ptIncome: 60000,  freedomAge: 72, superBalance: 290000, additionalConcessional: 0, downsizer: { active: false, amount: 0 } },
    { name: 'Client 2', gender: 'female', currentAge: 65, lifeExpectancy: 90, ftIncome: 85000,  ptAge: 68, ptIncome: 45000,  freedomAge: 72, superBalance: 185000, additionalConcessional: 0, downsizer: { active: false, amount: 0 } },
  ],
  shared:      { returnProfile: 'growth', sgcRate: 0.12, nonSuper: 0, desiredIncome: 140000, incomePhases: [{ income: 140000, untilAge: 80 }, { income: 90000, untilAge: null }], planToAge: 90, minDrawdownExcess: 'invest' },
  debts:        [],
  inheritances: [],
  pension:      { include: false, homeowner: true, pensionAge: 67, homeValue: 0 },
  agedCare:    { active: false, amount: 500000, triggerAge: 85, mode: 'invested' },
  survivor:    { active: false, expenseFactor: 0.70 },
  bequest:     { active: false, amount: 0 },
};

// ── Init ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  chart     = initChart('wealthChart');
  debtChart = initDebtChart('debtChart');

  document.getElementById('resetBtn').addEventListener('click', () => {
    if (!confirm('Reset all scenarios to defaults?')) return;
    scenarios = [defaultScenario(0)];
    activeId  = 0;
    refreshUI();
    recalc();
  });

  document.getElementById('exampleBtn').addEventListener('click', () => {
    activeScenario().state = JSON.parse(JSON.stringify(EXAMPLE));
    refreshUI();
    recalc();
  });

  document.getElementById('exportBtn').addEventListener('click', () => exportJSON(scenarios));
  document.getElementById('exportWorkingsBtn').addEventListener('click', () => exportWorkingsXLSX());

  document.getElementById('importBtn').addEventListener('click', () => {
    importJSON(imported => {
      scenarios = imported.map(sc => { sc.state = migrateState(sc.state); return sc; });
      activeId  = scenarios[0]?.id ?? 0;
      refreshUI();
      recalc();
    });
  });

  refreshUI();
  recalc();
});
