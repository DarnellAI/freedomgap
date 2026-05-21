// Chart.js wrapper — multi-scenario overlay with depletion + retirement markers


let chartInstance = null;

export function initChart(canvasId) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  chartInstance = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [] },
    plugins: [],
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
  const ages = [...allAges].sort((a, b) => a - b);

  // Dual-age x-axis labels: show both clients' ages at each tick (e.g. "72/71")
  // When birth dates are provided the ages are fractional (e.g. "65.6/64.2")
  const firstRes    = scenarioResults[0]?.result;
  const c0Start     = firstRes?.clientStartAges?.[0];
  const c1Start     = firstRes?.clientStartAges?.[1];
  const youngerStart = firstRes?.youngerStart;
  const frac0       = firstRes?.fractionalStartAges?.[0];
  const frac1       = firstRes?.fractionalStartAges?.[1];
  const hasFrac     = frac0 != null && frac1 != null && youngerStart != null;
  const labels = hasFrac
    ? ages.map(age => {
        const off = age - youngerStart;
        return `${(frac0 + off).toFixed(1)}/${(frac1 + off).toFixed(1)}`;
      })
    : (c0Start != null && c1Start != null && youngerStart != null)
      ? ages.map(age => {
          const off = age - youngerStart;
          return `${c0Start + off}/${c1Start + off}`;
        })
      : ages.map(String);

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

    // Home equity line (estate context — indexed 3% p.a., not investable)
    if ((result.initialHomeValue ?? 0) > 0) {
      const homeData = ages.map(age => {
        const row = result.rows.find(r => r.chartAge === age);
        return row?.homeValue || null;
      });
      datasets.push({
        label: 'Home equity',
        data: homeData,
        borderColor: '#C9A961',
        backgroundColor: 'transparent',
        fill: false,
        tension: 0.2,
        pointRadius: 0,
        pointHoverRadius: 4,
        borderWidth: 2,
        borderDash: [6, 3],
      });
    }

  }

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

  const dc0Start = result.clientStartAges?.[0];
  const dc1Start = result.clientStartAges?.[1];
  const dYounger = result.youngerStart;
  const df0 = result.fractionalStartAges?.[0];
  const df1 = result.fractionalStartAges?.[1];
  debtChartInstance.data.labels = (df0 != null && df1 != null && dYounger != null)
    ? ages.map(age => { const off = age - dYounger; return `${(df0 + off).toFixed(1)}/${(df1 + off).toFixed(1)}`; })
    : (dc0Start != null && dc1Start != null && dYounger != null)
      ? ages.map(age => { const off = age - dYounger; return `${dc0Start + off}/${dc1Start + off}`; })
      : ages.map(String);
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
