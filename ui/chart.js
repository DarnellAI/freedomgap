// Chart.js wrapper — multi-scenario overlay with depletion + retirement markers

import { requiredBalance } from '../calc/core.js';
import { INFLATION } from '../data/parameters.js';

let chartInstance = null;

// Draws the depletion marker as a canvas overlay rather than a data spike,
// so it never inflates the y-axis scale.
const depletionPlugin = {
  id: 'depletionMarker',
  afterDraw(chart) {
    const idx = chart._depletionIdx;
    if (idx == null || idx < 0) return;
    const { ctx, chartArea: { top, bottom }, scales: { x } } = chart;
    const xPos = x.getPixelForTick(idx);
    if (!xPos) return;
    ctx.save();
    // Dashed vertical line
    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(xPos, top);
    ctx.lineTo(xPos, bottom);
    ctx.stroke();
    // Solid downward triangle at the top of the line
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#dc2626';
    ctx.beginPath();
    ctx.moveTo(xPos - 7, top + 1);
    ctx.lineTo(xPos + 7, top + 1);
    ctx.lineTo(xPos, top + 13);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  },
};

export function initChart(canvasId) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  chartInstance = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [] },
    plugins: [depletionPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              if (ctx.datasetIndex === undefined) return '';
              const v = ctx.raw;
              if (v === null || v === undefined) return '';
              return `${ctx.dataset.label}: ${fmtM(v)}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: '#e2e8f0' },
          ticks: { color: '#64748b', font: { size: 11 } },
        },
        y: {
          grid: { color: '#e2e8f0' },
          ticks: {
            color: '#64748b',
            font: { size: 11 },
            callback: v => fmtM(v),
          },
          beginAtZero: true,
        },
      },
    },
  });
  return chartInstance;
}

function fmtM(v) {
  if (v >= 1e6)  return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3)  return `$${(v / 1e3).toFixed(0)}k`;
  return `$${Math.round(v)}`;
}

/**
 * Rebuild chart with all scenario results.
 * @param {Array<{scenario, result, sequencingResult?}>} scenarioResults
 */
export function updateChart(scenarioResults) {
  if (!chartInstance) return;

  // Collect all chart ages, capped at the highest planToAge across scenarios
  const maxPlanToAge = Math.max(...scenarioResults.map(sr => sr.result.planToAge ?? 95));
  const allAges = new Set();
  for (const { result } of scenarioResults) {
    for (const row of result.rows) {
      if (row.chartAge != null && row.chartAge <= maxPlanToAge) allAges.add(row.chartAge);
    }
  }
  const ages   = [...allAges].sort((a, b) => a - b);
  const labels = ages.map(String);

  const datasets = [];

  for (const { scenario, result, sequencingResult } of scenarioResults) {
    if (!scenario.visible) continue;
    const color = scenario.color;

    // Main wealth line
    const wealthData = ages.map(age => {
      const row = result.rows.find(r => r.chartAge === age);
      return row ? row.totalWealth : null;
    });
    datasets.push({
      label: scenario.name,
      data: wealthData,
      borderColor: color,
      backgroundColor: color + '18',
      fill: true,
      tension: 0.35,
      pointRadius: 0,
      pointHoverRadius: 4,
      borderWidth: 2.5,
    });

    // Sequencing stress overlay (dashed)
    if (sequencingResult) {
      const seqData = ages.map(age => {
        const row = sequencingResult.rows.find(r => r.chartAge === age);
        return row ? row.totalWealth : null;
      });
      datasets.push({
        label: `${scenario.name} (stress)`,
        data: seqData,
        borderColor: color,
        backgroundColor: 'transparent',
        fill: false,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 1.5,
        borderDash: [5, 4],
      });
    }

    // Required balance reference line (first scenario only) — declining curve from
    // freedomAge to planToAge, showing how much is needed at each age to fund the
    // remaining income stream. Reaches zero at planToAge.
    if (datasets.length <= 2 && result.requiredLump > 0 && result.freedomAge) {
      const { freedomAge, planToAge: pta, desiredIncome, returnRate } = result;
      const endAge = pta ?? 95;
      const curveData = ages.map(age => {
        if (age < freedomAge) return null;
        const remaining = Math.max(0, endAge - age);
        if (remaining === 0) return 0;
        const nominalIncome = desiredIncome * Math.pow(1 + INFLATION, age - freedomAge);
        return requiredBalance(nominalIncome, returnRate, remaining);
      });
      datasets.push({
        label: 'Required balance',
        data: curveData,
        borderColor: '#94a3b8',
        backgroundColor: 'transparent',
        fill: false,
        borderDash: [8, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0,
      });
    }
  }

  // Depletion marker: stored on the instance and drawn by depletionPlugin.
  // Using a canvas overlay (not a data point) so it never inflates the y-axis.
  const firstResult = scenarioResults[0]?.result;
  chartInstance._depletionIdx = firstResult?.depletionAge
    ? ages.indexOf(firstResult.depletionAge)
    : -1;

  chartInstance.data.labels   = labels;
  chartInstance.data.datasets = datasets;
  chartInstance.update('none');
}

// ── Debt paydown chart ────────────────────────────────────────────────────────

let debtChartInstance = null;

export function initDebtChart(canvasId) {
  const el = document.getElementById(canvasId);
  if (!el) return null;
  debtChartInstance = new Chart(el.getContext('2d'), {
    type: 'line',
    data: { labels: [], datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: c => {
              const v = c.raw;
              return (v == null) ? '' : `${c.dataset.label}: ${fmtM(v)}`;
            },
          },
        },
      },
      scales: {
        x: { grid: { color: '#e2e8f0' }, ticks: { color: '#64748b', font: { size: 11 } } },
        y: {
          grid: { color: '#e2e8f0' },
          ticks: { color: '#64748b', font: { size: 11 }, callback: v => fmtM(v) },
          beginAtZero: true,
        },
      },
    },
  });
  return debtChartInstance;
}

const DEBT_COLORS = ['#1B2A4E', '#C9A961', '#0E7490', '#BE185D', '#64748B'];

export function updateDebtChart(scenarioResults) {
  if (!debtChartInstance) return;

  // Use the first visible scenario that has debt data
  const primary = scenarioResults.find(r => r.result.debtNames?.length > 0) ?? scenarioResults[0];
  const hasDebt = primary?.result.debtNames?.length > 0;

  const section = document.getElementById('debtChartSection');
  if (section) section.classList.toggle('hidden', !hasDebt);

  if (!hasDebt) {
    debtChartInstance.data.labels = [];
    debtChartInstance.data.datasets = [];
    debtChartInstance.update('none');
    updateDebtLegend([]);
    return;
  }

  const { result } = primary;
  const maxAge = result.planToAge ?? 95;
  const ages = [...new Set(
    result.rows.filter(r => r.chartAge != null && r.chartAge <= maxAge && r.debtBalances != null).map(r => r.chartAge)
  )].sort((a, b) => a - b);

  const datasets = result.debtNames.map((name, i) => ({
    label: name || `Debt ${i + 1}`,
    data: ages.map(age => {
      const row = result.rows.find(r => r.chartAge === age);
      return row?.debtBalances?.[i] ?? null;
    }),
    borderColor: DEBT_COLORS[i % DEBT_COLORS.length],
    backgroundColor: DEBT_COLORS[i % DEBT_COLORS.length] + '20',
    fill: true,
    tension: 0.2,
    pointRadius: 0,
    pointHoverRadius: 4,
    borderWidth: 2,
  }));

  debtChartInstance.data.labels = ages.map(String);
  debtChartInstance.data.datasets = datasets;
  debtChartInstance.update('none');
  updateDebtLegend(result.debtNames);
}

function updateDebtLegend(names) {
  const container = document.getElementById('debtChartLegend');
  if (!container) return;
  container.innerHTML = '';
  names.forEach((name, i) => {
    const wrap = document.createElement('span');
    wrap.className = 'flex items-center';
    const dot = document.createElement('span');
    dot.className = 'legend-dot';
    dot.style.background = DEBT_COLORS[i % DEBT_COLORS.length];
    wrap.appendChild(dot);
    wrap.appendChild(document.createTextNode(name || `Debt ${i + 1}`));
    container.appendChild(wrap);
  });
}
