// Cache-busting for a no-build ES-module site.
//
//   node tools/bump-version.mjs
//
// Browsers cache each ES module independently, so a version query on the entry
// script does NOT refresh the modules it imports — you can end up running a
// fresh app.js against a stale ui/inputs.js, which shows up as a feature
// silently missing rather than an error. This stamps the same version onto
// every internal import so a deploy is refreshed as a set.
//
// Run it before pushing any change that touches the browser-loaded modules.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Files the BROWSER loads. Node-run scripts (mockups, tests) are deliberately
// excluded so their plain specifiers keep resolving.
const FILES = [
  'app.js',
  'ui/inputs.js', 'ui/chart.js', 'ui/scenarios.js',
  'calc/core.js', 'calc/tax.js', 'calc/pension.js',
  'export/clientReport.js',
  'data/parameters.js',
];

const version = process.argv[2] || new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

let changed = 0;
for (const rel of FILES) {
  const path = join(ROOT, rel);
  const src  = readFileSync(path, 'utf8');
  // from './x.js'  |  from '../x.js'   (with or without an existing ?v=)
  const out = src.replace(
    /(\bfrom\s+)(['"])(\.\.?\/[^'"?]+\.js)(?:\?v=[^'"]*)?\2/g,
    (_m, kw, q, spec) => `${kw}${q}${spec}?v=${version}${q}`
  );
  if (out !== src) { writeFileSync(path, out); changed++; }
}

// Entry script tag + visible build stamp in index.html
const idxPath = join(ROOT, 'index.html');
const idx = readFileSync(idxPath, 'utf8');
let idxOut = idx.replace(
  /(<script[^>]*\bsrc=")app\.js(?:\?v=[^"]*)?(")/,
  (_m, a, b) => `${a}app.js?v=${version}${b}`
);
// A stamp on the page is the quickest way to tell a stale tab from a fresh one
idxOut = idxOut.replace(
  /(<span id="buildStamp"[^>]*>)[^<]*(<\/span>)/,
  (_m, a, b) => `${a}build ${version}${b}`
);
if (idxOut !== idx) { writeFileSync(idxPath, idxOut); changed++; }

console.log(`version ${version} stamped across ${changed} file(s)`);
