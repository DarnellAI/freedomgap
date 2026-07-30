import { PENSION, PENSION_INDEXATION } from '../data/parameters.js?v=202607301634';

/**
 * Calculate annual Age Pension.
 * @param {object} p
 * @param {number} p.assets           - Combined assessable assets (excl. PPOR)
 * @param {number} p.financialAssets  - Portion subject to deeming
 * @param {number} p.earnedIncome     - Combined employment income (annual) — legacy fallback
 * @param {number[]} [p.earnedIncomes] - Per-person employment income (preferred: Work Bonus is per person)
 * @param {boolean} p.homeowner
 * @param {boolean} p.bothAlive
 */
export function calcPension({ assets, financialAssets, earnedIncome = 0, earnedIncomes = null, homeowner = true, bothAlive = true, pensionYear = 0 }) {
  // Index all rates and thresholds at 2%/yr from the base (March 2026) rates
  const ix = Math.pow(1 + PENSION_INDEXATION, pensionYear);
  const maxAnnual   = (bothAlive ? PENSION.maxAnnualCouple   : PENSION.maxAnnualSingle) * ix;
  const thresholds  = bothAlive ? PENSION.assetFull.couple  : PENSION.assetFull.single;
  const cuts        = bothAlive ? PENSION.assetCut.couple   : PENSION.assetCut.single;
  const fullThresh  = (homeowner ? thresholds.homeowner : thresholds.nonHomeowner) * ix;
  const cutThresh   = (homeowner ? cuts.homeowner       : cuts.nonHomeowner)       * ix;

  // Asset test. The taper is a RATE ($78 per $1,000 of excess) and must not be
  // indexed: Centrelink's cut-off threshold is itself derived from it
  // (cutThresh = fullThresh + maxAnnual / 0.078). Indexing both the taper and
  // the thresholds double-counts indexation and drives the entitlement to nil
  // well before the published cut-off is reached.
  let assetPension = maxAnnual;
  if (assets >= cutThresh) {
    assetPension = 0;
  } else if (assets > fullThresh) {
    const excessK = Math.floor((assets - fullThresh) / 1000);
    assetPension = Math.max(0, maxAnnual - excessK * PENSION.taperRate);
  }

  // Deeming on financial assets
  const deemThresh = (bothAlive ? PENSION.deemThreshold.couple : PENSION.deemThreshold.single) * ix;
  const deemedIncome = financialAssets <= deemThresh
    ? financialAssets * PENSION.deemLow
    : deemThresh * PENSION.deemLow + (financialAssets - deemThresh) * PENSION.deemHigh;

  // Work Bonus offsets employment income — $300/fortnight per person, applied
  // against each person's OWN earnings (one partner's unused bonus cannot
  // shelter the other's income)
  const wbAnnual = PENSION.workBonusPF * 26;
  const assessableEarned = earnedIncomes
    ? earnedIncomes.reduce((s, inc) => s + Math.max(0, inc - wbAnnual), 0)
    : Math.max(0, earnedIncome - (bothAlive ? 2 : 1) * wbAnnual);
  const totalIncome = deemedIncome + assessableEarned;
  const freeArea = (bothAlive ? PENSION.incomeFreeAreaPF.couple : PENSION.incomeFreeAreaPF.single) * 26 * ix;
  let incomePension = maxAnnual;
  if (totalIncome > freeArea) {
    incomePension = Math.max(0, maxAnnual - (totalIncome - freeArea) * PENSION.incomeTaper);
  }

  const annualPension = Math.min(assetPension, incomePension);
  // Income at which the income test alone reduces the pension to nil
  const incomeCutThreshold = freeArea + maxAnnual / PENSION.incomeTaper;
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
    // Thresholds actually used this year (indexed) — surfaced so the UI can
    // explain *why* an entitlement starts, stops or is reduced
    assets,
    assetFullThreshold: fullThresh,
    assetCutThreshold:  cutThresh,
    incomeFreeArea:     freeArea,
    incomeCutThreshold,
  };
}

// Max combined employment income without reducing pension
export function safeEarnAmount(bothAlive = true) {
  const freeArea = (bothAlive ? PENSION.incomeFreeAreaPF.couple : PENSION.incomeFreeAreaPF.single) * 26;
  const workBonus = (bothAlive ? 2 : 1) * PENSION.workBonusPF * 26;
  return freeArea + workBonus;
}
