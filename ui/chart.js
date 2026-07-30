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
            afterLabel: ctx => auditLines(ctx),
          },
          bodyFont: { size: 11 },
          bodySpacing: 3,
          boxPadding: 4,
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
  // 999,600 must read as $1.00M, not $1000k — promote before rounding to k
  if (v >= 999500) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3)    return `$${Math.round(v / 1e3)}k`;
  return `$${Math.round(v)}`;
}

// Full-precision dollars for the audit-trail tooltip
function fmtD(v) {
  return `$${Math.round(Math.abs(v)).toLocaleString('en-AU')}`;
}

/**
 * Audit-trail breakdown for the hovered year — mirrors the exported
 * spreadsheet: opening balance, returns, contributions, pension income,
 * drawdown and closing balance, all reconciling to the plotted wealth line.
 */
function auditLines(ctx) {
  const ds = ctx.dataset;
  if (!ds._rows || ctx.raw == null) return '';
  const age = ds._ages?.[ctx.dataIndex];
  const row = ds._rows.find(r => r.chartAge === age);
  if (!row) return '';

  const rPct  = ((ds._rr ?? 0) * 100).toFixed(1);
  const lines = [];

  if (row.dd != null) {
    // ── Drawdown year ──
    const returns  = (row.grossReturn ?? 0) + (row.return0 ?? 0) + (row.return1 ?? 0);
    const sgcGross = (row.sgc0 ?? 0) + (row.sgc1 ?? 0);
    const taxes    = (row.tax0 ?? 0) + (row.tax1 ?? 0);
    lines.push(`  Opening balance: ${fmtD(row.openingWealth ?? row.startBalance ?? 0)}`);
    if ((row.sequencingLoss ?? 0) > 0.5) lines.push(`  − Market fall (−25% stress): ${fmtD(row.sequencingLoss)}`);
    lines.push(`  + Investment return (${rPct}%): ${fmtD(returns)}`);
    if (sgcGross > 0.5)                 lines.push(`  + Super contributions: ${fmtD(sgcGross)}`);
    if (taxes > 0.5)                    lines.push(`  − Contributions tax (15%): ${fmtD(taxes)}`);
    if ((row.pensionIncome ?? 0) > 0.5) lines.push(`  + Age Pension: ${fmtD(row.pensionIncome)}`);
    if ((row.workingNetIncome ?? 0) > 0.5) lines.push(`  + Net salary: ${fmtD(row.workingNetIncome)}`);
    lines.push(`  − Living costs: ${fmtD(row.desiredNominal ?? 0)}`);
    if ((row.debtRepaymentYr ?? 0) > 0.5)  lines.push(`  − Debt repayments: ${fmtD(row.debtRepaymentYr)}`);
    if ((row.inheritanceToPool ?? 0) > 0.5) lines.push(`  + Inheritance: ${fmtD(row.inheritanceToPool)}`);
    if ((row.downsizerAdded ?? 0) > 0.5)   lines.push(`  + Downsizer contribution: ${fmtD(row.downsizerAdded)}`);
    lines.push(`  = Closing balance: ${fmtD(ctx.raw)}`);
    // Net movement for the year: closing − opening (negative = portfolio shrank)
    const net = ctx.raw - (row.openingWealth ?? row.startBalance ?? 0);
    lines.push(`  Net change this year: ${net < 0 ? '−' : '+'}${fmtD(net)}`);
    if ((row.drawdownDraw ?? 0) > 0.5)  lines.push(`  Withdrawn to fund living costs: ${fmtD(row.drawdownDraw)}`);
    else if ((row.surplusSaving ?? 0) > 0.5) lines.push(`  Surplus reinvested: ${fmtD(row.surplusSaving)}`);
    if ((row.minDrawdown ?? 0) > 0.5)   lines.push(`  ATO min drawdown: ${fmtD(row.minDrawdown)}`);
  } else {
    // ── Accumulation year ──
    const returns = (row.returnAccum ?? 0) + (row.nonSuperGrowth ?? 0);
    lines.push(`  Opening balance: ${fmtD(row.openingWealth ?? 0)}`);
    if ((row.sgcTotal ?? 0) > 0.5)      lines.push(`  + Super contributions: ${fmtD(row.sgcTotal)}`);
    lines.push(`  + Investment return (${rPct}%): ${fmtD(returns)}`);
    if ((row.taxAccum ?? 0) > 0.5)      lines.push(`  − Contributions & earnings tax (15%): ${fmtD(row.taxAccum)}`);
    if ((row.debtFromSavings ?? 0) > 0.5) lines.push(`  − Debt repaid from savings: ${fmtD(row.debtFromSavings)}`);
    if ((row.inheritanceToPool ?? 0) > 0.5) lines.push(`  + Inheritance: ${fmtD(row.inheritanceToPool)}`);
    if ((row.downsizerAdded ?? 0) > 0.5)  lines.push(`  + Downsizer contribution: ${fmtD(row.downsizerAdded)}`);
    if ((row.extraSavings ?? 0) > 0.5)    lines.push(`  + Additional savings: ${fmtD(row.extraSavings)}`);
    lines.push(`  = Closing balance: ${fmtD(ctx.raw)}`);
    const net = ctx.raw - (row.openingWealth ?? 0);
    lines.push(`  Net change this year: ${net < 0 ? '−' : '+'}${fmtD(net)}`);
  }

  // Event flags
  if (row.retirementStart)  lines.push('  ★ Retirement begins');
  if (row.partnerJoinsRetirement && !row.retirementStart) lines.push('  ★ Partner joins retirement pool');
  if (row.sequencingShock)  lines.push('  ★ −25% sequencing shock');
  if (row.survivorEvent)    lines.push('  ★ Survivor — partner deceased');
  if (row.agedCareSetup)    lines.push(`  ★ Aged care reserve set aside: ${fmtD(row.agedCareSetup)}`);
  return lines;
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
      _rows: result.rows,
      _ages: ages,
      _rr:   result.returnRate,
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
        _rows: sequencingResult.rows,
        _ages: ages,
        _rr:   sequencingResult.returnRate,
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
