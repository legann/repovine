#!/usr/bin/env node
/**
 * Audit gate — passes allowlisted advisories, fails on any new one.
 *
 * `npm audit` flags an image-decoding advisory in the development install of the optional text-
 * embedding peer (see SECURITY.md section "Known audit findings"). This gate accepts that finding by GHSA
 * id and fails on anything else, so `npm audit` remains a live signal.
 *
 * Run: `npm run audit:check`. Exit 0 = only allowlisted advisories present; 1 = a new advisory;
 * 2 = the audit itself could not run.
 */
import { runNpm } from './lib/spawn.cjs';

// Keep in sync with SECURITY.md. Each entry is upstream-blocked and outside repovine's usage.
const ALLOWLIST = {
  'GHSA-f88m-g3jw-g9cj':
    'sharp/libvips image CVEs. Dev-only via optional @huggingface/transformers (text embeddings); image path unused; no transformers release adopts sharp >=0.35.',
};

const res = runNpm(['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
// npm audit exits non-zero when advisories exist; that is expected — parse stdout regardless.
if (!res.stdout) {
  console.error('audit-gate: npm audit produced no output.');
  if (res.stderr) console.error(res.stderr);
  process.exit(2);
}

let report;
try {
  report = JSON.parse(res.stdout);
} catch (err) {
  console.error(`audit-gate: could not parse npm audit --json: ${err.message}`);
  process.exit(2);
}
if (report.error) {
  console.error(`audit-gate: npm audit error: ${report.error.summary ?? JSON.stringify(report.error)}`);
  process.exit(2);
}

const GHSA = /GHSA-[a-z0-9-]+/i;
const found = new Map(); // ghsa id -> { severity, title, pkg }
for (const [pkg, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of vuln.via ?? []) {
    if (typeof via !== 'object' || !via.url) continue; // string via = transitive pointer, no advisory
    const match = GHSA.exec(via.url);
    if (match && !found.has(match[0])) {
      found.set(match[0], { severity: via.severity ?? vuln.severity, title: via.title ?? '', pkg });
    }
  }
}

const accepted = [...found].filter(([id]) => ALLOWLIST[id]);
const unexpected = [...found].filter(([id]) => !ALLOWLIST[id]);
const stale = Object.keys(ALLOWLIST).filter(id => !found.has(id));

for (const [id, info] of accepted) {
  console.log(`  ✓ allowlisted  ${id} [${info.severity}] ${info.pkg} — ${info.title}`);
}
for (const id of stale) {
  console.log(`  · no longer reported: ${id} (upstream may have fixed it — candidate to drop from the allowlist)`);
}

if (unexpected.length > 0) {
  console.error('\naudit-gate FAILED — advisories not in the allowlist:');
  for (const [id, info] of unexpected) {
    console.error(`  ✗ ${id} [${info.severity}] ${info.pkg} — ${info.title}`);
  }
  console.error(
    '\nFix it if possible (do NOT `npm audit fix --force`). If it is accepted like the others, add its'
    + ' GHSA id to scripts/audit-gate.mjs and document it in SECURITY.md.',
  );
  process.exit(1);
}

console.log(`\naudit-gate OK — ${accepted.length} allowlisted, 0 unexpected.`);
process.exit(0);
