// Input sidebar renderer — Darnell brand, collapsible sections

import { RETURN_PROFILES } from '../data/parameters.js';
import { calcNetIncome } from '../calc/tax.js';

function dollar(v)  { return v == null ? '' : Math.round(v).toString(); }
function pct(v)     { return v == null ? '' : (v * 100).toFixed(1); }
function age(v)     { return v == null ? '' : Math.round(v).toString(); }

function makeRow(label, control, suffix = '') {
  const div = document.createElement('div');
  div.className = 'field';
  const lbl = document.createElement('label');
  lbl.textContent = label;
  const wrap = document.createElement('div');
  wrap.className = 'control';
  wrap.appendChild(control);
  // Always render suffix span (even if empty) so every row has identical
  // control width and all input right edges land at the same x position
  const s = document.createElement('span');
  s.className = 'suffix';
  s.textContent = suffix;
  wrap.appendChild(s);
  div.appendChild(lbl);
  div.appendChild(wrap);
  return div;
}

function numInput(value, onInput, min = 0, max = 999999999, step = 1) {
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.value = value;
  inp.min = min;
  inp.max = max;
  inp.step = step;
  inp.addEventListener('input', () => onInput(parseFloat(inp.value) || 0));
  return inp;
}

function ageInput(value, onInput) {
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.value = value;
  inp.min = 18;
  inp.max = 120;
  inp.addEventListener('input', () => onInput(parseInt(inp.value, 10) || 0));
  return inp;
}

function pctInput(value, onInput, decimals = 1) {
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.value = value == null ? '' : (value * 100).toFixed(decimals);
  inp.min = 0;
  inp.max = 100;
  inp.step = Math.pow(0.1, decimals);
  inp.addEventListener('input', () => onInput((parseFloat(inp.value) || 0) / 100));
  return inp;
}

function selectInput(options, currentValue, onInput) {
  const sel = document.createElement('select');
  for (const [val, label] of options) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    if (val === currentValue) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => onInput(sel.value));
  return sel;
}

function checkInput(checked, onInput, labelText) {
  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.alignItems = 'center';
  wrap.style.gap = '0.5rem';
  const inp = document.createElement('input');
  inp.type = 'checkbox';
  inp.checked = !!checked;
  inp.addEventListener('change', () => onInput(inp.checked));
  wrap.appendChild(inp);
  if (labelText) {
    const lbl = document.createElement('label');
    lbl.textContent = labelText;
    lbl.style.fontSize = '0.8rem';
    lbl.style.color = '#475569';
    lbl.style.cursor = 'pointer';
    lbl.addEventListener('click', () => { inp.checked = !inp.checked; onInput(inp.checked); });
    wrap.appendChild(lbl);
  }
  return wrap;
}

function subhead(text) {
  const p = document.createElement('p');
  p.className = 'subhead';
  p.textContent = text;
  return p;
}

function fmtK(n) {
  if (!n) return '$0';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${Math.round(n)}`;
}

function netHelp(gross) {
  const p = document.createElement('p');
  p.className = 'help net-help';
  const net = calcNetIncome(gross);
  const tax = gross - net;
  p.textContent = `Net take-home: ~${fmtK(net)}/yr  (tax: ~${fmtK(tax)})`;
  return p;
}

function textInput(value, onInput) {
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = value ?? '';
  inp.addEventListener('input', () => onInput(inp.value));
  return inp;
}

/**
 * Render all input sections into their containers.
 * @param {object} state   - Full state object (mutated in-place by controls)
 * @param {Function} onChange - Called whenever any value changes; triggers recalc
 */
export function renderInputs(state, onChange) {
  renderClientInputs(0, state, onChange);
  renderClientInputs(1, state, onChange);
  renderSharedInputs(state, onChange);
  renderDebtInputs(state, onChange);
  renderInheritanceInputs(state, onChange);
  renderPensionInputs(state, onChange);
  renderAgedCareInputs(state, onChange);
  renderSurvivorInputs(state, onChange);
  renderBequestInputs(state, onChange);
}

function renderClientInputs(idx, state, onChange) {
  const cli = state.clients[idx];
  const container = document.querySelector(`[data-client="${idx}"]`);
  if (!container) return;
  container.innerHTML = '';

  // Sync section header with client name
  const details = container.closest('details');
  const headerSpan = details?.querySelector('summary > span:first-child');
  if (headerSpan) headerSpan.textContent = cli.name || `Client ${idx + 1}`;

  function up(key, val) {
    cli[key] = val;
    // Update header immediately on name change (recalc doesn't re-render inputs)
    if (key === 'name' && headerSpan) {
      headerSpan.textContent = val || `Client ${idx + 1}`;
    }
    onChange();
  }
  function upDz(key, val) { cli.downsizer[key] = val; onChange(); }

  const rows = [
    makeRow('Name (report display)',              textInput(cli.name, v => up('name', v))),
    makeRow('Gender (life expectancy default)',   selectInput([['male','Male'],['female','Female']], cli.gender, v => up('gender', v))),
    makeRow('Current age (today)',               ageInput(cli.currentAge, v => up('currentAge', v)), 'yrs'),
    makeRow('Life expectancy (planning horizon, not a medical prediction)', ageInput(cli.lifeExpectancy, v => up('lifeExpectancy', v)), 'yrs'),
    subhead('Income — gross, before tax. Employer super is paid on top.'),
    makeRow('Full-time income (gross, before tax)',  numInput(cli.ftIncome, v => up('ftIncome', v)), '$/yr'),
    netHelp(cli.ftIncome),
    makeRow('Part-time from age (when hours reduce)', ageInput(cli.ptAge, v => up('ptAge', v)), 'yrs'),
    makeRow('Part-time income (gross at reduced hours)', numInput(cli.ptIncome, v => up('ptIncome', v)), '$/yr'),
    netHelp(cli.ptIncome),
    makeRow('Freedom age (earliest possible retirement)', ageInput(cli.freedomAge, v => up('freedomAge', v)), 'yrs'),
    subhead('Superannuation'),
    makeRow('Super balance (current total, all funds)', numInput(cli.superBalance, v => up('superBalance', v)), '$'),
    makeRow('Extra concessional (salary sacrifice or personal deductible, up to cap)', numInput(cli.additionalConcessional, v => up('additionalConcessional', v)), '$/yr'),
    subhead('Downsizer contribution (from sale of family home, age 55+)'),
    makeRow('Downsizer active',  checkInput(cli.downsizer.active, v => {
      cli.downsizer.active = v;
      renderClientInputs(idx, state, onChange);
      onChange();
    })),
  ];
  if (cli.downsizer.active) {
    rows.push(makeRow('Downsizer amount (max $300k per person)', numInput(cli.downsizer.amount, v => upDz('amount', v)), '$'));
  }
  rows.forEach(r => container.appendChild(r));
}

function renderIncomePhases(state, container, onChange) {
  // Remove any existing phases block and rebuild in place
  let block = container.querySelector('.income-phases-block');
  if (block) block.remove();
  block = document.createElement('div');
  block.className = 'income-phases-block';
  block.style.cssText = 'display:flex;flex-direction:column;gap:.5rem;';

  const s = state.shared;
  if (!s.incomePhases || s.incomePhases.length === 0) {
    s.incomePhases = [{ income: s.desiredIncome ?? 100000, untilAge: null }];
  }
  const phases = s.incomePhases;

  subhead('Retirement income (today\'s dollars)');
  const hdr = document.createElement('p');
  hdr.className = 'subhead';
  hdr.textContent = 'Retirement income (today\'s dollars, excl. debt repayments)';
  block.appendChild(hdr);

  const hint = document.createElement('p');
  hint.className = 'help';
  hint.textContent = 'Add phases to model the go-go / slow-go / no-go spending pattern. Each amount is in today\'s dollars and inflated automatically.';
  block.appendChild(hint);

  phases.forEach((phase, i) => {
    const isLast = i === phases.length - 1;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;';

    const lbl = document.createElement('span');
    lbl.style.cssText = 'font-size:.75rem;color:var(--muted);width:4.5rem;flex-shrink:0;';
    lbl.textContent = `Phase ${i + 1}`;
    row.appendChild(lbl);

    const incInp = numInput(phase.income, v => { phase.income = v; s.desiredIncome = phases[0].income; onChange(); });
    incInp.style.width = '8.5rem';
    row.appendChild(incInp);

    const yrSpan = document.createElement('span');
    yrSpan.style.cssText = 'font-size:.75rem;color:var(--muted);';
    yrSpan.textContent = '/yr';
    row.appendChild(yrSpan);

    if (!isLast) {
      const untilLbl = document.createElement('span');
      untilLbl.style.cssText = 'font-size:.75rem;color:var(--muted);';
      untilLbl.textContent = 'until age';
      row.appendChild(untilLbl);

      const ageInp = ageInput(phase.untilAge ?? 75, v => { phase.untilAge = v; onChange(); });
      ageInp.style.width = '4rem';
      row.appendChild(ageInp);
    } else {
      const onw = document.createElement('span');
      onw.style.cssText = 'font-size:.75rem;color:var(--muted);font-style:italic;';
      onw.textContent = 'onwards';
      row.appendChild(onw);
    }

    if (phases.length > 1) {
      const rm = document.createElement('button');
      rm.textContent = '✕';
      rm.style.cssText = 'margin-left:auto;padding:.15rem .45rem;border:1px solid #fca5a5;border-radius:.35rem;font-size:.7rem;cursor:pointer;color:#dc2626;background:none;';
      rm.addEventListener('click', () => {
        phases.splice(i, 1);
        if (phases.length === 1) phases[0].untilAge = null;
        s.desiredIncome = phases[0].income;
        renderIncomePhases(state, container, onChange);
        onChange();
      });
      row.appendChild(rm);
    }
    block.appendChild(row);
  });

  // Replacement ratio note
  const c = state.clients;
  const combinedNet = calcNetIncome(c[0].ftIncome) + calcNetIncome(c[1].ftIncome);
  const firstIncome = phases[0]?.income ?? 0;
  const ratio = combinedNet > 0 ? (firstIncome / combinedNet * 100).toFixed(0) : '—';
  const replNote = document.createElement('p');
  replNote.className = 'help net-help';
  replNote.textContent = `Combined current net: ~${fmtK(combinedNet)}/yr · Replacement ratio (phase 1): ${ratio}%`;
  block.appendChild(replNote);

  if (phases.length < 3) {
    const addBtn = document.createElement('button');
    addBtn.className = 'scenario-add';
    addBtn.style.marginTop = '.2rem';
    addBtn.textContent = '+ Add income phase';
    addBtn.addEventListener('click', () => {
      const prev = phases[phases.length - 1];
      prev.untilAge = prev.untilAge ?? 75;
      phases.push({ income: Math.round((prev.income ?? 100000) * 0.6), untilAge: null });
      renderIncomePhases(state, container, onChange);
      onChange();
    });
    block.appendChild(addBtn);
  }

  // Insert after the SGC row (second child) — find the right insertion point
  const sgcRow = container.querySelector('[data-field="sgc"]');
  if (sgcRow) sgcRow.after(block);
  else container.appendChild(block);
}

function renderSharedInputs(state, onChange) {
  const s = state.shared;
  const container = document.getElementById('sharedInputs');
  if (!container) return;
  container.innerHTML = '';

  function up(key, val) { s[key] = val; onChange(); }

  const profileOptions = RETURN_PROFILES.map(p => [p.id, `${p.label} (${(p.rate * 100).toFixed(1)}%)`]);

  const sgcRow = makeRow('SGC rate (employer super, legislated 12% from Jul 2025)', pctInput(s.sgcRate, v => up('sgcRate', v)), '%');
  sgcRow.dataset.field = 'sgc';

  const rows = [
    makeRow('Return profile (expected net annual portfolio return)', selectInput(profileOptions, s.returnProfile, v => up('returnProfile', v))),
    sgcRow,
    makeRow('Non-super savings (cash, ETFs, investment property equity, etc.)', numInput(s.nonSuper, v => up('nonSuper', v)), '$'),
    makeRow('Plan to age (projection end — use 90–95 for conservative planning)', ageInput(s.planToAge, v => up('planToAge', v)), 'yrs'),
    subhead('Inflation: fixed at 2.5% · Pension indexation: 2.0%'),
  ];
  rows.forEach(r => container.appendChild(r));
  renderIncomePhases(state, container, onChange);
}

function renderOneDebt(d, i, state, onChange) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'border-top:1px solid var(--border);padding-top:.6rem;display:flex;flex-direction:column;gap:.4rem;';

  function up(key, val) { d[key] = val; onChange(); }

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:.5rem;';
  const nameInp = document.createElement('input');
  nameInp.type = 'text';
  nameInp.value = d.name ?? '';
  nameInp.placeholder = `Debt ${i + 1} (e.g. Home loan)`;
  nameInp.style.cssText = 'flex:1;padding:.3rem .5rem;border:1px solid var(--border);border-radius:.4rem;font-size:.82rem;background:var(--cream);color:var(--ink);';
  nameInp.addEventListener('input', () => up('name', nameInp.value));
  const removeBtn = document.createElement('button');
  removeBtn.textContent = '✕';
  removeBtn.title = 'Remove this debt';
  removeBtn.style.cssText = 'padding:.2rem .55rem;border:1px solid #fca5a5;border-radius:.4rem;font-size:.75rem;cursor:pointer;color:#dc2626;background:none;';
  removeBtn.addEventListener('click', () => {
    state.debts.splice(i, 1);
    renderDebtInputs(state, onChange);
    onChange();
  });
  header.appendChild(nameInp);
  header.appendChild(removeBtn);
  wrap.appendChild(header);

  const freqOpts = [['weekly','Weekly'],['fortnightly','Fortnightly'],['monthly','Monthly'],['annual','Annual']];
  [
    makeRow('Balance (current outstanding)',            numInput(d.balance,   v => up('balance', v)),                       '$'),
    makeRow('Interest rate (annual, e.g. 6.15%)',      pctInput(d.rate,      v => up('rate', v), 2),                       '%'),
    makeRow('Repayment (your regular payment amount)', numInput(d.repayment, v => up('repayment', v), 0, 999999999, 0.01), '$'),
    makeRow('Frequency (how often you repay)',          selectInput(freqOpts, d.frequency ?? 'monthly', v => up('frequency', v))),
  ].forEach(r => wrap.appendChild(r));
  return wrap;
}

function renderDebtInputs(state, onChange) {
  if (!state.debts) state.debts = [];
  const container = document.getElementById('debtInputs');
  if (!container) return;
  container.innerHTML = '';

  const help = document.createElement('p');
  help.className = 'help';
  help.textContent = 'Repayments reduce non-super savings during accumulation and are added on top of desired income in retirement until each debt is cleared.';
  container.appendChild(help);

  if (state.debts.length === 0) {
    const none = document.createElement('p');
    none.className = 'help';
    none.style.fontStyle = 'italic';
    none.textContent = 'No debts added.';
    container.appendChild(none);
  } else {
    state.debts.forEach((d, i) => container.appendChild(renderOneDebt(d, i, state, onChange)));
  }

  if (state.debts.length < 5) {
    const addBtn = document.createElement('button');
    addBtn.className = 'scenario-add';
    addBtn.style.marginTop = '.4rem';
    addBtn.textContent = '+ Add debt';
    addBtn.addEventListener('click', () => {
      state.debts.push({ name: '', balance: 0, rate: 0.06, repayment: 0, frequency: 'monthly' });
      renderDebtInputs(state, onChange);
      onChange();
    });
    container.appendChild(addBtn);
  }
}

function renderInheritanceInputs(state, onChange) {
  const inh = state.inheritance;
  const container = document.getElementById('inheritanceInputs');
  if (!container) return;
  container.innerHTML = '';

  function up(key, val) { inh[key] = val; onChange(); }

  const rows = [
    makeRow('Expected amount (estimated, net of any tax)',       numInput(inh.amount, v => up('amount', v)), '$'),
    makeRow('Received at age (Client 1\'s age when received)',   ageInput(inh.ageReceived, v => up('ageReceived', v)), 'yrs'),
    makeRow('Route to (where proceeds are invested)',            selectInput([['nonSuper','Investments'],['super','Superannuation']], inh.destination, v => up('destination', v))),
  ];
  rows.push(makeRow('Pay off debt first (highest-rate debt cleared before investing)', checkInput(inh.applyToDebtFirst ?? false, v => up('applyToDebtFirst', v))));
  const note = document.createElement('p');
  note.className = 'help';
  note.textContent = 'Pays off outstanding debts (highest rate first) before routing the remainder.';
  rows.push(note);
  rows.forEach(r => container.appendChild(r));
}

function renderPensionInputs(state, onChange) {
  const pen = state.pension;
  const container = document.getElementById('pensionInputs');
  if (!container) return;
  container.innerHTML = '';

  function up(key, val) { pen[key] = val; onChange(); }

  const rows = [
    makeRow('Include Age Pension (add government pension to retirement income)', checkInput(pen.include, v => up('include', v))),
    makeRow('Homeowner (PPOR is exempt from asset test)',                        checkInput(pen.homeowner, v => up('homeowner', v))),
    makeRow('Pension eligible age (currently 67 for most Australians)',          ageInput(pen.pensionAge, v => up('pensionAge', v)), 'yrs'),
  ];
  rows.forEach(r => container.appendChild(r));
}

function renderAgedCareInputs(state, onChange) {
  const ac = state.agedCare;
  const container = document.getElementById('agedCareInputs');
  if (!container) return;
  container.innerHTML = '';

  function up(key, val) { ac[key] = val; onChange(); }

  const helpIntro = document.createElement('p');
  helpIntro.className = 'help';
  helpIntro.textContent = 'Australian residential aged care facilities typically require a Refundable Accommodation Deposit (RAD) — a lump sum lodged upfront, often $500k–$1M+ at premium facilities. When activated, this reserve ring-fences a set amount from the portfolio at a trigger age to model that cost.';
  container.appendChild(helpIntro);

  const rows = [
    makeRow('Model aged care reserve', checkInput(ac.active, v => {
      ac.active = v;
      renderAgedCareInputs(state, onChange);
      onChange();
    })),
  ];
  if (ac.active) {
    rows.push(
      makeRow('RAD / lump sum amount (estimate of upfront deposit required)',     numInput(ac.amount, v => up('amount', v)), '$'),
      makeRow('Trigger age (age at which the reserve is deducted from portfolio)', ageInput(ac.triggerAge, v => up('triggerAge', v)), 'yrs'),
      makeRow('How funds are held (Invested = earns return; RAD bond = 0%)',      selectInput([['invested','Invested (earns return)'],['rad','RAD bond (0% return)']], ac.mode, v => up('mode', v))),
    );
    const helpMode = document.createElement('p');
    helpMode.className = 'help';
    helpMode.textContent = 'Choose "Invested" if funds stay in the portfolio until care is needed. Choose "RAD bond" if they\'re lodged with the facility at 0% — the RAD is refundable to the estate on death. The reserve is excluded from the investment pool but included in total wealth.';
    rows.push(helpMode);
  }
  rows.forEach(r => container.appendChild(r));
}

function renderSurvivorInputs(state, onChange) {
  const surv = state.survivor;
  const container = document.getElementById('survivorInputs');
  if (!container) return;
  container.innerHTML = '';

  function up(key, val) { surv[key] = val; onChange(); }

  const rows = [
    makeRow('Model survivor scenario (financial impact of partner\'s death)', checkInput(surv.active, v => {
      surv.active = v;
      renderSurvivorInputs(state, onChange);
      onChange();
    })),
  ];
  if (surv.active) {
    rows.push(
      makeRow('Survivor expense factor (living costs as % of couple\'s total)', pctInput(surv.expenseFactor, v => up('expenseFactor', v)), '%'),
    );
  }
  const help = document.createElement('p');
  help.className = 'help';
  help.textContent = 'On partner death, super balances merge to survivor within Transfer Balance Cap. Expenses reduce to the set percentage.';
  rows.push(help);
  rows.forEach(r => container.appendChild(r));
}

function renderBequestInputs(state, onChange) {
  const beq = state.bequest;
  const container = document.getElementById('bequestInputs');
  if (!container) return;
  container.innerHTML = '';

  function up(key, val) { beq[key] = val; onChange(); }

  const rows = [
    makeRow('Set an estate target (flags depletion before this amount is reached)', checkInput(beq.active, v => {
      beq.active = v;
      renderBequestInputs(state, onChange);
      onChange();
    })),
  ];
  if (beq.active) {
    rows.push(makeRow('Estate target (minimum balance preserved for beneficiaries)', numInput(beq.amount, v => up('amount', v)), '$'));
    const help = document.createElement('p');
    help.className = 'help';
    help.textContent = 'Depletion is flagged when the portfolio falls below this amount rather than zero — useful for clients wanting to leave a set amount to their estate.';
    rows.push(help);
  }
  rows.forEach(r => container.appendChild(r));
}
