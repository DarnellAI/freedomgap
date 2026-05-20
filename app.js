/* Freedom Gap Calculator
   Single-page client-side webapp. All maths in the browser. */

/* ---------- 1. CONSTANTS (Age Pension, March 2026 figures) ---------- */
const PENSION = {
  asAt: "20 March 2026",
  eligibleAge: 67,
  maxAnnualCouple: 47070,        // combined max (incl. supplements)
  maxFortnightlyCouple: 1810.40, // combined
  // Asset test (couple combined)
  assetFull: { homeowner: 481500, nonHomeowner: 739500 },
  assetCut:  { homeowner: 1085000, nonHomeowner: 1343000 },
  taperPerThousand: 78, // $3/fn per $1,000 over → $78/yr per $1,000
  // Income test (couple)
  incomeFreeAreaPF: 380,         // fortnightly
  incomeTaper: 0.5,              // 50c/$ over
  // Deeming (couple combined)
  deemThresholdCouple: 106200,
  deemLow: 0.0125,
  deemHigh: 0.0325,
  // Work Bonus
  workBonusPF: 300,              // per person
};

const SUPER_TAX = 0.15;          // applied to contributions + accumulation returns (matches source spreadsheet's convention)
const CONCESSIONAL_CAP = 30000;  // 2026 concessional cap
const NCC_CAP = 120000;          // non-concessional yearly cap
const NCC_BRINGFWD3 = 360000;    // bring-forward 3-year cap

/* ---------- 2. DEFAULT STATE ---------- */
const DEFAULTS = {
  clients: [
    { name: "Client 1", currentAge: 66, ftIncome: 165000, ptAge: 67, ptIncome: 60000,
      freedomAge: 72, superBalance: 290000, additionalConcessional: 0, superReturn: 0.06 },
    { name: "Client 2", currentAge: 65, ftIncome: 58000,  ptAge: 66, ptIncome: 80000,
      freedomAge: 72, superBalance: 185000, additionalConcessional: 0, superReturn: 0.06 },
  ],
  shared: {
    inflation: 0.02,
    sgcRate: 0.12,
    nonSuper: 0,
    additionalInvestment: 0,
    investReturn: 0.055,
    drawdownReturn: 0.055,
    desiredIncome: 140000,
    planToAge: 90,
  },
  debt: { balance: 0, rate: 0.06, annualPayment: 0, fromCashflow: true },
  inheritance: { amount: 0, ageReceived: 75, destination: "nonSuper" /* "super" | "nonSuper" */ },
  pension: { include: true, homeowner: true, pensionAge: 67 },
};

let state = structuredClone(DEFAULTS);

/* ---------- 3. PROJECTION ENGINE ---------- */

/** One year of super, accumulation phase (15% tax on contribs and returns).
 *  Returns earned on opening balance + half-year on contributions (matches spreadsheet). */
function accumulateSuper(opening, salary, sgcRate, addConcessional, returnRate) {
  const contribGross = salary * sgcRate + addConcessional;
  // Cap concessional contributions
  const contribCapped = Math.min(contribGross, CONCESSIONAL_CAP);
  const grossReturn = (opening + contribCapped / 2) * returnRate;
  const tax = (contribCapped + grossReturn) * SUPER_TAX;
  const closing = opening + contribCapped + grossReturn - tax;
  return { closing, contribGross: contribCapped, grossReturn, tax };
}

/** Super post-freedom (no contributions). Spreadsheet still applies 15% to returns. */
function compoundSuperPostWork(opening, returnRate) {
  const grossReturn = opening * returnRate;
  const tax = grossReturn * SUPER_TAX;
  return { closing: opening + grossReturn - tax, grossReturn, tax };
}

/** Personal income tax (FY25/26 resident scale). Approximate. */
function personalIncomeTax(taxable) {
  if (taxable <= 18200) return 0;
  if (taxable <= 45000) return (taxable - 18200) * 0.19;
  if (taxable <= 135000) return 5092 + (taxable - 45000) * 0.30;
  if (taxable <= 190000) return 32092 + (taxable - 135000) * 0.37;
  return 52442 + (taxable - 190000) * 0.45;
}

/** Calculate annual Age Pension (combined for couple). */
function calcAgePension(assessableAssets, financialAssets, employmentIncome) {
  // Asset test
  const cutoff = state.pension.homeowner ? PENSION.assetCut.homeowner : PENSION.assetCut.nonHomeowner;
  const full   = state.pension.homeowner ? PENSION.assetFull.homeowner : PENSION.assetFull.nonHomeowner;
  let assetPension;
  if (assessableAssets <= full) assetPension = PENSION.maxAnnualCouple;
  else if (assessableAssets >= cutoff) assetPension = 0;
  else {
    const over = assessableAssets - full;
    const reduction = (over / 1000) * PENSION.taperPerThousand;
    assetPension = Math.max(0, PENSION.maxAnnualCouple - reduction);
  }
  // Income test
  // Deemed income on financial assets
  const lowChunk = Math.min(financialAssets, PENSION.deemThresholdCouple);
  const highChunk = Math.max(0, financialAssets - PENSION.deemThresholdCouple);
  const deemed = lowChunk * PENSION.deemLow + highChunk * PENSION.deemHigh;
  // Work bonus: each partner up to $300/fortnight ignored. Assume employment income equally split or zero in retirement.
  const workBonusAnnualCouple = PENSION.workBonusPF * 2 * 26; // $15,600
  const employmentAfterBonus = Math.max(0, employmentIncome - workBonusAnnualCouple);
  const assessedIncome = deemed + employmentAfterBonus;
  const incomeFreeAnnual = PENSION.incomeFreeAreaPF * 26;
  let incomePension;
  if (assessedIncome <= incomeFreeAnnual) incomePension = PENSION.maxAnnualCouple;
  else incomePension = Math.max(0, PENSION.maxAnnualCouple - (assessedIncome - incomeFreeAnnual) * PENSION.incomeTaper);
  return { annual: Math.min(assetPension, incomePension), assetPension, incomePension, deemed };
}

/** Required lump sum at retirement to fund desired income (growing annuity).
 *  Uses annuity-due convention (payment at start of year) to match source spreadsheet. */
function requiredBalance(desiredIncome, inflation, drawdownReturn, years) {
  const g = inflation, r = drawdownReturn;
  if (years <= 0) return 0;
  if (Math.abs(r - g) < 1e-9) return desiredIncome * years * (1 + r);
  const ratio = (1 + g) / (1 + r);
  return desiredIncome * (1 + r) * (1 - Math.pow(ratio, years)) / (r - g);
}

/** Main projection. Runs year-by-year up to planToAge for the older client. */
function runProjection() {
  const c = state.clients;
  const s = state.shared;
  const ages0 = c[0].currentAge, ages1 = c[1].currentAge;
  const olderStart = Math.min(ages0, ages1);
  const totalYears = Math.max(50, state.shared.planToAge - olderStart + 5);

  // Per-client running state
  const cs = c.map(x => ({
    age: x.currentAge,
    super: x.superBalance,
    retiredYear: null,
    superAtFreedom: null,
  }));

  let invest = s.nonSuper;             // non-super investments
  let debt = state.debt.balance;
  let drawdownStarted = false;
  let drawdownYearIndex = 0;            // 1-based once started
  let combinedBalance = null;          // set when both retire
  let depletionAge = null;             // last C1 age with a positive year-end balance before depletion
  let lastPositiveAge = null;          // tracker
  let yearsFullyFunded = 0;             // drawdown years where end balance can fund next year's income
  let inheritanceApplied = false;

  const rows = [];

  // Salary growth: we treat year t starting salary = base * (1+inflation)^(t-1) — matches spreadsheet (year 1 uses base, year 2 inflated once, etc.)
  // For PT income, the spreadsheet uses ptIncome at the FIRST PT year then inflates from there.
  // We achieve that by: salaryBase = (age >= ptAge) ? ptIncome : ftIncome, with inflation index = years since that role started.

  for (let t = 1; t <= totalYears; t++) {
    const row = { t, age: [cs[0].age, cs[1].age] };

    // === Pre-retirement / accumulation per client ===
    for (let i = 0; i < 2; i++) {
      const cli = c[i];
      const st  = cs[i];
      if (st.age < cli.freedomAge) {
        const isPT = st.age >= cli.ptAge;
        const baseSalary = isPT ? cli.ptIncome : cli.ftIncome;
        // Inflation index from year 1 (today), not from when role started — matches source spreadsheet.
        const salary = baseSalary * Math.pow(1 + s.inflation, t - 1);
        const acc = accumulateSuper(st.super, salary, s.sgcRate, cli.additionalConcessional, cli.superReturn);
        row[`salary${i}`] = salary;
        row[`contrib${i}`] = acc.contribGross;
        row[`return${i}`] = acc.grossReturn;
        row[`isWorking${i}`] = true;
        row[`isPT${i}`] = isPT;
        st.super = acc.closing;
        // Capture super balance at the moment they reach freedom age (i.e. END of year before)
        // — but the spreadsheet captures it at the START of freedom year (no growth that year).
        // To match: if THIS year they JUST hit freedom age, that opening balance is the freedom balance.
        // Equivalent: if NEXT year they will be >= freedomAge (i.e. this is the last working year), freedom balance = OPENING.
        // Simpler: snapshot opening balance each year; pick the snapshot from the year age==freedomAge-1 isn't quite right either.
        // The spreadsheet uses: super at the BEGINNING of the year in which they retire (age == freedomAge).
        // Since we apply growth at end of year, after the loop completes a year where age==freedomAge they would have grown,
        // but they shouldn't have. We'll instead capture the opening BEFORE growth at the first year age >= freedomAge.
      } else {
        // Past freedom age (or just hit it). If we haven't captured the freedom-balance yet, capture it BEFORE growth.
        if (st.superAtFreedom === null) {
          st.superAtFreedom = st.super;  // this is opening balance at freedom-age year
          st.retiredYear = t;
        }
        const cmp = compoundSuperPostWork(st.super, cli.superReturn);
        row[`salary${i}`] = 0;
        row[`contrib${i}`] = 0;
        row[`return${i}`] = cmp.grossReturn;
        row[`isWorking${i}`] = false;
        row[`isPT${i}`] = false;
        st.super = cmp.closing;
      }
    }

    // === Non-super investment ===
    if (!drawdownStarted) {
      // Returns + additional contributions
      const investReturn = invest * s.investReturn;
      const addInv = s.additionalInvestment;
      // Part-time income shortfall top-up (matches spreadsheet "Part-Time Income Gap Analysis")
      // Combined gross salary this year:
      const grossA = row.salary0 || 0;
      const grossB = row.salary1 || 0;
      const grossCombined = grossA + grossB;
      let topUp = 0;
      if (grossCombined > 0) {
        const taxA = personalIncomeTax(grossA);
        const taxB = personalIncomeTax(grossB);
        const netCombined = grossCombined - taxA - taxB;
        const desiredThisYear = s.desiredIncome * Math.pow(1 + s.inflation, t - 1);
        if (netCombined < desiredThisYear) topUp = desiredThisYear - netCombined;
      }
      row.topUp = topUp;
      // Debt servicing from cashflow: if debt > 0 and fromCashflow, the payment is assumed to come from working income (no impact on invest).
      // If not fromCashflow, the debt payment comes out of non-super investments.
      let investDelta = investReturn + addInv - topUp;
      if (debt > 0) {
        const interest = debt * state.debt.rate;
        const pay = state.debt.annualPayment;
        const reduction = Math.min(debt + interest, pay);
        debt = debt + interest - reduction;
        if (!state.debt.fromCashflow) investDelta -= reduction;
      }
      invest = Math.max(0, invest + investDelta);
      row.invest = invest;
      row.debt = debt;
    }

    // === Inheritance ===
    if (!inheritanceApplied && state.inheritance.amount > 0 && cs[0].age === state.inheritance.ageReceived) {
      if (state.inheritance.destination === "super") {
        // Apply equally to both clients' super, respecting bring-forward NCC. Simplified.
        const half = state.inheritance.amount / 2;
        const cap = NCC_BRINGFWD3; // single year input; advanced rules left out
        const contrib0 = Math.min(half, cap);
        const contrib1 = Math.min(half, cap);
        cs[0].super += contrib0;
        cs[1].super += contrib1;
        const leftover = state.inheritance.amount - contrib0 - contrib1;
        if (leftover > 0) invest += leftover;
      } else {
        invest += state.inheritance.amount;
      }
      row.inheritance = state.inheritance.amount;
      inheritanceApplied = true;
    }

    // === Drawdown ===
    if (drawdownStarted) {
      drawdownYearIndex++;
      const desiredThisYear = s.desiredIncome * Math.pow(1 + s.inflation, drawdownYearIndex - 1);
      // Age Pension this year (combined)
      let pension = { annual: 0 };
      if (state.pension.include) {
        const homeAdj = state.pension.homeowner ? 0 : 0; // family home is exempt anyway
        const assessable = combinedBalance + invest; // super in pension phase IS assessable for age 67+. Family home excluded.
        const financial = combinedBalance + invest;
        pension = calcAgePension(assessable, financial, 0);
      }
      const netDrawdownRequired = Math.max(0, desiredThisYear - pension.annual);
      const grossReturn = combinedBalance * s.drawdownReturn;
      const newBalance = combinedBalance + grossReturn - netDrawdownRequired;
      row.drawdownIncome = desiredThisYear;
      row.pension = pension.annual;
      row.drawn = netDrawdownRequired;
      row.investReturn = grossReturn;
      row.startBalance = combinedBalance;
      row.endBalance = Math.max(0, newBalance);
      if (newBalance > 0) lastPositiveAge = cs[0].age;
      if (newBalance <= 0 && depletionAge === null) {
        depletionAge = lastPositiveAge ?? cs[0].age;
      }
      const nextYearRequired = desiredThisYear * (1 + s.inflation);
      if (newBalance >= nextYearRequired) yearsFullyFunded++;
      combinedBalance = Math.max(0, newBalance);
      row.totalWealth = combinedBalance;
      row.phase = "Retired";
    } else {
      row.totalWealth = cs[0].super + cs[1].super + invest;
      row.phase = (row.isWorking0 || row.isWorking1) ? "Working" : "Retired";
    }

    rows.push(row);

    // === End-of-year transitions ===
    cs[0].age += 1;
    cs[1].age += 1;

    if (!drawdownStarted && cs[0].age >= c[0].freedomAge && cs[1].age >= c[1].freedomAge) {
      // The first year AFTER both have entered freedom = drawdown begins.
      // Spreadsheet convention: combined balance at retirement = each client's freedom-age opening balance.
      const bal0 = cs[0].superAtFreedom ?? cs[0].super;
      const bal1 = cs[1].superAtFreedom ?? cs[1].super;
      combinedBalance = bal0 + bal1 + invest;
      drawdownStarted = true;
    }

    // Stop if reached planToAge
    if (cs[0].age > state.shared.planToAge + 5) break;
  }

  // === Summary ===
  const yearsToRetire = Math.max(c[0].freedomAge - c[0].currentAge, c[1].freedomAge - c[1].currentAge);
  // Required lump sum: PV of growing income stream over (planToAge - retirementAge of older partner) years
  const planYears = Math.max(1, state.shared.planToAge - Math.max(c[0].freedomAge, c[1].freedomAge));
  const requiredLump = requiredBalance(s.desiredIncome, s.inflation, s.drawdownReturn, planYears);
  const retirementBalance = (cs[0].superAtFreedom ?? cs[0].super) + (cs[1].superAtFreedom ?? cs[1].super) + (rows[yearsToRetire - 1]?.invest ?? invest);
  const gap = Math.max(0, requiredLump - retirementBalance);

  return {
    rows,
    yearsToRetire,
    retirementBalance,
    requiredLump,
    gap,
    depletionAge,
    yearsFullyFunded,
  };
}

/* ---------- 4. UI: RENDER INPUTS ---------- */

const fmtMoney = (v) => v == null || isNaN(v) ? "—" : "$" + Math.round(v).toLocaleString();
const fmtMoneyShort = (v) => {
  if (v == null || isNaN(v)) return "—";
  if (Math.abs(v) >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (Math.abs(v) >= 1e3) return "$" + (v / 1e3).toFixed(0) + "k";
  return "$" + Math.round(v);
};
const fmtPct = (v) => (v * 100).toFixed(1) + "%";

function makeField(label, kind, opts) {
  // kind: number, percent, age, money, select, checkbox, range
  const wrap = document.createElement("div");
  wrap.className = "field";
  const lbl = document.createElement("label");
  lbl.textContent = label;
  const ctrl = document.createElement("div");
  ctrl.className = "control";

  let input;
  if (kind === "select") {
    input = document.createElement("select");
    opts.options.forEach(o => {
      const op = document.createElement("option");
      op.value = o.value; op.textContent = o.label;
      input.appendChild(op);
    });
    input.value = opts.value;
    input.addEventListener("change", () => opts.onChange(input.value));
  } else if (kind === "checkbox") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = opts.value;
    input.addEventListener("change", () => opts.onChange(input.checked));
  } else if (kind === "range") {
    // slider with live label
    const labelWrap = document.createElement("div");
    labelWrap.className = "slider-row";
    const lblLine = document.createElement("div");
    lblLine.className = "lbl";
    const lblText = document.createElement("span"); lblText.textContent = label;
    const lblVal  = document.createElement("b");
    lblLine.appendChild(lblText); lblLine.appendChild(lblVal);
    input = document.createElement("input");
    input.type = "range";
    input.min = opts.min; input.max = opts.max; input.step = opts.step ?? 1;
    input.value = opts.value;
    const display = () => lblVal.textContent = (opts.formatter ? opts.formatter(parseFloat(input.value)) : input.value);
    display();
    input.addEventListener("input", () => { display(); opts.onChange(parseFloat(input.value)); });
    labelWrap.appendChild(lblLine);
    labelWrap.appendChild(input);
    return labelWrap; // bypass standard wrapping
  } else if (kind === "text") {
    input = document.createElement("input");
    input.type = "text";
    input.value = opts.value;
    input.addEventListener("input", () => opts.onChange(input.value));
  } else {
    input = document.createElement("input");
    input.type = "number";
    input.value = opts.value;
    if (opts.step) input.step = opts.step;
    if (opts.min != null) input.min = opts.min;
    if (opts.max != null) input.max = opts.max;
    input.addEventListener("input", () => {
      const v = input.value === "" ? 0 : parseFloat(input.value);
      opts.onChange(v);
    });
  }

  ctrl.appendChild(input);
  if (opts.suffix) {
    const sfx = document.createElement("span");
    sfx.className = "suffix";
    sfx.textContent = opts.suffix;
    ctrl.appendChild(sfx);
  }
  wrap.appendChild(lbl);
  wrap.appendChild(ctrl);
  return wrap;
}

function renderClientInputs() {
  document.querySelectorAll("[data-client]").forEach(container => {
    const idx = parseInt(container.dataset.client);
    const cli = state.clients[idx];
    container.innerHTML = "";

    container.appendChild(makeField("Name", "text", {
      value: cli.name, onChange: v => { cli.name = v; }
    }));
    container.appendChild(makeField("Current age", "range", {
      value: cli.currentAge, min: 30, max: 85, step: 1,
      formatter: v => v + " yrs",
      onChange: v => { cli.currentAge = v; recompute(); }
    }));
    container.appendChild(makeField("Full-time income", "money", {
      value: cli.ftIncome, step: 1000, suffix: "/yr",
      onChange: v => { cli.ftIncome = v; recompute(); }
    }));
    container.appendChild(makeField("Part-time start age", "number", {
      value: cli.ptAge, min: cli.currentAge, max: 90, suffix: "yrs",
      onChange: v => { cli.ptAge = v; recompute(); }
    }));
    container.appendChild(makeField("Part-time income", "money", {
      value: cli.ptIncome, step: 1000, suffix: "/yr",
      onChange: v => { cli.ptIncome = v; recompute(); }
    }));
    container.appendChild(makeField("Freedom age (stop work)", "range", {
      value: cli.freedomAge, min: cli.currentAge, max: 90, step: 1,
      formatter: v => v + " yrs",
      onChange: v => { cli.freedomAge = v; recompute(); }
    }));
    container.appendChild(makeField("Super balance now", "money", {
      value: cli.superBalance, step: 1000, suffix: "$",
      onChange: v => { cli.superBalance = v; recompute(); }
    }));
    container.appendChild(makeField("Additional concessional", "money", {
      value: cli.additionalConcessional, step: 500, suffix: "/yr",
      onChange: v => { cli.additionalConcessional = v; recompute(); }
    }));
    container.appendChild(makeField("Super rate of return", "range", {
      value: cli.superReturn * 100, min: 0, max: 12, step: 0.1,
      formatter: v => v.toFixed(1) + "%",
      onChange: v => { cli.superReturn = v / 100; recompute(); }
    }));
  });
}

function renderSharedInputs() {
  const c = document.getElementById("sharedInputs");
  c.innerHTML = "";
  const s = state.shared;
  c.appendChild(makeField("Salary inflation", "range", {
    value: s.inflation * 100, min: 0, max: 8, step: 0.1,
    formatter: v => v.toFixed(1) + "%",
    onChange: v => { s.inflation = v / 100; recompute(); }
  }));
  c.appendChild(makeField("Super guarantee % of salary", "range", {
    value: s.sgcRate * 100, min: 0, max: 15, step: 0.1,
    formatter: v => v.toFixed(1) + "%",
    onChange: v => { s.sgcRate = v / 100; recompute(); }
  }));
  c.appendChild(makeField("Non-super investments (net of debt)", "money", {
    value: s.nonSuper, step: 1000, suffix: "$",
    onChange: v => { s.nonSuper = v; recompute(); }
  }));
  c.appendChild(makeField("Additional investment contributions", "money", {
    value: s.additionalInvestment, step: 500, suffix: "/yr",
    onChange: v => { s.additionalInvestment = v; recompute(); }
  }));
  c.appendChild(makeField("Investment rate of return", "range", {
    value: s.investReturn * 100, min: 0, max: 12, step: 0.1,
    formatter: v => v.toFixed(1) + "%",
    onChange: v => { s.investReturn = v / 100; recompute(); }
  }));
  c.appendChild(makeField("Drawdown rate of return", "range", {
    value: s.drawdownReturn * 100, min: 0, max: 12, step: 0.1,
    formatter: v => v.toFixed(1) + "%",
    onChange: v => { s.drawdownReturn = v / 100; recompute(); }
  }));
  c.appendChild(makeField("Desired retirement income (combined)", "money", {
    value: s.desiredIncome, step: 1000, suffix: "/yr",
    onChange: v => { s.desiredIncome = v; recompute(); }
  }));
  c.appendChild(makeField("Plan to age", "range", {
    value: s.planToAge, min: 75, max: 105, step: 1,
    formatter: v => v + " yrs",
    onChange: v => { s.planToAge = v; recompute(); }
  }));
}

function renderDebtInputs() {
  const c = document.getElementById("debtInputs");
  c.innerHTML = "";
  const d = state.debt;
  c.appendChild(makeField("Opening balance", "money", {
    value: d.balance, step: 1000, suffix: "$",
    onChange: v => { d.balance = v; recompute(); }
  }));
  c.appendChild(makeField("Interest rate", "range", {
    value: d.rate * 100, min: 0, max: 15, step: 0.1,
    formatter: v => v.toFixed(1) + "%",
    onChange: v => { d.rate = v / 100; recompute(); }
  }));
  c.appendChild(makeField("Annual repayment", "money", {
    value: d.annualPayment, step: 1000, suffix: "/yr",
    onChange: v => { d.annualPayment = v; recompute(); }
  }));
  c.appendChild(makeField("Payments come from working cashflow", "checkbox", {
    value: d.fromCashflow,
    onChange: v => { d.fromCashflow = v; recompute(); }
  }));
  const help = document.createElement("p");
  help.className = "help";
  help.innerHTML = "If unticked, debt repayments are drawn from non-super investments.";
  c.appendChild(help);
}

function renderInheritanceInputs() {
  const c = document.getElementById("inheritanceInputs");
  c.innerHTML = "";
  const inh = state.inheritance;
  c.appendChild(makeField("Inheritance amount", "money", {
    value: inh.amount, step: 5000, suffix: "$",
    onChange: v => { inh.amount = v; recompute(); }
  }));
  c.appendChild(makeField("Age (Client 1) when received", "number", {
    value: inh.ageReceived, min: state.clients[0].currentAge, max: 100, suffix: "yrs",
    onChange: v => { inh.ageReceived = v; recompute(); }
  }));
  c.appendChild(makeField("Destination", "select", {
    value: inh.destination, options: [
      { value: "nonSuper", label: "Non-super investments" },
      { value: "super", label: "Super (split, NCC bring-forward)" },
    ],
    onChange: v => { inh.destination = v; recompute(); }
  }));
  const help = document.createElement("p");
  help.className = "help";
  help.innerHTML = `Non-concessional bring-forward cap is $${NCC_BRINGFWD3.toLocaleString()} per person; amounts above are diverted to non-super.`;
  c.appendChild(help);
}

function renderPensionInputs() {
  const c = document.getElementById("pensionInputs");
  c.innerHTML = "";
  const p = state.pension;
  c.appendChild(makeField("Include Age Pension in projection", "checkbox", {
    value: p.include,
    onChange: v => { p.include = v; recompute(); }
  }));
  c.appendChild(makeField("Homeowner", "checkbox", {
    value: p.homeowner,
    onChange: v => { p.homeowner = v; recompute(); }
  }));
  c.appendChild(makeField("Eligible age", "number", {
    value: p.pensionAge, min: 60, max: 75, suffix: "yrs",
    onChange: v => { p.pensionAge = v; recompute(); }
  }));
  const help = document.createElement("p");
  help.className = "help";
  help.innerHTML = `Figures based on the asset and income tests as at <strong>${PENSION.asAt}</strong>. The family home is excluded from the asset test.`;
  c.appendChild(help);
}

/* ---------- 5. RENDER OUTPUTS ---------- */

let chart;

function updateChart(rows, depletionAge) {
  const ctx = document.getElementById("wealthChart").getContext("2d");
  const labels = rows.map(r => r.age[0]);
  const balances = rows.map(r => r.totalWealth);
  const planYears = Math.max(1, state.shared.planToAge - Math.max(state.clients[0].freedomAge, state.clients[1].freedomAge));
  const targetVal = state.shared.desiredIncome
    ? requiredBalance(state.shared.desiredIncome, state.shared.inflation, state.shared.drawdownReturn, planYears)
    : null;
  const target = rows.map(() => targetVal);

  // Depletion marker
  const depletionPoints = rows.map(r => r.age[0] === depletionAge ? r.totalWealth : null);

  // Part-pension threshold
  const homeowner = state.pension.homeowner;
  const fullThreshold = homeowner ? PENSION.assetFull.homeowner : PENSION.assetFull.nonHomeowner;
  const cutoff = homeowner ? PENSION.assetCut.homeowner : PENSION.assetCut.nonHomeowner;

  const datasets = [
    {
      label: "Combined wealth",
      data: balances,
      borderColor: "#0ea5e9",
      backgroundColor: "rgba(14,165,233,0.08)",
      fill: true,
      borderWidth: 2.5,
      pointRadius: 0,
      tension: 0.2,
    },
    {
      label: "Target balance",
      data: target,
      borderColor: "#94a3b8",
      borderDash: [6, 4],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
    },
    {
      label: "Part-pension threshold",
      data: rows.map(() => cutoff),
      borderColor: "#f59e0b",
      borderWidth: 1,
      borderDash: [3, 3],
      pointRadius: 0,
      fill: false,
    },
    {
      label: "Full-pension threshold",
      data: rows.map(() => fullThreshold),
      borderColor: "#22c55e",
      borderWidth: 1,
      borderDash: [3, 3],
      pointRadius: 0,
      fill: false,
    },
    {
      label: "Depletion",
      data: depletionPoints,
      borderColor: "#dc2626",
      backgroundColor: "#dc2626",
      pointRadius: 7,
      pointHoverRadius: 9,
      showLine: false,
    },
  ];

  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => "Age " + items[0].label + " (Client 1)",
            label: (ctx) => ctx.dataset.label + ": " + fmtMoneyShort(ctx.parsed.y),
          }
        }
      },
      scales: {
        x: { title: { display: true, text: "Age (Client 1)" }, grid: { display: false } },
        y: { ticks: { callback: v => fmtMoneyShort(v) }, grid: { color: "#e2e8f0" } },
      }
    }
  });
}

function setRiskCard(depletionAge, planToAge) {
  const card = document.getElementById("riskCard");
  const ageEl = document.getElementById("riskAge");
  const labelEl = document.getElementById("riskLabel");
  const subEl = document.getElementById("riskSubtext");
  card.classList.remove("risk-good", "risk-warn", "risk-bad", "risk-okay");

  if (depletionAge === null) {
    ageEl.textContent = planToAge + "+";
    labelEl.textContent = "fully funded";
    subEl.textContent = `Your wealth funds the full plan to age ${planToAge} and beyond. You're tracking well.`;
    card.classList.add("risk-good");
  } else if (depletionAge >= 90) {
    ageEl.textContent = depletionAge;
    labelEl.textContent = "comfortable";
    subEl.textContent = "Funds last past age 90. Long horizon, low risk of running short.";
    card.classList.add("risk-good");
  } else if (depletionAge >= 80) {
    ageEl.textContent = depletionAge;
    labelEl.textContent = "watch zone";
    subEl.textContent = "Funds run dry between 80 and 89. Consider extending part-time work or trimming income.";
    card.classList.add("risk-warn");
  } else {
    ageEl.textContent = depletionAge;
    labelEl.textContent = "at risk";
    subEl.textContent = "Funds run out before age 80. Material funding gap — review your strategy.";
    card.classList.add("risk-bad");
  }
}

function renderPensionDetail(result) {
  // Compute pension at the year the older client first becomes pension-eligible.
  const c = state.clients, s = state.shared;
  const ageDiff = c[0].currentAge - c[1].currentAge;
  // Find row where both clients are >= pensionAge AND drawdown has started.
  let pensionFirstYear = null;
  for (const row of result.rows) {
    if (row.age[0] >= state.pension.pensionAge && row.age[1] >= state.pension.pensionAge && row.phase === "Retired") {
      pensionFirstYear = row; break;
    }
  }
  document.getElementById("ap_full").textContent =
    fmtMoney(state.pension.homeowner ? PENSION.assetFull.homeowner : PENSION.assetFull.nonHomeowner);
  document.getElementById("ap_cut").textContent =
    fmtMoney(state.pension.homeowner ? PENSION.assetCut.homeowner : PENSION.assetCut.nonHomeowner);

  const startAgeEl = document.getElementById("pensionStartAge");
  const statusEl = document.getElementById("pensionStatus");
  const detailEl = document.getElementById("pensionDetail");

  if (!state.pension.include) {
    startAgeEl.textContent = "Off";
    statusEl.textContent = "";
    detailEl.textContent = "Age Pension excluded from this projection.";
    return;
  }

  if (!pensionFirstYear) {
    startAgeEl.textContent = state.pension.pensionAge;
    statusEl.textContent = "(eligible)";
    detailEl.textContent = "No retired pension-eligible years projected.";
    return;
  }

  const p = pensionFirstYear.pension || 0;
  const assessable = pensionFirstYear.startBalance + (pensionFirstYear.invest ?? 0);
  let kind = "no pension";
  if (p >= PENSION.maxAnnualCouple * 0.99) kind = "full pension";
  else if (p > 0) kind = "part pension";
  startAgeEl.textContent = state.pension.pensionAge;
  statusEl.textContent = "→ " + kind;
  detailEl.innerHTML =
    `At age ${state.pension.pensionAge} your projected assessable balance is <strong>${fmtMoneyShort(assessable)}</strong>. ` +
    (p > 0
      ? `Estimated combined pension: <strong>${fmtMoney(p)}</strong>/yr (${fmtMoney(p / 26)} per fortnight).`
      : `Assets exceed the cut-off — no pension payable at that age. Re-check once assets are drawn down.`);
}

function setHeadlines(result) {
  const annualGap = result.yearsToRetire > 0 ? result.gap / result.yearsToRetire : result.gap;
  document.getElementById("gapAmount").textContent = fmtMoneyShort(result.gap);
  document.getElementById("balAmount").textContent = fmtMoneyShort(result.retirementBalance);
  document.getElementById("targetAmount").textContent = fmtMoneyShort(result.requiredLump);

  document.getElementById("yearsToRet").textContent = result.yearsToRetire + " yrs";
  document.getElementById("yearsFunded").textContent = result.yearsFullyFunded + " yrs";
  document.getElementById("annualGap").textContent = fmtMoneyShort(annualGap);

  // Safe to earn = 2 × Work Bonus + income free area (annualised), assuming employment income only
  const safeEarn = (PENSION.workBonusPF * 2 + PENSION.incomeFreeAreaPF) * 26;
  document.getElementById("safeEarn").textContent = fmtMoneyShort(safeEarn);
}

function recompute() {
  const result = runProjection();
  setHeadlines(result);
  setRiskCard(result.depletionAge, state.shared.planToAge);
  updateChart(result.rows, result.depletionAge);
  renderPensionDetail(result);
}

/* ---------- 6. BOOT ---------- */

function renderAllInputs() {
  renderClientInputs();
  renderSharedInputs();
  renderDebtInputs();
  renderInheritanceInputs();
  renderPensionInputs();
}

document.getElementById("resetBtn").addEventListener("click", () => {
  state = structuredClone(DEFAULTS);
  // Clear extensions
  state.debt = { balance: 0, rate: 0.06, annualPayment: 0, fromCashflow: true };
  state.inheritance = { amount: 0, ageReceived: 75, destination: "nonSuper" };
  renderAllInputs(); recompute();
});

document.getElementById("exampleBtn").addEventListener("click", () => {
  state = structuredClone(DEFAULTS);
  state.debt = { balance: 120000, rate: 0.065, annualPayment: 18000, fromCashflow: true };
  state.inheritance = { amount: 250000, ageReceived: 75, destination: "nonSuper" };
  renderAllInputs(); recompute();
});

renderAllInputs();
recompute();
