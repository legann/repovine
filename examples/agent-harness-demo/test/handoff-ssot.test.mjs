// lib/handoff/handoff.md is DEMO-OWNED prose (the core projection and
// `run-brief --write-handoff` were removed with the boundary-hygiene pass).
// This suite is the structural guard that replaced `doctor --with-harness`:
// the bundled file must parse into a full config — a broken edit must fail
// here, not silently fall back to DEFAULT_CONFIG at runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHandoffMarkdown } from '../lib/handoff-loader.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED = path.join(HERE, '..', 'lib', 'handoff', 'handoff.md');

test('bundled handoff.md parses into a complete demo-owned config (no fallback)', () => {
  const text = fs.readFileSync(BUNDLED, 'utf-8');
  const cfg = parseHandoffMarkdown(text);

  assert.equal(cfg.requireContractsWhenFilesChanged, true, 'frontmatter flag present');
  assert.deepEqual(cfg.implementerRoles, ['backend', 'infra', 'frontend', 'default']);
  assert.ok(cfg.policy.length > 0, 'Policy section present');

  // The three templates the orchestrator renders at runtime.
  assert.match(cfg.templates.interSubAgentSection, /\{\{contracts\}\}/);
  assert.match(cfg.templates.interSubAgentSection, /\{\{priorPhases\}\}/);
  assert.match(cfg.templates.constraintImplementer, /contractsChanged/);
  assert.match(cfg.templates.constraintReview, /review/i);
});
