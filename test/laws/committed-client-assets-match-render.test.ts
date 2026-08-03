import { describe, expect, it } from '@jest/globals';
import { runAgentAssetDoctor } from '../../src/cli/agent-doctor.js';
import { toolDefs } from '../../src/mcp/tool-defs.js';
import { findRepovineRoot } from './core-schema.js';

// Law: the committed client assets match what `repovine setup` would render today.
//
// The generated client surfaces (.claude, .agents, .cursor, .codex managed files) are projections of
// the protocol manifests. CI renders the external plugin bundles to a temp dir and validates their
// structure, but never diffs the committed in-repo assets against a fresh render, and `repovine
// doctor` — which does that diff — runs in no workflow. So a protocol export whose rename changes
// rendered text leaves a committed asset stale with nothing red. This runs the same doctor the CLI
// runs, against the real repo root, in the normal test suite: any drift surfaces as a
// stale-managed-content finding and fails the run. Regenerating the assets is a separate step; this
// only holds them honest.

describe('core-laws committed client assets match a fresh render', () => {
  it('the agent-asset doctor reports no drift for the repo', () => {
    const report = runAgentAssetDoctor({
      repoRoot: findRepovineRoot(),
      validToolNames: toolDefs.map((definition) => definition.name),
      client: 'all',
    });

    // A doctor that governed nothing would pass vacuously.
    expect(report.governed.length).toBeGreaterThan(0);
    // Drift of a committed managed asset is a stale-managed-content error; the mixed-surface advisory
    // (Cursor rules beside a generated AGENTS.md) is an intentional warning and leaves ok true.
    expect(report.findings.filter((finding) => finding.code === 'stale-managed-content')).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
