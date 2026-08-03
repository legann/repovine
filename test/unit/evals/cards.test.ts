import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import yaml from 'js-yaml';

// Well-formedness guard for the agent-driven eval cards in test/evals/. These are NOT run by
// `npm test` (they are .md prompts executed by an LLM agent), but their frontmatter is the machine
// rubric and manifest.json is the machine index — so the *shape* must stay valid. This locks in:
//   1. strict-YAML frontmatter (regression guard for the colon-space `mod:`/`resource:` hazard), and
//   2. the v2 manifest formalization (per-card `axis` + `profiles`, top-level descriptors).
// Jest runs from the repovine package root, so process.cwd() is repovine/.
const EVAL_DIR = join(process.cwd(), 'test/evals');

const AXES = ['build-signal', 'annotation-quality', 'meta'] as const;
const PROFILES = ['cold-graph', 'annotated'] as const;

type CheckFm = { id?: string; severity?: string };
type CardFm = { id?: string; applies_when?: string; checks?: CheckFm[] };
type ManifestCard = {
  id: string;
  file: string;
  applies_when: string;
  axis: string;
  profiles: string[];
  consumes_annotations?: boolean;
};
type Manifest = {
  version: number;
  cards: ManifestCard[];
  axes: Record<string, string>;
  profiles: Record<string, unknown>;
};

function evalFiles(): string[] {
  return readdirSync(EVAL_DIR)
    .filter(f => f.endsWith('.eval.md'))
    .sort();
}

function frontmatter(file: string): string {
  const text = readFileSync(join(EVAL_DIR, file), 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error(`${file}: no frontmatter block`);
  return m[1];
}

function loadManifest(): Manifest {
  return JSON.parse(readFileSync(join(EVAL_DIR, 'manifest.json'), 'utf8')) as Manifest;
}

const isCard = (file: string) => !file.startsWith('_'); // exclude _TEMPLATE.eval.md

describe('eval cards: frontmatter well-formedness', () => {
  it('every card frontmatter parses as strict YAML (colon-space regression guard)', () => {
    for (const file of evalFiles()) {
      expect(() => yaml.load(frontmatter(file))).not.toThrow();
    }
  });

  it('each real card id matches its filename and declares applies_when + unique non-empty checks', () => {
    for (const file of evalFiles()) {
      if (!isCard(file)) continue;
      const base = file.slice(0, -'.eval.md'.length);
      const fm = yaml.load(frontmatter(file)) as CardFm;
      expect(fm.id).toBe(base);
      expect(typeof fm.applies_when).toBe('string');
      const checks = fm.checks ?? [];
      expect(checks.length).toBeGreaterThan(0);
      const ids = checks.map(c => c.id);
      expect(ids.every(Boolean)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length); // no duplicate check ids
      for (const c of checks) {
        if (c.severity !== undefined) expect(['fail', 'warn']).toContain(c.severity);
      }
    }
  });
});

describe('eval cards: manifest v2 index', () => {
  it('manifest and on-disk cards are in 1:1 correspondence with existing files', () => {
    const manifest = loadManifest();
    const manifestIds = manifest.cards.map(c => c.id).sort();
    const diskIds = evalFiles()
      .filter(isCard)
      .map(f => f.slice(0, -'.eval.md'.length))
      .sort();
    expect(manifestIds).toEqual(diskIds);
    expect(new Set(manifestIds).size).toBe(manifestIds.length); // no duplicate manifest ids
    for (const c of manifest.cards) {
      expect(evalFiles()).toContain(c.file);
      expect(c.file).toBe(`${c.id}.eval.md`);
    }
  });

  it('is version >= 2 with top-level axes and profiles descriptors', () => {
    const manifest = loadManifest();
    expect(manifest.version).toBeGreaterThanOrEqual(2);
    for (const axis of AXES) expect(manifest.axes[axis]).toBeTruthy();
    for (const profile of PROFILES) expect(manifest.profiles[profile]).toBeTruthy();
  });

  it('every card carries a valid axis and a non-empty profiles subset', () => {
    const manifest = loadManifest();
    for (const c of manifest.cards) {
      expect(AXES).toContain(c.axis);
      expect(Array.isArray(c.profiles)).toBe(true);
      expect(c.profiles.length).toBeGreaterThan(0);
      for (const p of c.profiles) expect(PROFILES).toContain(p);
      expect(new Set(c.profiles).size).toBe(c.profiles.length);
    }
  });

  it('annotation-gated cards are excluded from the cold-graph profile (whole-card N/A at 0%)', () => {
    const manifest = loadManifest();
    for (const c of manifest.cards) {
      if (c.applies_when === 'has_annotations') {
        expect(c.profiles).not.toContain('cold-graph');
        expect(c.profiles).toContain('annotated');
      }
    }
    // and at least one card is annotation-gated, so this guard is not vacuous
    expect(manifest.cards.some(c => c.applies_when === 'has_annotations')).toBe(true);
  });
});
