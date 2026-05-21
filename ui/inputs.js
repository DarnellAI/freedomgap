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

function numInput(value, onInput, min = 0, max = 999999999) {
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.value = value;
  inp.min = min;
  inp.max = max;
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

function pctInput(value, onInput) {
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.value = pct(value);
  inp.min = 0;
  inp.max = 100;
  inp.step = 0.1;
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
    makeRow('Name',              textInput(cli.name, v => up('name', v))),
    makeRow('Gender',            selectInput([['male','Male'],['female','Female']], cli.gender, v => up('gender', v))),
    makeRow('Current age',       ageInput(cli.currentAge, v => up('currentAge', v)), 'yrs'),
    makeRow('Life expectancy',   ageInput(cli.lifeExpectancy, v => up('lifeExpectancy', v)), 'yrs'),
    subhead('Income (gross — employer super is additional)'),
    makeRow('Full-time income',  numInput(cli.ftIncome, v => up('ftIncome', v)), '$/yr'),
    netHelp(cli.ftIncome),
    makeRow('Part-time from age',ageInput(cli.ptAge, v => up('ptAge', v)), 'yrs'),
    makeRow('Part-time income',  numInput(cli.ptIncome, v => up('ptIncome', v)), '$/yr'),
    netHelp(cli.ptIncome),
    makeRow('Freedom age',       ageInput(cli.freedomAge, v => up('freedomAge', v)), 'yrs'),
    subhead('Superannuation'),
    makeRow('Super balance',     numInput(cli.superBalance, v => up('superBalance', v)), '$'),
    makeRow('Extra concessional',numInput(cli.additionalConcessional, v => up('additionalConcessional', v)), '$/yr'),
    subhead('Downsizer contribution'),
    makeRow('Downsizer active',  checkInput(cli.downsizer.active, v => upDz('active', v))),
  ];
  if (cli.downsizer.active) {
    rows.push(makeRow('Downsizer amount', numInput(cli.downsizer.amount, v => upDz('amount', v)), '$'));
  }
  rows.forEach(r => container.appendChild(r));
}

function renderSharedInputs(state, onChange) {
  const s = state.shared;
  const container = document.getElementById('sharedInputs');
  if (!container) return;
  container.innerHTML = '';

  function up(key, val) { s[key] = val; onChange(); }

  const profileOptions = RETURN_PROFILES.map(p => [p.id, `${p.label} (${(p.rate * 100).toFixed(1)}%)`]);

  // Replacement ratio: desired retirement income vs combined current net pay
  const c = state.clients;
  const netFt0 = calcNetIncome(c[0].ftIncome);
  const netFt1 = calcNetIncome(c[1].ftIncome);
  const combinedNet = netFt0 + netFt1;
  const ratio = combinedNet > 0 ? (s.desiredIncome / combinedNet * 100).toFixed(0) : '—';
  const replNote = document.createElement('p');
  replNote.className = 'help net-help';
  replNote.textContent = `Combined current net: ~${fmtK(combinedNet)}/yr · Replacement ratio: ${ratio}%`;

  const rows = [
    makeRow('Return profile',      selectInput(profileOptions, s.returnProfile, v => up('returnProfile', v))),
    makeRow('SGC rate',            pctInput(s.sgcRate, v => up('sgcRate', v)), '%'),
    makeRow('Desired income',      numInput(s.desiredIncome, v => up('desiredIncome', v)), '$/yr'),
    replNote,
    (() => { const p = document.createElement('p'); p.className = 'help'; p.textContent = 'Excludes debt repayments — these are added on top automatically.'; return p; })(),
    makeRow('Non-super savings',   numInput(s.nonSuper, v => up('nonSuper', v)), '$'),
    makeRow('Plan to age',         ageInput(s.planToAge, v => up('planToAge', v)), 'yrs'),
    subhead('Inflation: fixed at 2.5%'),
  ];
  rows.forEach(r => container.appendChild(r));
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
    makeRow('Balance',       numInput(d.balance,   v => up('balance', v)),   '$'),
    makeRow('Interest rate', pctInput(d.rate,      v => up('rate', v)),      '%'),
    makeRow('Repayment',     numInput(d.repayment, v => up('repayment', v)), '$'),
    makeRow('Frequency',     selectInput(freqOpts, d.frequency ?? 'monthly', v => up('frequency', v))),
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
    makeRow('Expected amount',      numInput(inh.amount, v => up('amount', v)), '$'),
    makeRow('Received at age',      ageInput(inh.ageReceived, v => up('ageReceived', v)), 'yrs'),
    makeRow('Route to',             selectInput([['nonSuper','Investments'],['super','Superannuation']], inh.destination, v => up('destination', v))),
  ];
  if ((state.debts ?? []).some(d => d.balance > 0)) {
    rows.push(makeRow('Pay off debt first', checkInput(inh.applyToDebtFirst ?? false, v => up('applyToDebtFirst', v))));
    const note = document.createElement('p');
    note.className = 'help';
    note.textContent = 'Pays off outstanding debts (highest rate first) before routing the remainder.';
    rows.push(note);
  }
  rows.forEach(r => container.appendChild(r));
}

function renderPensionInputs(state, onChange) {
  const pen = state.pension;
  const container = document.getElementById('pensionInputs');
  if (!container) return;
  container.innerHTML = '';

  function up(key, val) { pen[key] = val; onChange(); }

  const rows = [
    makeRow('Include Age Pension',  checkInput(pen.include, v => up('include', v))),
    makeRow('Homeowner',            checkInput(pen.homeowner, v => up('homeowner', v))),
    makeRow('Pension eligible age', ageInput(pen.pensionAge, v => up('pensionAge', v)), 'yrs'),
  ];
  rows.forEach(r => container.appendChild(r));
}

function renderAgedCareInputs(state, onChange) {
  const ac = state.agedCare;
  const container = document.getElementById('agedCareInputs');
  if (!container) return;
  container.innerHTML = '';

  function up(key, val) { ac[key] = val; onChange(); }

  const rows = [
    makeRow('Reserve for aged care', checkInput(ac.active, v => up('active', v))),
  ];
  if (ac.active) {
    rows.push(
      makeRow('Amount reserved',  numInput(ac.amount, v => up('amount', v)), '$'),
      makeRow('From age',         ageInput(ac.triggerAge, v => up('triggerAge', v)), 'yrs'),
      makeRow('Treatment',        selectInput([['invested','Invested (earns return)'],['rad','RAD bond (0% return)']], ac.mode, v => up('mode', v))),
    );
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
    makeRow('Model survivor scenario', checkInput(surv.active, v => up('active', v))),
  ];
  if (surv.active) {
    rows.push(
      makeRow('Survivor expense factor', pctInput(surv.expenseFactor, v => up('expenseFactor', v)), '%'),
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
    makeRow('Set bequest goal',   checkInput(beq.active, v => up('active', v))),
  ];
  if (beq.active) {
    rows.push(makeRow('Target bequest', numInput(beq.amount, v => up('amount', v)), '$'));
    const help = document.createElement('p');
    help.className = 'help';
    help.textContent = 'Depletion is flagged when balance falls below this amount, not zero.';
    rows.push(help);
  }
  rows.forEach(r => container.appendChild(r));
}
