import { PENSION, PENSION_INDEXATION } from '../data/parameters.js';

/**
 * Calculate annual Age Pension.
 * @param {object} p
 * @param {number} p.assets           - Combined assessable assets (excl. PPOR)
 * @param {number} p.financialAssets  - Portion subject to deeming
 * @param {number} p.earnedIncome     - Combined employment income (annual)
 * @param {boolean} p.homeowner
 * @param {boolean} p.bothAlive
 */
export function calcPension({ assets, financialAssets, earnedIncome = 0, homeowner = true, bothAlive = true, pensionYear = 0 }) {
  // Index all rates and thresholds at 2%/yr from the base (March 2026) rates
  const ix = Math.pow(1 + PENSION_INDEXATION, pensionYear);
  const maxAnnual   = (bothAlive ? PENSION.maxAnnualCouple   : PENSION.maxAnnualSingle) * ix;
  const thresholds  = bothAlive ? PENSION.assetFull.couple  : PENSION.assetFull.single;
  const cuts        = bothAlive ? PENSION.assetCut.couple   : PENSION.assetCut.single;
  const fullThresh  = (homeowner ? thresholds.homeowner : thresholds.nonHomeowner) * ix;
  const cutThresh   = (homeowner ? cuts.homeowner       : cuts.nonHomeowner)       * ix;

  // Asset test
  let assetPension = maxAnnual;
  if (assets >= cutThresh) {
    assetPension = 0;
  } else if (assets > fullThresh) {
    const excessK = Math.floor((assets - fullThresh) / 1000);
    assetPension = Math.max(0, maxAnnual - excessK * PENSION.taperRate * ix);
  }

  // Deeming on financial assets
  const deemThresh = (bothAlive ? PENSION.deemThreshold.couple : PENSION.deemThreshold.single) * ix;
  const deemedIncome = financialAssets <= deemThresh
    ? financialAssets * PENSION.deemLow
    : deemThresh * PENSION.deemLow + (financialAssets - deemThresh) * PENSION.deemHigh;

  // Work Bonus offsets employment income
  const workBonusAnnual = (bothAlive ? 2 : 1) * PENSION.workBonusPF * 26;
  const assessableEarned = Math.max(0, earnedIncome - workBonusAnnual);
  const totalIncome = deemedIncome + assessableEarned;
  const freeArea = (bothAlive ? PENSION.incomeFreeAreaPF.couple : PENSION.incomeFreeAreaPF.single) * 26 * ix;
  let incomePension = maxAnnual;
  if (totalIncome > freeArea) {
    incomePension = Math.max(0, maxAnnual - (totalIncome - freeArea) * PENSION.incomeTaper);
  }

  const annualPension = Math.min(assetPension, incomePension);
  return {
    annualPension,
    assetPension,
    incomePension,
    maxAnnual,
    deemedIncome,
    assessableEarned,
    totalIncome,
    binding: assetPension <= incomePension ? 'asset' : 'income',
    fullPension: annualPension >= maxAnnual - 1,
    partPension: annualPension > 0 && annualPension < maxAnnual - 1,
  };
}

// Max combined employment income without reducing pension
export function safeEarnAmount(bothAlive = true) {
  const freeArea = (bothAlive ? PENSION.incomeFreeAreaPF.couple : PENSION.incomeFreeAreaPF.single) * 26;
  const workBonus = (bothAlive ? 2 : 1) * PENSION.workBonusPF * 26;
  return freeArea + workBonus;
}
