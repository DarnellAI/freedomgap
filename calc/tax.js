import { SUPER, MIN_DRAWDOWN } from '../data/parameters.js';

// ── Australian income tax 2025-26 ─────────────────────────────────────────────
const BRACKETS = [
  { from: 0,      to: 18200,    base: 0,     rate: 0    },
  { from: 18200,  to: 45000,    base: 0,     rate: 0.16 },
  { from: 45000,  to: 135000,   base: 4288,  rate: 0.30 },
  { from: 135000, to: 190000,   base: 31288, rate: 0.37 },
  { from: 190000, to: Infinity, base: 51638, rate: 0.45 },
];

export function calcIncomeTax(gross) {
  if (gross <= 0) return 0;
  let tax = 0;
  for (const b of BRACKETS) {
    if (gross <= b.from) break;
    tax = b.base + (Math.min(gross, b.to) - b.from) * b.rate;
  }
  // Low Income Tax Offset
  let lito = 0;
  if (gross <= 37500)      lito = 700;
  else if (gross <= 45000) lito = 700 - (gross - 37500) * 0.05;
  else if (gross <= 66667) lito = Math.max(0, 325 - (gross - 45000) * 0.015);
  // Medicare Levy (2%, phases in above $24,276 at 10c/dollar until 2% applies)
  let medicare = 0;
  if (gross > 24276 && gross <= 30345) medicare = (gross - 24276) * 0.10;
  else if (gross > 30345)              medicare = gross * 0.02;
  return Math.max(0, tax - lito + medicare);
}

export function calcNetIncome(gross) {
  return Math.max(0, gross - calcIncomeTax(gross));
}

export function minDrawdownRate(age) {
  for (const b of MIN_DRAWDOWN) {
    if (age >= b.from && age <= b.to) return b.rate;
  }
  return 0.04;
}

export function minDrawdownAmount(pensionBalance, age) {
  return pensionBalance * minDrawdownRate(age);
}

// Convert accumulation to pension phase respecting TBC
export function convertToPension(accumBal, tbcUsed) {
  const headroom = Math.max(0, SUPER.tbc - tbcUsed);
  const added = Math.min(accumBal, headroom);
  return {
    pensionAdded: added,
    accumRemaining: accumBal - added,
    newTbcUsed: tbcUsed + added,
  };
}

// Accumulation phase year step (working years)
export function accumStep(opening, salary, sgcRate, addConcessional, returnRate) {
  const contribGross = salary * sgcRate + addConcessional;
  const contribCapped = Math.min(contribGross, SUPER.concessionalCap);
  const grossReturn = (opening + contribCapped / 2) * returnRate;
  const tax = (contribCapped + grossReturn) * SUPER.accumTaxRate;
  return {
    closing: opening + contribCapped + grossReturn - tax,
    contribGross: contribCapped,
    grossReturn,
    tax,
  };
}

// Accumulation phase year step (post-work, still in accumulation)
export function accumCompound(opening, returnRate) {
  const grossReturn = opening * returnRate;
  const tax = grossReturn * SUPER.accumTaxRate;
  return { closing: opening + grossReturn - tax, grossReturn, tax };
}

// Pension phase — returns are tax-free
export function pensionCompound(opening, returnRate) {
  const grossReturn = opening * returnRate;
  return { closing: opening + grossReturn, grossReturn, tax: 0 };
}
