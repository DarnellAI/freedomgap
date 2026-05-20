// Chart.js wrapper — multi-scenario overlay with depletion + retirement markers

let chartInstance = null;

export function initChart(canvasId) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  chartInstance = new Chart(ctx, {
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
 * @param {number} startAge - Older client's age today (x-axis anchor)
 */
export function updateChart(scenarioResults) {
  if (!chartInstance) return;

  // Collect all chart ages to build a unified x-axis
  const allAges = new Set();
  for (const { result } of scenarioResults) {
    for (const row of result.rows) {
      if (row.chartAge != null) allAges.add(row.chartAge);
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

    // Target / required lump sum line (first scenario only)
    if (datasets.length <= 2 && result.requiredLump > 0 && result.freedomAge) {
      const targetData = ages.map(age => {
        if (age < result.freedomAge) return null;
        // Declines at desired income rate post-freedom
        return null; // simplified: just a horizontal reference at freedomAge
      });
      // Draw a simple horizontal target line at freedom age
      const retirementRow = result.rows.find(r => r.retirementStart);
      if (retirementRow) {
        const flatTarget = ages.map(age => age < result.freedomAge ? null : result.requiredLump);
        datasets.push({
          label: 'Required balance',
          data: flatTarget,
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
  }

  // Depletion vertical line
  const firstResult = scenarioResults[0]?.result;
  if (firstResult?.depletionAge) {
    const deplIdx = ages.indexOf(firstResult.depletionAge);
    if (deplIdx >= 0) {
      // Create a tall single-point spike at depletion age
      const depData = ages.map((_, i) => (i === deplIdx ? 2e7 : null));
      datasets.push({
        label: 'Depletion',
        data: depData,
        borderColor: '#dc2626',
        backgroundColor: '#dc262640',
        fill: false,
        pointRadius: 4,
        pointStyle: 'triangle',
        pointBackgroundColor: '#dc2626',
        borderWidth: 0,
        tension: 0,
        spanGaps: false,
      });
    }
  }

  chartInstance.data.labels   = labels;
  chartInstance.data.datasets = datasets;
  chartInstance.update('none');
}
