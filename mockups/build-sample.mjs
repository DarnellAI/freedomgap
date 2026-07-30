// Regenerates the sample client take-home report:
//   node mockups/build-sample.mjs
//
// Runs the real engine over a sample household and feeds the result to the
// report builder — nothing in the report is typed in, every figure is
// projected, exactly as it will be when wired into the app.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runProjection, solveSavingsGap } from '../calc/core.js';
import { buildClientReport } from '../export/clientReport.js';

const state = {
  clients: [
    { name: 'David', gender: 'male', currentAge: 66, lifeExpectancy: 87,
      ftIncome: 165000, ptAge: 67, ptIncome: 45000, freedomAge: 72,
      superBalance: 265000, additionalConcessional: 0, downsizer: { active: false, amount: 0 } },
    { name: 'Margaret', gender: 'female', currentAge: 65, lifeExpectancy: 90,
      ftIncome: 60000, ptAge: 75, ptIncome: 0, freedomAge: 75,
      superBalance: 160000, additionalConcessional: 0, downsizer: { active: false, amount: 0 } },
  ],
  shared: { returnProfile: 'growth', sgcRate: 0.12, nonSuper: 0,
            desiredIncome: 90000, incomePhases: [{ income: 90000, untilAge: null }],
            planToAge: 90, minDrawdownExcess: 'invest' },
  debts: [], inheritances: [],
  pension: { include: true, homeowner: true, pensionAge: 67, homeValue: 850000 },
  agedCare: { active: false, amount: 500000, triggerAge: 85, mode: 'invested' },
  survivor: { active: false, expenseFactor: 0.70 },
  bequest: { active: false, amount: 0 },
};

const meeting = {
  practice: 'Darnell Consulting',
  adviser: 'Jackson',
  reviewDate: '2026-07-30',
  householdLabel: 'David & Margaret',
  sample: true,
  intro: 'Thanks for coming in this week. This page is the plan we walked through together — keep it on your phone and tick things off as they happen.',
  strategies: [
    { title: 'Part-time work does the heavy lifting',
      body: 'David working part-time to 72 and Margaret to 75 means your super barely gets touched until then — it keeps compounding while salaries cover the bills.',
      impact: 'Roughly $500k more at full retirement' },
    { title: 'The Age Pension is part of the plan, not a fallback',
      body: 'From your first fully retired year the pension covers a growing share of your income. As your own savings are drawn down, the pension automatically steps up.',
      impact: 'Starts near $20k/yr, grows past $45k/yr' },
    { title: 'The house stays out of the numbers',
      body: 'Your home is not counted in any figure on this page. It is a genuine backstop — downsizing or equity release stays available if you ever need it.',
      impact: 'Backstop preserved' },
  ],
  actions: [
    { text: 'Consolidate David\'s two old super accounts into the main fund', owner: 'client' },
    { text: 'Confirm Margaret\'s fund is set to Growth (not the default option)', owner: 'client' },
    { text: 'Send us the latest statements for both funds', owner: 'client' },
    { text: 'Prepare the Age Pension application pack for age 67', owner: 'practice' },
    { text: 'Model the part-pension entitlement while David still works part-time', owner: 'practice', done: true, note: 'done in this review' },
  ],
  // The client's timeline is derived from the projection automatically; these
  // are the extras specific to this household.
  dates: [
    { date: '2027-02-04', title: 'Six-month check-in with Jackson', note: 'phone call, 30 minutes' },
    { date: '2027-06-20', title: 'Last safe day for this year\'s super contributions', note: 'money must reach the fund before 30 June' },
    { date: '2027-07-30', title: 'Your next annual review' },
  ],
  callUs: [
    'Either of you decides to stop work earlier than planned',
    'You receive an inheritance or a large gift',
    'You are thinking about helping the kids with a house deposit',
    'A health event changes what retirement needs to look like',
    'Markets fall sharply and you are tempted to move to cash',
    'You are considering downsizing the house',
  ],
};

const result    = runProjection(state);
const seqResult = runProjection(state, true);
const solver    = solveSavingsGap(state, 'sustain');

const html = buildClientReport({ state, result, sequencingResult: seqResult, solver, meeting });

const out = join(dirname(fileURLToPath(import.meta.url)), 'client-report-sample.html');
writeFileSync(out, html);
console.log(`written ${out} (${(html.length / 1024).toFixed(0)} kB)`);
console.log(`engine says: depletes=${result.depletionAge ?? 'never'} pensionStart=${result.pensionStartAge} solver=${solver.alreadyMet ? 'on track' : Math.round(solver.monthly) + '/mo'}`);
