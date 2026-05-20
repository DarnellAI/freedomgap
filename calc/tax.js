import { SUPER, MIN_DRAWDOWN } from '../data/parameters.js';

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
