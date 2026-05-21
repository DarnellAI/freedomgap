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
  for (const [color, label] of [['#94a3b8','Required'],['#dc2626','Depletion']]) {
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
  shared:      { returnProfile: 'growth', sgcRate: 0.12, nonSuper: 0, desiredIncome: 140000, planToAge: 90, minDrawdownExcess: 'invest' },
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
