import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { doctorAgentAssets, type DoctorAgentAssetsReport } from '../../src/cli/agent-doctor.js';
import { toolDefs } from '../../src/mcp/tool-defs.js';

// Law: the doctor decides what a tool name looks like from the registry it validates against.
//
// The scan carried a literal list of verb families, but it was never an exact copy of the registry's
// namespace. The mismatch existed in the initial e49381b revision: `suggest_` and `decline_` were
// absent even though both families were already public, so a stale spelling of either was collected,
// found missing from the registry, and then dropped by the filter meant to decide whether it looked
// like a tool at all. Two of eighteen tools were unguarded by a check whose own doc comment covered
// every current family.
//
// Second half of the same property: an asset setup would write for an active client and that is not on
// disk is drift. Missing assets were never counted as scanned; silence merely made the clean sweep
// smaller.

const TOOL_NAMES = toolDefs.map(def => def.name);

// Derived from the registry so a family added tomorrow is covered without editing this law.
const VERB_FAMILIES = [...new Set(TOOL_NAMES.map(name => name.slice(0, name.indexOf('_') + 1)))];

// Established loose scan behavior. Only cleanup_ represents a removed repovine family; the other
// three are intentionally pinned as legacy heuristics so registry-derived coverage does not silently
// narrow the old recognition boundary.
const LEGACY_VERB_FAMILIES = ['check_', 'cleanup_', 'doctor_', 'render_'];

// The one file these fixtures put on disk, and therefore the only file the doctor can read.
const PROJECT_AGENT = path.join('.claude', 'agents', 'project-agent.md');

function scan(repoRoot: string): DoctorAgentAssetsReport {
  return doctorAgentAssets({ repoRoot, validToolNames: TOOL_NAMES, client: 'claude' });
}

function writeProjectAgent(repoRoot: string, body: string): void {
  const dir = path.join(repoRoot, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project-agent.md'), body, 'utf-8');
}

describe('core-laws the doctor reads the tool registry, not a copy of it', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-doctor-registry-law-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('derives more than one verb family from the registry', () => {
    expect(VERB_FAMILIES.length).toBeGreaterThan(1);
    // A tool name without an underscore would slice to the empty prefix, which matches everything and
    // would turn its case below into a question about nothing.
    expect(VERB_FAMILIES).not.toContain('');
  });

  // One case per family, so a family that stops being recognised is named by the case that failed.
  it.each(VERB_FAMILIES)('recognises a stale %s tool name as tool-shaped', family => {
    // Lowercase and underscored: the collector only recognises tool-shaped spellings.
    const stale = `${family}name_that_is_not_a_tool`;
    writeProjectAgent(repoRoot, `Call \`${stale}\` before editing.\n`);

    const unknown = scan(repoRoot).findings.filter(finding => finding.code === 'unknown-tool-name');
    // Match on the message, not the code alone: the finding has to carry the spelling it rejected for
    // the reader to know which mention to fix.
    expect(unknown.map(finding => finding.message).join('\n')).toContain(stale);
  });

  it.each(LEGACY_VERB_FAMILIES)('preserves established loose recognition for %s names', family => {
    const stale = `${family}legacy_name_that_is_not_a_tool`;
    writeProjectAgent(repoRoot, `Call \`${stale}\` before editing.\n`);

    const unknown = scan(repoRoot).findings.filter(finding => finding.code === 'unknown-tool-name');
    expect(unknown.map(finding => finding.message).join('\n')).toContain(stale);
  });

  it('reports a managed asset that is absent for an active client', () => {
    writeProjectAgent(repoRoot, 'Nothing tool-shaped here.\n');

    expect(scan(repoRoot).findings.map(finding => finding.code)).toContain('missing-managed-asset');
  });

  it('counts as checked only what it read', () => {
    writeProjectAgent(repoRoot, 'Nothing tool-shaped here.\n');

    const report = scan(repoRoot);
    const absent = report.findings
      .filter(finding => finding.code === 'missing-managed-asset')
      .map(finding => finding.file);

    // Naming the absent assets is what turns the next line into a question: a report that stayed silent
    // about them leaves nothing for `scanned` to wrongly contain.
    expect(absent.length).toBeGreaterThan(0);
    for (const file of absent) expect(report.scanned).not.toContain(file);
    // The fixture writes one file, so that file is the whole of what a read can reach.
    expect(report.scanned).toEqual([PROJECT_AGENT]);
    // A literal, because `scanned.length` is where the summary gets its number from.
    expect(report.summary.assets).toBe(1);
  });
});
