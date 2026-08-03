import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFACTORING_THRESHOLD_GROUPS } from '../../../src/analysis/architecture/config.js';
import { AnalyzeArchitectureThresholdsSchema } from '../../../src/config.js';
import { readDirSorted } from '../../../src/fs/read-dir-sorted.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// The set of tunable detector groups is stated in three places that serve different readers: the
// TypeScript type the detectors consume, the Zod schema that admits a user's config, and the
// workspace-file reference a user reads before writing one. A group added to the type and missed in
// the schema is rejected at load with no diagnostic; missed in the docs it is undiscoverable. The
// type is the source; these hold the other two to it.
describe('detector threshold groups are declared once', () => {
  it('the config schema admits exactly the groups the detectors define', () => {
    const schemaGroups = Object.keys(AnalyzeArchitectureThresholdsSchema.shape).sort();
    expect(schemaGroups).toEqual([...REFACTORING_THRESHOLD_GROUPS]);
  });

  it('the workspace-file reference lists exactly those groups', () => {
    const docs = fs.readFileSync(path.join(repoRoot, 'docs/workspace-files.md'), 'utf-8');
    const line = docs
      .split(/\r?\n/)
      .find(l => l.includes('`duplicateLike`') && l.includes('`godModule`'));
    expect(line).toBeDefined();

    const listed = [...(line as string).matchAll(/`([A-Za-z]+)`/g)].map(m => m[1]).sort();
    expect(listed).toEqual([...REFACTORING_THRESHOLD_GROUPS]);
  });

  it('no comment re-enumerates the group names', () => {
    // A list in prose drifts silently: nothing reads it, so nothing fails when a group is added.
    // Field access is exempt — a detector reading DEFAULT_THRESHOLDS.godModule is type-checked,
    // and a typo there is a compile error rather than a stale sentence.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readDirSorted(dir)) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        if (full.endsWith(path.join('analysis', 'architecture', 'config.ts'))) continue;
        const comments = fs.readFileSync(full, 'utf-8')
          .split(/\r?\n/)
          .filter(line => /^\s*(\/\/|\*|\/\*)/.test(line))
          .join('\n');
        const hits = REFACTORING_THRESHOLD_GROUPS.filter(group => comments.includes(group));
        if (hits.length > REFACTORING_THRESHOLD_GROUPS.length / 2) offenders.push(path.relative(repoRoot, full));
      }
    };
    walk(path.join(repoRoot, 'src'));
    expect(offenders).toEqual([]);
  });
});
