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
  if (state.inheritance && state.inheritance.applyToDebtFirst === undefined) {
    state.inheritance.applyToDebtFirst = false;
  }
  // Migrate single desiredIncome → incomePhases array
  if (!state.shared.incomePhases) {
    state.shared.incomePhases = [{ income: state.shared.desiredIncome ?? 100000, untilAge: null }];
  }
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
    const result = runProjection(sc.state);
    const seqResult = sc.showSequencing ? runProjection(sc.state, true) : null;
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
    pensionStartAge, lastPensionResult, returnRate,
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

  // Gap card
  setText('gapAmount',    gap > 0 ? fmt(gap) : 'No gap ✓');
  setText('balAmount',    fmt(retirementBalance));
  setText('targetAmount', fmt(requiredLump));
  setText('returnRate',   fmtPct(returnRate));
  document.getElementById('gapAmount').style.color = gap > 0 ? '#991b1b' : '#15803d';

  // Pension card
  if (pensionStartAge) {
    setText('pensionStartAge', `Age ${pensionStartAge}`);
    if (lastPensionResult) {
      const ann = lastPensionResult.annualPension;
      setText('pensionStatus',  lastPensionResult.fullPension ? 'Full pension' : lastPensionResult.partPension ? 'Part pension' : '');
      setText('pensionDetail',  `~${fmt(ann)}/yr — ${lastPensionResult.binding} test applies`);
    }
  } else {
    setText('pensionStartAge', state.pension.include ? 'Not eligible' : 'Excluded');
    setText('pensionStatus', '');
    setText('pensionDetail', state.pension.include ? '' : 'Enable in Age Pension settings');
  }

  // Key metrics
  const c = state.clients;
  const jFreedom = Math.max(c[0].freedomAge, c[1].freedomAge);
  const oldestNow = Math.min(c[0].currentAge, c[1].currentAge);
  const yearsTo   = Math.max(0, jFreedom - oldestNow);
  const planYears = Math.max(1, planTo - jFreedom);
  const annShort  = gap > 0 ? gap / planYears : 0;

  setText('yearsToRet', yearsTo > 0 ? `${yearsTo} years` : 'Retired');
  setText('yearsFunded', `${yearsFullyFunded} of ${planYears}`);
  setText('annualGap',   annShort > 0 ? fmt(annShort) + '/yr' : 'None ✓');
  setText('safeEarn',    fmt(safeEarnAmount(true)));

  // Pension explainer
  setText('ap_full', fmt(PENSION.assetFull.couple.homeowner));
  setText('ap_cut',  fmt(PENSION.assetCut.couple.homeowner));
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text ?? '—';
}

// ── Calculation workings table ─────────────────────────────────────────────────
let workingsData   = [];
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
  workingsData = [];
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

    // ── Store for CSV ────────────────────────────────────────────────────────
    workingsData.push({ age, phase: phaseLabel, wealth, totalDebt, formula });

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
  const hasDebt = debtNames.length > 0;
  const CUR = '$#,##0';

  function ageLabel(chartAge) {
    const off = chartAge - youngerStart;
    return `${clientStartAges[0] + off}/${clientStartAges[1] + off}`;
  }
  function clientAge(i, chartAge) { return clientStartAges[i] + (chartAge - youngerStart); }

  const validRows = result.rows.filter(r => r.chartAge != null && r.chartAge <= maxAge);
  const accumRows = validRows.filter(r => r.dd == null);
  const drawRows  = validRows.filter(r => r.dd != null);

  const wb = XLSX.utils.book_new();

  // ── Sheet 1: Summary ────────────────────────────────────────────────────────
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
    ['Eligibility age:', state.pension?.pensionAge ?? 67],
    [],
  ];
  if (state.inheritance?.amount > 0) {
    sum.push(['── INHERITANCE', '']);
    sum.push(['Amount:', state.inheritance.amount]);
    sum.push(['Age received (Client 1):', state.inheritance.ageReceived]);
    sum.push(['Destination:', state.inheritance.destination]);
    sum.push(['Apply to debt first:', state.inheritance.applyToDebtFirst ? 'Yes' : 'No']);
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
  sum.push(['Retirement balance at freedom:', result.retirementBalance]);
  sum.push(['Required balance (self-funded, no pension):', result.requiredLump]);
  sum.push(['Funding gap (excl. estate target):', result.gap]);
  sum.push(['Portfolio depletes at age:', result.depletionAge ?? `${planToAge}+ (fully funded)`]);
  sum.push(['Years fully funded:', result.yearsFullyFunded]);
  sum.push(['Age Pension commences:', result.pensionStartAge ? `Age ${result.pensionStartAge}` : 'Not reached']);
  if (result.lastPensionResult) {
    sum.push(['Final year Age Pension (approx):', result.lastPensionResult.annualPension]);
    sum.push(['Pension binding test:', result.lastPensionResult.binding]);
  }

  const ws1 = XLSX.utils.aoa_to_sheet(sum);
  ws1['!cols'] = [{ wch: 42 }, { wch: 28 }, { wch: 20 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'Summary');

  // ── Sheet 2: Accumulation ────────────────────────────────────────────────────
  const aHdr = [
    'Age (C1/C2)', `${c[0].name} Age`, `${c[1].name} Age`,
    'Opening Portfolio',
    `${c[0].name} Salary`, `${c[0].name} Super Balance (closing)`,
    `${c[1].name} Salary`, `${c[1].name} Super Balance (closing)`,
    'Combined SGC', `Return @ ${rPct}%`, 'Contributions & Earnings Tax (15%)',
    'Non-Super Balance', 'Total Portfolio (closing)',
    'Check: Opening + SGC + Return − Tax',
  ];
  const aBody = accumRows.map((row, idx) => {
    const s0 = (row.accum0 ?? 0) + (row.pension0 ?? 0);
    const s1 = (row.accum1 ?? 0) + (row.pension1 ?? 0);
    const prevRow = accumRows[idx - 1];
    const openS0  = prevRow ? ((prevRow.accum0 ?? 0) + (prevRow.pension0 ?? 0)) : (c[0].superBalance ?? 0);
    const openS1  = prevRow ? ((prevRow.accum1 ?? 0) + (prevRow.pension1 ?? 0)) : (c[1].superBalance ?? 0);
    const openNS  = prevRow
      ? Math.max(0, (prevRow.totalWealth ?? 0) - ((prevRow.accum0 ?? 0) + (prevRow.pension0 ?? 0) + (prevRow.accum1 ?? 0) + (prevRow.pension1 ?? 0)))
      : (state.shared.nonSuper ?? 0);
    const opening = openS0 + openS1 + openNS;
    const sgc     = row.sgcTotal    ?? 0;
    const ret     = row.returnAccum ?? 0;
    const tax     = row.taxAccum    ?? 0;
    const nonSuper = Math.max(0, (row.totalWealth ?? 0) - s0 - s1);
    return [
      ageLabel(row.chartAge), clientAge(0, row.chartAge), clientAge(1, row.chartAge),
      opening,
      row.salary0 ?? 0, s0,
      row.salary1 ?? 0, s1,
      sgc, ret, tax,
      nonSuper,
      row.totalWealth ?? 0,
      opening + sgc + ret - tax,  // reconciliation check — should equal Total Portfolio
    ];
  });
  const ws2 = XLSX.utils.aoa_to_sheet([aHdr, ...aBody]);
  ws2['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 10 }, ...Array(11).fill({ wch: 20 })];
  applyColFormat(ws2, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], CUR, aBody.length);
  XLSX.utils.book_append_sheet(wb, ws2, 'Accumulation');

  // ── Sheet 3: Drawdown ────────────────────────────────────────────────────────
  const dHdr = [
    'Age (C1/C2)', `${c[0].name} Age`, `${c[1].name} Age`, 'Retirement Year',
    'Opening Balance', `Return @ ${rPct}%`, 'Desired Income (nominal)',
    'Age Pension', 'Debt Repayments', 'Net Portfolio Draw',
    'Min Drawdown', 'Closing Balance',
    'Pension — Asset Test', 'Pension — Income Test', 'Pension Binding',
    'Notes',
  ];
  const dBody = drawRows.map(row => {
    const pr = row.pension;
    const notes = [
      row.retirementStart ? 'Retirement begins'               : '',
      row.survivorEvent   ? 'Survivor mode — partner deceased' : '',
      row.sequencingShock ? '-25% sequencing shock'            : '',
      row.agedCareSetup   ? 'Aged care reserve set aside'      : '',
    ].filter(Boolean).join('; ');
    return [
      ageLabel(row.chartAge), clientAge(0, row.chartAge), clientAge(1, row.chartAge), row.dd,
      row.startBalance    ?? 0,
      row.grossReturn     ?? 0,
      row.desiredNominal  ?? 0,
      row.pensionIncome   ?? 0,
      row.debtRepaymentYr ?? 0,
      row.drawdownDraw    ?? 0,
      row.minDrawdown     ?? 0,
      row.endBalance      ?? 0,
      pr?.assetPension  ?? 0,
      pr?.incomePension ?? 0,
      pr?.binding       ?? '',
      notes,
    ];
  });
  const ws3 = XLSX.utils.aoa_to_sheet([dHdr, ...dBody]);
  ws3['!cols'] = [
    { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 14 },
    ...Array(8).fill({ wch: 20 }),
    { wch: 18 }, { wch: 18 }, { wch: 14 }, { wch: 35 },
  ];
  applyColFormat(ws3, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13], CUR, dBody.length);
  XLSX.utils.book_append_sheet(wb, ws3, 'Drawdown');

  // ── Sheet 4: Debt Schedule ───────────────────────────────────────────────────
  if (hasDebt) {
    const dbHdr = ['Age (C1/C2)', `${c[0].name} Age`, `${c[1].name} Age`];
    for (const name of debtNames) {
      dbHdr.push(`${name} — Opening`, `${name} — Interest`, `${name} — Repayment`, `${name} — Closing`);
    }
    dbHdr.push('Total Remaining');
    const dbBody = validRows
      .filter(r => r.debtDetails && r.debtDetails.some(d => d.opening > 0 || d.repayment > 0))
      .map(row => {
        const r = [ageLabel(row.chartAge), clientAge(0, row.chartAge), clientAge(1, row.chartAge)];
        for (const d of (row.debtDetails ?? [])) r.push(d.opening, d.interest, d.repayment, d.closing);
        r.push(row.totalDebt ?? 0);
        return r;
      });
    const ws4 = XLSX.utils.aoa_to_sheet([dbHdr, ...dbBody]);
    const dbCols = [{ wch: 12 }, { wch: 10 }, { wch: 10 }];
    debtNames.forEach(() => dbCols.push(...Array(4).fill({ wch: 20 })));
    dbCols.push({ wch: 16 });
    ws4['!cols'] = dbCols;
    const numCols4 = Array.from({ length: dbHdr.length - 3 }, (_, i) => i + 3);
    applyColFormat(ws4, numCols4, CUR, dbBody.length);
    XLSX.utils.book_append_sheet(wb, ws4, 'Debt Schedule');
  }

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
  for (const [color, label] of [['#94a3b8','Min portfolio needed'],['#dc2626','Depletion']]) {
    const wrap = document.createElement('span');
    wrap.className = 'flex items-center';
    const dot  = document.createElement('span');
    dot.className = 'legend-dot';
    dot.style.background = color;
    wrap.appendChild(dot);
    wrap.appendChild(document.createTextNode(label));
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
    { name: 'Client 2', gender: 'female', currentAge: 65, lifeExpectancy: 90, ftIncome: 58000,  ptAge: 66, ptIncome: 80000,  freedomAge: 72, superBalance: 185000, additionalConcessional: 0, downsizer: { active: false, amount: 0 } },
  ],
  shared:      { returnProfile: 'growth', sgcRate: 0.12, nonSuper: 0, desiredIncome: 140000, incomePhases: [{ income: 140000, untilAge: 80 }, { income: 90000, untilAge: null }], planToAge: 90, minDrawdownExcess: 'invest' },
  debts:       [],
  inheritance: { amount: 0, ageReceived: 75, destination: 'nonSuper', applyToDebtFirst: false },
  pension:     { include: false, homeowner: true, pensionAge: 67 },
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
