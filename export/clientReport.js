// Client take-home report generator.
//
// Produces a COMPLETELY SELF-CONTAINED html file — inline CSS, inline SVG
// chart, no CDN, no fonts, no fetches — so a client can open it from an email
// attachment on a phone, offline, by double-clicking. This is deliberate:
// the main app's module/CDN architecture cannot run from file://, so the
// export uses none of it.
//
// It renders FROM the freedom-gap engine's projection result. It never
// re-projects: one engine, one set of numbers.
//
// Usage:
//   buildClientReport({ state, result, sequencingResult, solver, meeting })
//     → html string
//
// `meeting` is the adviser-entered record of the review itself:
//   { practice, adviser, reviewDate, householdLabel, intro,
//     actions:    [{ text, owner: 'client'|'practice', done, note }],
//     dates:      [{ date: 'YYYY-MM-DD', title, note }],
//     strategies: [{ title, body, impact }],
//     callUs:     [string],
//     sample:     true  // stamps a SAMPLE ribbon on the page
//   }

import { INFLATION } from '../data/parameters.js?v=202607301634';

// ── branding ─────────────────────────────────────────────────────────────────
// The report is white-labelled: every colour, the wordmark treatment, the
// people listed and the footer details come from a brand record, so one
// generator serves any practice.

export const BRAND_PRESETS = {
  darnell: {
    id: 'darnell',
    name: 'Darnell Consulting',
    shortName: 'Darnell',
    tagline: '',
    wordmarkStyle: 'serif',
    colors: {
      primary: '#1B2A4E', primaryDark: '#101B33',
      accent: '#C9A961', accentDark: '#A8813D',
      page: '#FAF7F0', surface: '#ffffff',
      ink: '#22293a', muted: '#68707f', line: '#e7e2d8',
    },
  },
  aspen: {
    id: 'aspen',
    // Palette sampled from the practice's website header and buttons.
    name: 'Aspen Corporate Financial Planning',
    shortName: 'Aspen',
    tagline: 'Investment · Retirement · Superannuation · Insurance',
    wordmarkStyle: 'caps',
    wordmarkSplit: 2,          // "ASPEN CORPORATE" in blue, the rest in grey
    colors: {
      primary: '#10658C', primaryDark: '#0A4661',
      accent: '#6C9E4C', accentDark: '#4F7736',
      page: '#F2F5F6', surface: '#ffffff',
      ink: '#33383D', muted: '#6E767D', line: '#DFE4E7',
    },
  },
};

function resolveBrand(input) {
  const base = BRAND_PRESETS[input?.preset] ?? BRAND_PRESETS[input?.id] ?? BRAND_PRESETS.darnell;
  const b = { ...base, ...(input || {}) };
  b.colors = { ...base.colors, ...((input && input.colors) || {}) };
  b.people = (input && input.people) || base.people || [];
  b.contact = { ...(base.contact || {}), ...((input && input.contact) || {}) };
  return b;
}

// Wordmark: caps style splits the name so the leading words carry the brand
// colour, matching how most practice logos are set.
function wordmark(brand) {
  const name = brand.name || '';
  if (brand.wordmarkStyle === 'caps') {
    const parts = name.split(' ');
    const n = brand.wordmarkSplit ?? Math.ceil(parts.length / 2);
    const lead = parts.slice(0, n).join(' ');
    const rest = parts.slice(n).join(' ');
    return `<span class="wm-lead">${esc(lead)}</span>${rest ? ` <span class="wm-rest">${esc(rest)}</span>` : ''}`;
  }
  return `${esc(name)}<span class="wm-dot">.</span>`;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function money(v) {
  if (v == null || isNaN(v)) return '—';
  return '$' + Math.round(v).toLocaleString('en-AU');
}
function moneyShort(v) {
  if (v == null || isNaN(v)) return '—';
  const a = Math.abs(v);
  if (a >= 999500) return '$' + (a / 1e6).toFixed(2) + 'M';
  if (a >= 1e3)    return '$' + Math.round(a / 1e3) + 'k';
  return '$' + Math.round(a);
}
function longDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return esc(iso);
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}
function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return esc(iso);
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}
// Small tappable explain mark. Text is plain — no markup.
function info(tip) {
  return `<button class="i" type="button" data-tip="${esc(tip)}" aria-label="What is this?">i</button>`;
}

// ── SVG wealth chart (no library) ────────────────────────────────────────────

function buildChart(result, sequencingResult, C) {
  const planTo = result.planToAge ?? 95;
  const rows = result.rows.filter(r => r.chartAge != null && r.chartAge <= planTo);
  if (rows.length < 2) return '';

  const [c0, c1] = result.clientStartAges ?? [null, null];
  const younger = result.youngerStart ?? rows[0].chartAge;
  const ageLabel = a => (c0 != null && c1 != null)
    ? `${c0 + (a - younger)}/${c1 + (a - younger)}` : String(a);

  const W = 720, H = 330, L = 62, R = 18, T = 18, B = 46;
  const iw = W - L - R, ih = H - T - B;
  const x0 = rows[0].chartAge, x1 = rows[rows.length - 1].chartAge;
  let maxY = Math.max(...rows.map(r => r.totalWealth ?? 0), 1);
  if (sequencingResult) {
    maxY = Math.max(maxY, ...sequencingResult.rows
      .filter(r => r.chartAge != null && r.chartAge <= planTo)
      .map(r => r.totalWealth ?? 0));
  }
  maxY *= 1.06;

  const X = a => L + (a - x0) / Math.max(1, x1 - x0) * iw;
  const Y = v => T + ih - (v / maxY) * ih;

  // nice y step: 1/2/5 × power of ten, aiming for ~4 gridlines
  const rough = maxY / 4, pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 5, 10].map(m => m * pow).find(s => s >= rough);

  let g = '';
  for (let v = step; v < maxY; v += step) {
    g += `<line x1="${L}" y1="${Y(v)}" x2="${W - R}" y2="${Y(v)}" stroke="var(--line)" stroke-width="1"/>`
       + `<text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end" class="ax">${moneyShort(v)}</text>`;
  }
  const firstTick = Math.ceil(x0 / 5) * 5;
  for (let a = firstTick; a <= x1; a += 5) {
    g += `<line x1="${X(a)}" y1="${T + ih}" x2="${X(a)}" y2="${T + ih + 4}" stroke="var(--muted)" opacity="0.5"/>`
       + `<text x="${X(a)}" y="${T + ih + 18}" text-anchor="middle" class="ax">${ageLabel(a)}</text>`;
  }
  g += `<text x="${L + iw / 2}" y="${H - 6}" text-anchor="middle" class="ax axl">Your ages</text>`;

  const pts = rows.map(r => `${X(r.chartAge).toFixed(1)},${Y(r.totalWealth ?? 0).toFixed(1)}`);
  const line = `M${pts.join('L')}`;
  const area = `${line}L${X(x1).toFixed(1)},${Y(0)}L${X(x0).toFixed(1)},${Y(0)}Z`;

  let seq = '';
  if (sequencingResult) {
    const sr = sequencingResult.rows.filter(r => r.chartAge != null && r.chartAge <= planTo);
    const sp = sr.map(r => `${X(r.chartAge).toFixed(1)},${Y(r.totalWealth ?? 0).toFixed(1)}`);
    seq = `<path d="M${sp.join('L')}" fill="none" stroke="var(--warn)" stroke-width="1.6" stroke-dasharray="5 4"/>`;
  }

  // markers: retirement, Age Pension start, depletion
  let marks = '';
  const retA = result.drawdownStartAge;
  if (retA != null && retA >= x0 && retA <= x1) {
    marks += `<line x1="${X(retA)}" y1="${T}" x2="${X(retA)}" y2="${T + ih}" stroke="var(--accent)" stroke-width="1.4" stroke-dasharray="4 4"/>`
           + `<text x="${X(retA) + 5}" y="${T + 12}" class="mk">Retirement</text>`;
  }
  const penRow = rows.find(r => (r.pensionIncome ?? 0) > 0);
  if (penRow) {
    marks += `<circle cx="${X(penRow.chartAge)}" cy="${Y(penRow.totalWealth ?? 0)}" r="4.5" fill="var(--accent)" stroke="#fff" stroke-width="1.5"/>`
           + `<text x="${X(penRow.chartAge) + 7}" y="${Y(penRow.totalWealth ?? 0) - 8}" class="mk">Age Pension starts</text>`;
  }
  if (result.depletionAge != null && result.depletionAge < planTo) {
    const dr = rows.find(r => r.chartAge === result.depletionAge) ?? rows[rows.length - 1];
    marks += `<circle cx="${X(dr.chartAge)}" cy="${Y(dr.totalWealth ?? 0)}" r="4.5" fill="var(--bad)" stroke="#fff" stroke-width="1.5"/>`
           + `<text x="${X(dr.chartAge) - 7}" y="${Y(dr.totalWealth ?? 0) - 10}" text-anchor="end" class="mk mkr">Funds run low</text>`;
  }

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Projected household wealth by age">
    ${g}
    <path d="${area}" fill="var(--primary)" opacity="0.07"/>
    <path d="${line}" fill="none" stroke="var(--primary)" stroke-width="2.6" stroke-linejoin="round"/>
    ${seq}${marks}
    <line x1="${L}" y1="${T + ih}" x2="${W - R}" y2="${T + ih}" stroke="var(--muted)" opacity="0.5"/>
  </svg>`;
}

// ── timeline ────────────────────────────────────────────────────────────────
// Milestones are DERIVED from the projection, so a client always gets a useful
// timeline even when the adviser types nothing. Every entry is a fact of the
// plan (a birthday that unlocks something, a phase change the engine applies),
// never an invented commitment. Adviser-entered dates merge in chronologically.

function buildTimeline(state, result, meeting) {
  const planTo   = result.planToAge ?? 95;
  const younger  = result.youngerStart;
  const starts   = result.clientStartAges ?? [];
  const names    = state.clients.map((c, i) => c.name || `Client ${i + 1}`);
  const reviewYear = meeting.reviewDate
    ? new Date(meeting.reviewDate + 'T00:00:00').getFullYear()
    : new Date().getFullYear();

  if (younger == null || starts.length < 2) return [];

  const items = [];
  const chartAgeWhen = (i, age) => younger + (age - starts[i]);
  const agesAt = ca => starts.map(s => s + (ca - younger)).join(' / ');

  function add(chartAge, title, note) {
    if (chartAge == null || chartAge < younger || chartAge > planTo) return;
    const y = reviewYear + (chartAge - younger);
    items.push({ sort: `${y}-06-30`, when: String(y), sub: `ages ${agesAt(chartAge)}`, title, note });
  }

  const penAge = state.pension?.pensionAge ?? 67;
  state.clients.forEach((cli, i) => {
    if (starts[i] < 60) {
      add(chartAgeWhen(i, 60), `${names[i]}'s super becomes available`,
        'Age 60 — the earliest super can normally be accessed');
    }
    if (starts[i] < cli.freedomAge) {
      add(chartAgeWhen(i, cli.freedomAge), `${names[i]} stops work`,
        `Age ${cli.freedomAge} — the retirement age in this plan`);
    }
    if (state.pension?.include && starts[i] < penAge) {
      add(chartAgeWhen(i, penAge), `${names[i]} reaches Age Pension age`,
        `Age ${penAge} — we lodge the claim about 13 weeks beforehand`);
    }
  });

  if (result.pensionStartAge != null) {
    const amt = result.firstPensionResult?.annualPension;
    add(result.pensionStartAge, 'Age Pension payments begin',
      amt ? `Projected around ${money(amt)} in the first year, rising as your own savings are drawn down` : '');
  }

  const phases = state.shared.incomePhases ?? [];
  phases.forEach((ph, i) => {
    const next = phases[i + 1];
    if (ph.untilAge && next) {
      add(ph.untilAge, `Spending steps to ${money(next.income)} a year`,
        "In today's dollars — the projection indexes it with inflation");
    }
  });

  if (result.depletionAge != null && result.depletionAge < planTo) {
    add(result.depletionAge, 'Savings would be running low here',
      'From this point the Age Pension carries most of your income — this is what the strategies address');
  }

  add(planTo, 'End of the planning horizon',
    `We deliberately plan to age ${planTo}, beyond average life expectancy`);

  // Adviser-entered dates keep their exact day
  for (const d of (meeting.dates ?? [])) {
    if (!d || !d.title) continue;
    items.push({ sort: d.date || '9999', when: d.date ? shortDate(d.date) : '', sub: '', title: d.title, note: d.note || '' });
  }

  items.sort((a, b) => a.sort.localeCompare(b.sort));
  return items;
}

// ── year-by-year table (audit DNA, client-sized) ────────────────────────────

function buildYearTable(result) {
  const planTo = result.planToAge ?? 95;
  const rows = result.rows.filter(r => r.chartAge != null && r.chartAge <= planTo);
  const [c0, c1] = result.clientStartAges ?? [null, null];
  const younger = result.youngerStart ?? (rows[0]?.chartAge ?? 0);
  const body = rows.map(r => {
    const off = r.chartAge - younger;
    const ages = (c0 != null && c1 != null) ? `${c0 + off} / ${c1 + off}` : r.chartAge;
    const real = (r.totalWealth ?? 0) / Math.pow(1 + INFLATION, r.t - 1);
    return `<tr>
      <td>${ages}</td>
      <td>${r.dd ? 'Drawing down' : 'Building up'}</td>
      <td class="n">${money(r.totalWealth)}</td>
      <td class="n">${money(real)}</td>
    </tr>`;
  }).join('');
  return `<table>
    <thead><tr>
      <th>Your ages</th><th>Phase</th>
      <th class="n">Balance ${info('The projected value of your combined super and savings at the end of that year, in the dollars of that year.')}</th>
      <th class="n">In today's dollars ${info(`The same balance adjusted for inflation at ${(INFLATION * 100).toFixed(1)}% a year — what it would feel like in today's money.`)}</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

// ── main builder ─────────────────────────────────────────────────────────────

export function buildClientReport({ state, result, sequencingResult = null, solver = null, meeting = {}, brand: brandIn = null }) {
  const brand    = resolveBrand(brandIn ?? meeting.brand ?? { name: meeting.practice });
  const C        = brand.colors;
  const planTo   = result.planToAge ?? 95;
  const names    = state.clients.map(c => c.name || 'Client');
  const household = meeting.householdLabel || names.join(' & ');
  const practice = brand.name || meeting.practice || 'Darnell Consulting';
  const adviser  = meeting.adviser || '';

  // Directors / advisers strip under the wordmark
  const people = (brand.people || []).filter(p => p && p.name);
  const peopleHtml = people.length
    ? `<div class="people">${people.map(p =>
        `<b>${esc(p.name)}</b>${p.title ? ` — ${esc(p.title)}` : ''}`).join(' &nbsp;·&nbsp; ')}</div>`
    : '';

  // Footer contact line
  const ct = brand.contact || {};
  const contactBits = [ct.phone, ct.email, ct.web, ct.address].filter(Boolean).map(esc);
  const licenceBits = [brand.afsl, brand.licensee].filter(Boolean).map(esc);
  const funded   = result.depletionAge == null || result.depletionAge >= planTo;
  const phases   = state.shared.incomePhases?.length
    ? state.shared.incomePhases
    : [{ income: state.shared.desiredIncome ?? 0, untilAge: null }];

  const reportId = 'dc-' + (household + '|' + (meeting.reviewDate || '')).toLowerCase().replace(/[^a-z0-9]+/g, '-');

  // status
  const statusClass = funded ? 'good' : (planTo - result.depletionAge <= 5 ? 'warn' : 'bad');
  const heroBig = funded
    ? `Your money is projected to last beyond age ${planTo}`
    : `Your money is projected to last to age ${result.depletionAge}`;
  const heroSub = funded
    ? `That covers your plan all the way to age ${planTo} — the age we plan to, deliberately beyond average life expectancy.`
    : `Your plan runs to age ${planTo}, so we are ${planTo - result.depletionAge} year${planTo - result.depletionAge === 1 ? '' : 's'} short. The strategies below are how we close that.`;

  // pension line
  const pen = result.firstPensionResult;
  const penTile = result.pensionStartAge
    ? { v: money(pen?.annualPension) + '/yr', n: `expected from age ${result.pensionStartAge}${pen?.fullPension ? ' (full rate)' : ' (part pension, growing over time)'}` }
    : { v: state.pension?.include ? 'Later' : 'Not counted', n: state.pension?.include ? 'no entitlement expected within this plan' : 'excluded from this projection at your request' };

  // savings tile from solver
  let saveTile = null;
  if (solver) {
    if (solver.alreadyMet)      saveTile = { v: '$0', n: 'no extra saving needed — you are on track' };
    else if (solver.unreachable) saveTile = { v: 'Talk to us', n: 'saving alone cannot close this gap — we will look at other levers' };
    else saveTile = { v: money(solver.monthly) + '/mo', n: `${money(solver.totalAnnual)}/yr for the next ${solver.years} years keeps you funded to ${planTo}` };
  }

  const incomeStr = phases.length === 1
    ? `${money(phases[0].income)}/yr`
    : phases.map((p, i) => `${money(p.income)}${p.untilAge ? ` to age ${p.untilAge}` : ' after that'}`).join(' · ');

  // meeting content
  const actions = meeting.actions ?? [];
  // (adviser dates are merged into the derived timeline by buildTimeline)
  const strategies = meeting.strategies ?? [];
  const callUs  = meeting.callUs ?? [];

  const actionsHtml = actions.map((a, i) => `
    <li>
      <label>
        <input type="checkbox" data-tick="${i}" ${a.done ? 'checked' : ''}>
        <span class="atext">${esc(a.text)}${a.note ? ` <em>— ${esc(a.note)}</em>` : ''}</span>
        <span class="chip ${a.owner === 'client' ? 'you' : 'us'}">${a.owner === 'client' ? 'You' : esc(practice.split(' ')[0])}</span>
      </label>
    </li>`).join('');

  const timeline = buildTimeline(state, result, meeting);
  const timelineHtml = timeline.map(t => `
    <li>
      <span class="dd">${esc(t.when)}${t.sub ? `<em>${esc(t.sub)}</em>` : ''}</span>
      <span class="dt">${esc(t.title)}${t.note ? `<em>${esc(t.note)}</em>` : ''}</span>
    </li>`).join('');

  const strategiesHtml = strategies.map(s => `
    <div class="strat">
      <h3>${esc(s.title)}</h3>
      <p>${esc(s.body)}</p>
      ${s.impact ? `<span class="impact">${esc(s.impact)}</span>` : ''}
    </div>`).join('');

  const callUsHtml = callUs.map(c => `<li>${esc(c)}</li>`).join('');

  const returnPct = ((result.returnRate ?? 0) * 100).toFixed(1);

  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(household)} — Your plan at a glance</title>
<style>
  :root { --page:${C.page}; --surface:${C.surface};
          --primary:${C.primary}; --primary-dark:${C.primaryDark};
          --accent:${C.accent}; --accent-dark:${C.accentDark};
          --ink:${C.ink}; --muted:${C.muted}; --line:${C.line};
          --good:#15803d; --warn:#b45309; --bad:#991b1b;
          /* legacy aliases so every rule below stays brand-driven */
          --cream:var(--page); --navy:var(--primary); --gold:var(--accent); --gold2:var(--accent-dark); }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--page); color:var(--ink);
         font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
         -webkit-text-size-adjust:100%; }
  .wrap { max-width:780px; margin:0 auto; padding:20px 16px 56px; }
  header.brand { padding:10px 2px 16px; margin-bottom:4px; border-bottom:3px solid var(--primary); }
  .brand-top { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap; }
  .wordmark { font-size:1.3rem; font-weight:700; color:var(--primary); line-height:1.15; }
  .wordmark.serif { font-family:Georgia,'Times New Roman',serif; letter-spacing:.01em; }
  .wordmark.caps  { font-size:1.16rem; letter-spacing:.055em; text-transform:uppercase; }
  .wm-rest { color:var(--muted); font-weight:600; }
  .wm-dot  { color:var(--accent-dark); }
  .tagline { font-size:.66rem; letter-spacing:.11em; text-transform:uppercase;
             color:var(--muted); margin-top:5px; }
  .tagline .sq { display:inline-block; width:7px; height:7px; margin-right:4px; vertical-align:.02em; }
  .prep { font-size:.8rem; color:var(--muted); text-align:right; }
  .people { margin-top:11px; padding-top:9px; border-top:1px solid var(--line);
            font-size:.76rem; color:var(--muted); }
  .people b { color:var(--primary); font-weight:600; }
  .card { background:#fff; border-radius:16px; padding:22px 20px;
          box-shadow:0 1px 3px rgba(27,42,78,.08); margin-bottom:16px; }
  h2 { font-size:.78rem; letter-spacing:.08em; text-transform:uppercase;
       color:var(--gold2); margin-bottom:12px; }
  /* hero */
  .hero { border-top:5px solid var(--gold); }
  .pill { display:inline-block; font-size:.72rem; font-weight:700; letter-spacing:.05em;
          text-transform:uppercase; padding:.25rem .7rem; border-radius:2rem; color:#fff; }
  .good .pill { background:var(--good); } .warn .pill { background:var(--warn); }
  .bad  .pill { background:var(--bad); }
  .hero h1 { font-size:1.5rem; line-height:1.25; margin:.6rem 0 .4rem; color:var(--navy); }
  .hero p  { color:var(--muted); font-size:.95rem; }
  /* tiles */
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(158px,1fr)); gap:10px; }
  .tile { background:#fff; border-radius:14px; padding:14px 14px 12px;
          box-shadow:0 1px 3px rgba(27,42,78,.08); }
  .tile .l { font-size:.68rem; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
  .tile .v { font-size:1.28rem; font-weight:700; color:var(--navy); margin:.2rem 0 .1rem; }
  .tile .n { font-size:.72rem; color:var(--muted); line-height:1.4; }
  /* chart */
  svg { width:100%; height:auto; display:block; }
  .ax  { font-size:11px; fill:var(--muted); } .axl { font-size:10px; letter-spacing:.05em; }
  .mk  { font-size:11px; fill:var(--navy); font-weight:600; } .mkr { fill:var(--bad); }
  .legend { display:flex; gap:18px; flex-wrap:wrap; font-size:.75rem; color:var(--muted); margin-top:8px; }
  .legend b { font-weight:600; color:var(--ink); }
  .sw { display:inline-block; width:18px; height:0; border-top:3px solid var(--navy);
        vertical-align:middle; margin-right:6px; border-radius:2px; }
  .sw.stress { border-top:2px dashed var(--warn); }
  /* actions */
  .actions ul { list-style:none; }
  .actions li { border-bottom:1px solid var(--line); }
  .actions li:last-child { border-bottom:none; }
  .actions label { display:flex; align-items:flex-start; gap:12px; padding:11px 2px; cursor:pointer; }
  .actions input { width:1.25rem; height:1.25rem; margin-top:.15rem; accent-color:var(--navy); flex-shrink:0; }
  .atext { flex:1; } .atext em { color:var(--muted); font-style:normal; font-size:.85rem; }
  input:checked ~ .atext { text-decoration:line-through; color:var(--muted); }
  .chip { font-size:.66rem; font-weight:700; letter-spacing:.04em; text-transform:uppercase;
          padding:.18rem .5rem; border-radius:2rem; flex-shrink:0; margin-top:.2rem; }
  .chip.you { background:rgba(201,169,97,.18); color:var(--gold2); }
  .chip.us  { background:rgba(27,42,78,.09); color:var(--navy); }
  /* dates */
  .dates ul { list-style:none; }
  .dates li { display:flex; gap:14px; padding:10px 2px; border-bottom:1px solid var(--line); }
  .dates li:last-child { border-bottom:none; }
  .dd { min-width:104px; font-weight:700; color:var(--navy); font-size:.85rem; }
  .dd em { display:block; font-weight:400; font-style:normal; color:var(--muted); font-size:.72rem; }
  .dt { flex:1; } .dt em { display:block; color:var(--muted); font-style:normal; font-size:.83rem; }
  @media (max-width:460px){ .dates li { flex-direction:column; gap:2px; } .dd { min-width:0; } }
  /* strategies */
  .strat { padding:12px 0; border-bottom:1px solid var(--line); }
  .strat:last-child { border-bottom:none; }
  .strat h3 { font-size:1rem; color:var(--navy); margin-bottom:.25rem; }
  .strat p { font-size:.92rem; color:var(--ink); }
  .impact { display:inline-block; margin-top:.45rem; font-size:.74rem; font-weight:600;
            color:var(--gold2); background:rgba(201,169,97,.14); padding:.2rem .6rem; border-radius:2rem; }
  /* call us */
  .callus ul { list-style:none; columns:2; column-gap:24px; }
  .callus li { break-inside:avoid; padding:5px 0 5px 18px; position:relative; font-size:.92rem; }
  .callus li::before { content:""; position:absolute; left:0; top:.62em; width:8px; height:8px;
                       border-radius:50%; background:var(--gold); }
  @media (max-width:560px){ .callus ul { columns:1; } }
  /* table */
  details { margin-top:6px; }
  summary { cursor:pointer; font-size:.85rem; font-weight:600; color:var(--navy); padding:6px 0; }
  table { width:100%; border-collapse:collapse; font-size:.8rem; margin-top:8px; }
  th { text-align:left; font-size:.66rem; text-transform:uppercase; letter-spacing:.05em;
       color:var(--muted); padding:6px 8px; border-bottom:1px solid var(--line); }
  td { padding:5px 8px; border-bottom:1px solid #f3efe6; }
  th.n, td.n { text-align:right; font-variant-numeric:tabular-nums; }
  /* fine print */
  .fine { font-size:.78rem; color:var(--muted); }
  .fine ul { margin:.4rem 0 .6rem 1.1rem; }
  .fine li { margin-bottom:.2rem; }
  /* explain marks */
  .i { display:inline-flex; align-items:center; justify-content:center; width:15px; height:15px;
       border-radius:50%; border:1px solid var(--gold2); color:var(--gold2); background:none;
       font:italic 700 10px Georgia,serif; cursor:pointer; vertical-align:.12em; margin-left:2px; }
  #pop { position:absolute; z-index:10; max-width:280px; background:var(--navy); color:#fff;
         font-size:.78rem; line-height:1.45; padding:10px 12px; border-radius:10px;
         box-shadow:0 6px 20px rgba(27,42,78,.35); display:none; }
  /* sample ribbon */
  .ribbon { position:fixed; top:14px; right:-42px; transform:rotate(38deg); z-index:20;
            background:var(--warn); color:#fff; font-size:.7rem; font-weight:800;
            letter-spacing:.18em; padding:.3rem 3rem; opacity:.92; pointer-events:none; }
  footer { text-align:center; color:var(--muted); font-size:.75rem; margin-top:22px; }
  @media print {
    body { background:#fff; } .card,.tile { box-shadow:none; border:1px solid var(--line); }
    .i,.ribbon { display:none; } details { open:true; }
  }
</style>
</head>
<body>
${meeting.sample ? '<div class="ribbon">SAMPLE</div>' : ''}
<div class="wrap">

  <header class="brand">
    <div class="brand-top">
      <div>
        <div class="wordmark ${brand.wordmarkStyle === 'caps' ? 'caps' : 'serif'}">${wordmark(brand)}</div>
        ${brand.tagline ? `<div class="tagline">
          <span class="sq" style="background:var(--primary)"></span><span class="sq" style="background:var(--accent)"></span><span class="sq" style="background:var(--muted)"></span>
          ${esc(brand.tagline)}</div>` : ''}
      </div>
      <div class="prep">Prepared for <b>${esc(household)}</b><br>
        ${meeting.reviewDate ? `Review of ${longDate(meeting.reviewDate)}` : ''}${adviser ? ` · with ${esc(adviser)}` : ''}</div>
    </div>
    ${peopleHtml}
  </header>

  <div class="card hero ${statusClass}">
    <span class="pill">${funded ? 'On track' : 'Needs attention'}</span>
    <h1>${heroBig}</h1>
    <p>${heroSub}</p>
    ${meeting.intro ? `<p style="margin-top:.6rem">${esc(meeting.intro)}</p>` : ''}
  </div>

  <div class="tiles" style="margin-bottom:16px">
    <div class="tile">
      <div class="l">Retirement income ${info("The yearly income your plan is built around, in today's dollars. The projection increases it with inflation every year so your buying power stays the same.")}</div>
      <div class="v">${esc(incomeStr)}</div>
      <div class="n">in today's dollars, indexed with inflation</div>
    </div>
    <div class="tile">
      <div class="l">At retirement ${info('Your combined super and savings projected to the year you have both stopped work, in the dollars of that year.')}</div>
      <div class="v">${moneyShort(result.retirementBalance)}</div>
      <div class="n">projected combined balance</div>
    </div>
    <div class="tile">
      <div class="l">Age Pension ${info('The government Age Pension your household is projected to receive, based on the assets and income tests. It usually grows as your own savings are drawn down.')}</div>
      <div class="v">${penTile.v}</div>
      <div class="n">${penTile.n}</div>
    </div>
    ${saveTile ? `<div class="tile">
      <div class="l">Extra saving needed ${info('The additional amount to put away, starting now, for your money to last to the plan-to age. Calculated by the same projection as the chart.')}</div>
      <div class="v">${saveTile.v}</div>
      <div class="n">${saveTile.n}</div>
    </div>` : ''}
  </div>

  <div class="card">
    <h2>Your wealth over time ${info('Each point is your projected combined super and savings at that age. The gold dashed line marks retirement; the dot marks where the Age Pension begins.')}</h2>
    ${buildChart(result, sequencingResult, brand.colors)}
    <div class="legend">
      <span><span class="sw"></span><b>Your projection</b></span>
      ${sequencingResult ? `<span><span class="sw stress"></span><b>Stress test</b> — a 25% market fall in your first retired year</span>` : ''}
    </div>
    <details>
      <summary>The numbers behind the chart</summary>
      ${buildYearTable(result)}
    </details>
  </div>

  ${strategies.length ? `<div class="card">
    <h2>What we agreed ${info('The strategies from your review — what we are doing and why it helps.')}</h2>
    ${strategiesHtml}
  </div>` : ''}

  ${actions.length ? `<div class="card actions">
    <h2>Your action list ${info('Tick things off as you go — ticks are saved on this device. Items marked with our name are ours to do.')}</h2>
    <ul>${actionsHtml}</ul>
  </div>` : ''}

  ${timeline.length ? `<div class="card dates">
    <h2>Your timeline ${info('The milestones in your plan — when super becomes available, when work stops, when the Age Pension starts, and anything specific we agreed. Dates come from your plan, not from a calendar of averages.')}</h2>
    <ul>${timelineHtml}</ul>
  </div>` : ''}

  ${callUs.length ? `<div class="card callus">
    <h2>Call us before deciding, if… ${info('Life events that change the plan. A quick call first usually saves money — and sometimes a lot of tax.')}</h2>
    <ul>${callUsHtml}</ul>
  </div>` : ''}

  <div class="card fine">
    <h2>How this projection works</h2>
    <p>Every figure on this page comes from one projection, run with these assumptions:</p>
    <ul>
      <li>Investment return: <b>${returnPct}% a year</b> after fees and fund tax, every year — real markets move around this.</li>
      <li>Inflation: <b>${(INFLATION * 100).toFixed(1)}% a year</b>. Your target income rises with it; the plan runs to age <b>${planTo}</b>.</li>
      <li>Age Pension: current rates and thresholds${state.pension?.include ? ', indexed at 2% a year, applied with the assets and income tests each year' : ' — excluded from this projection at your request'}.</li>
      <li>Tax: 2025–26 personal rates; 15% on super contributions and accumulation earnings; pension-phase earnings tax-free.</li>
      <li>Super stays preserved until age 60, and a full year of income is drawn each retired year.</li>
    </ul>
    <p>A projection is a structured "what if", not a promise — small changes in returns move the outcome by years, which is why we review it together ${meeting.reviewCycle ? esc(meeting.reviewCycle) : 'every year'}. This page is general information prepared for you from your review${adviser ? ` by ${esc(adviser)}` : ''}; it is not a Statement of Advice. Please keep this file private — it contains your financial details.</p>
  </div>

  <footer>
    <div><b>${esc(practice)}</b>${contactBits.length ? ' · ' + contactBits.join(' · ') : ''}</div>
    ${licenceBits.length ? `<div style="margin-top:3px">${licenceBits.join(' · ')}</div>` : ''}
    <div style="margin-top:3px">Prepared ${meeting.reviewDate ? longDate(meeting.reviewDate) : ''} · Open this file any time — it works offline.</div>
  </footer>
</div>

<div id="pop" role="tooltip"></div>
<script>
(function () {
  // action ticks — saved on this device only
  var KEY = ${JSON.stringify(reportId)};
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) {}
  var boxes = document.querySelectorAll("[data-tick]");
  boxes.forEach(function (b) {
    var k = b.getAttribute("data-tick");
    if (k in saved) b.checked = !!saved[k];
    b.addEventListener("change", function () {
      saved[k] = b.checked;
      try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) {}
    });
  });
  // explain marks
  var pop = document.getElementById("pop"), open = null;
  function close() { pop.style.display = "none"; open = null; }
  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest ? ev.target.closest(".i") : null;
    if (!btn) { close(); return; }
    if (open === btn) { close(); return; }
    pop.textContent = btn.getAttribute("data-tip") || "";
    pop.style.display = "block";
    var r = btn.getBoundingClientRect();
    var w = Math.min(280, window.innerWidth - 24);
    pop.style.maxWidth = w + "px";
    var left = Math.max(12, Math.min(r.left - 20, window.innerWidth - w - 12));
    pop.style.left = left + window.scrollX + "px";
    pop.style.top = r.bottom + 8 + window.scrollY + "px";
    open = btn;
  });
})();
</script>
</body>
</html>`;
}
