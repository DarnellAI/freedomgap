// Australian policy constants — March 2026

export const PENSION = {
  asAt: "20 March 2026",
  eligibleAge: 67,
  maxAnnualCouple: 47070,
  maxAnnualSingle: 31430,
  maxFortnightlyCouple: 1810.40,
  maxFortnightlySingle: 1208.10,
  assetFull: {
    couple:  { homeowner: 481500,  nonHomeowner: 739500  },
    single:  { homeowner: 321500,  nonHomeowner: 579500  },
  },
  assetCut: {
    couple:  { homeowner: 1085000, nonHomeowner: 1343000 },
    single:  { homeowner: 722000,  nonHomeowner: 980000  },
  },
  taperRate: 78,          // $/year per $1,000 over full-pension threshold
  incomeFreeAreaPF: { couple: 380, single: 202 },
  incomeTaper: 0.5,
  deemThreshold: { couple: 106200, single: 56400 },
  deemLow: 0.0125,
  deemHigh: 0.0325,
  workBonusPF: 300,       // per person, from employment only
};

export const SUPER = {
  concessionalCap: 30000,
  nccAnnual: 120000,
  nccBringForward3: 360000,
  tbc: 2000000,
  accumTaxRate: 0.15,
  pensionTaxRate: 0,
  downsizer: { minAge: 55, maxPerPerson: 300000 },
};

// ATO minimum drawdown rates by age bracket
export const MIN_DRAWDOWN = [
  { from: 55, to: 64, rate: 0.04 },
  { from: 65, to: 74, rate: 0.05 },
  { from: 75, to: 79, rate: 0.06 },
  { from: 80, to: 84, rate: 0.07 },
  { from: 85, to: 89, rate: 0.09 },
  { from: 90, to: 94, rate: 0.11 },
  { from: 95, to: 999, rate: 0.14 },
];

export const RETURN_PROFILES = [
  { id: 'conservative', label: 'Conservative', rate: 0.045 },
  { id: 'balanced',     label: 'Balanced',     rate: 0.050 },
  { id: 'growth',       label: 'Growth',       rate: 0.060 },
  { id: 'highGrowth',   label: 'High Growth',  rate: 0.070 },
];

export const INFLATION = 0.025;

export const DEFAULT_SGC = 0.12;

// ABS life tables approximation (age at death, 50th percentile)
export const LIFE_EXPECTANCY_DEFAULT = { male: 87, female: 90 };

export const SCENARIO_COLORS  = ['#1B2A4E', '#C9A961', '#0E7490', '#BE185D', '#64748B'];
export const SCENARIO_NAMES   = ['Base case', 'Scenario 2', 'Scenario 3', 'Scenario 4', 'Scenario 5'];
export const MAX_SCENARIOS     = 5;

export const DEFAULT_STATE = {
  clients: [
    {
      name: 'Client 1',
      gender: 'male',
      currentAge: 50,
      lifeExpectancy: 87,
      ftIncome: 120000,
      ptAge: 62,
      ptIncome: 70000,
      freedomAge: 65,
      superBalance: 350000,
      additionalConcessional: 0,
      downsizer: { active: false, amount: 0 },
    },
    {
      name: 'Client 2',
      gender: 'female',
      currentAge: 48,
      lifeExpectancy: 90,
      ftIncome: 90000,
      ptAge: 60,
      ptIncome: 50000,
      freedomAge: 63,
      superBalance: 250000,
      additionalConcessional: 0,
      downsizer: { active: false, amount: 0 },
    },
  ],
  shared: {
    returnProfile: 'growth',
    sgcRate: 0.12,
    nonSuper: 0,
    desiredIncome: 100000,
    planToAge: 95,
    minDrawdownExcess: 'invest',
  },
  debt: {
    balance: 0,
    rate: 0.06,
    annualPayment: 30000,
  },
  inheritance: {
    amount: 0,
    ageReceived: 75,
    destination: 'nonSuper',
  },
  pension: {
    include: true,
    homeowner: true,
    pensionAge: 67,
  },
  agedCare: {
    active: false,
    amount: 500000,
    triggerAge: 85,
    mode: 'invested',
  },
  survivor: {
    active: true,
    expenseFactor: 0.70,
  },
  bequest: {
    active: false,
    amount: 200000,
  },
};
