#!/usr/bin/env node
// The release version has a single source of truth: root package.json `version`.
// Every other file that repeats the version is derived from it here, so a release
// cannot ship a server.json (MCP registry manifest) whose version drifts from the
// published npm package.
//
// Targets:
//   server.json -> .version and every .packages[].version
//
// Usage:
//   node scripts/sync-version.mjs           write the targets in place
//   node scripts/sync-version.mjs --check   exit 1 if any target is stale (release gate)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
if (typeof version !== 'string' || version.length === 0) {
  console.error('sync-version: root package.json has no version');
  process.exit(1);
}

// Each target names a file and the version values it carries. `read` returns the
// current values (to detect drift); `apply` sets them (to write the file back).
const targets = [
  {
    file: 'server.json',
    read: (obj) => [obj.version, ...(obj.packages ?? []).map((p) => p.version)],
    apply: (obj) => {
      obj.version = version;
      for (const p of obj.packages ?? []) p.version = version;
    },
  },
];

let drift = false;
for (const { file, read, apply } of targets) {
  const path = resolve(root, file);
  let obj;
  try {
    obj = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`sync-version: cannot read ${file}: ${err.message}`);
    process.exit(1);
  }

  const stale = read(obj).filter((v) => v !== version);
  if (stale.length === 0) {
    console.log(`sync-version: ${file} already at ${version}`);
    continue;
  }

  if (check) {
    drift = true;
    console.error(`sync-version: ${file} is out of sync with package.json@${version}`);
    continue;
  }

  apply(obj);
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
  console.log(`sync-version: updated ${file} -> ${version}`);
}

if (check && drift) {
  console.error('sync-version: run `npm run sync:version` and commit the result');
  process.exit(1);
}
