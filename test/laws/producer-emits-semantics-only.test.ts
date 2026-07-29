import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { dockerfileParser } from '../../packages/plugins/iac-dockerfile/src/parser.js';
import { kubernetesParser } from '../../packages/plugins/iac-kubernetes/src/parsers/workloads.js';
import { terraformParser } from '../../packages/plugins/iac-terraform/src/parser.js';
import { findFixturesRoot } from './graph-law-helpers.js';

// The "leveling" invariant:
// producers (source plugins + IaC parsers) emit LANGUAGE/FORMAT SEMANTICS ONLY; the engine owns and
// stamps everything mechanical/agnostic — node id, paths, packageName, contentHash, provenance — at
// the Stage-1 boundary. Two consequences are cemented here as runtime laws (transpile-only ts-jest
// will not fire compile-time guards, so these are real `it()` checks, not `satisfies`):
//   - core code never branches on a literal source-plugin/ecosystem id (the `=== 'typescript'` sweep)
//   - IaC parsers return a delta of exactly { kind, resources } — never module mechanics
//   - the engine stamps mechanical metadata onto every assembled module/infra fact
describe('core-laws producer emits semantics only (engine/producer boundary)', () => {
  function findSrcRoot(): string {
    const candidates = [
      path.resolve(process.cwd(), 'src'),
      path.resolve(process.cwd(), 'repovine', 'src'),
    ];
    const root = candidates.find(candidate => fs.existsSync(candidate));
    if (!root) throw new Error(`Could not find src root. Tried: ${candidates.join(', ')}`);
    return root;
  }

  // Producer directories own the SDK boundary and may name their own ecosystem id (a Python plugin
  // filtering to Python packages, a Vue SFC reading `lang="ts"`). Everything else is "core" and must
  // decide ownership by capability/id-equality, never by a hardcoded language literal.
  const PRODUCER_SEGMENTS = [
    `${path.sep}source-plugin${path.sep}`,
    `${path.sep}source-plugins${path.sep}`,
    `${path.sep}iac-plugin${path.sep}`,
    `${path.sep}iac-plugins${path.sep}`,
    `${path.sep}stage1${path.sep}source${path.sep}`,
  ];

  function* walkTsFiles(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* walkTsFiles(full);
        continue;
      }
      if (entry.isFile() && full.endsWith('.ts')) yield full;
    }
  }

  // Ecosystem / source-plugin ids that core must never branch on directly. A language-identity
  // decision can hide behind more than `=== 'typescript'`: `case 'python'`, `== 'go'`, and
  // `langs.includes('rust')` are the same law violation. The literal set also covers ecosystems the
  // engine has not grown into yet, so a new-language branch is red on arrival. Route-source / SFC-lang
  // discriminators (`'jsx'`, `'tsx'`, `'vue'`) are deliberately excluded — those are legitimate core
  // branches, not ecosystem ownership decisions.
  const LANG_LITERALS = String.raw`typescript|javascript|python|cpp|c\+\+|golang|go|rust|ruby|java|php|csharp`;
  const LANG_OPS = String.raw`===|!==|==|!=`;
  const LANG_IDENTITY_RE = new RegExp(
    // x === 'lang' / x != 'lang'
    String.raw`(?:${LANG_OPS})\s*['"](?:${LANG_LITERALS})['"]` +
      '|' +
      // 'lang' === x
      String.raw`['"](?:${LANG_LITERALS})['"]\s*(?:${LANG_OPS})` +
      '|' +
      // switch (…) { case 'lang':
      String.raw`\bcase\s+['"](?:${LANG_LITERALS})['"]` +
      '|' +
      // membership: xs.includes('lang')
      String.raw`\.includes\(\s*['"](?:${LANG_LITERALS})['"]`,
  );

  function isCommentLine(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
  }

  it('core code never branches on a literal ecosystem id (=== \'typescript\'/\'python\')', () => {
    const srcRoot = findSrcRoot();
    const offenders: string[] = [];
    for (const file of walkTsFiles(srcRoot)) {
      if (PRODUCER_SEGMENTS.some(seg => file.includes(seg))) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (isCommentLine(line)) return;
        if (LANG_IDENTITY_RE.test(line)) {
          offenders.push(`${path.relative(srcRoot, file)}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
    // A new language-identity branch in core is exactly the regression this law guards (tsc cannot
    // see it). Move the decision behind a SourcePluginCapability instead.
    expect(offenders).toEqual([]);
  });

  it('the ecosystem-id sweep catches every branch form, not just `=== \'typescript\'`', () => {
    // Locks the breadth of LANG_IDENTITY_RE. If the sweep is narrowed back to bare `===`, or a new
    // ecosystem literal is dropped, these forms stop matching and the law goes silently vacuous.
    const violations = [
      `if (adapterId === 'typescript') {`,
      `if (adapterId !== 'python') {`,
      `if (lang == 'go') {`,
      `if (lang != 'rust') {`,
      `switch (lang) { case 'ruby': break; }`,
      `case 'java':`,
      `if (adapterIds.includes('php')) {`,
      `if ('cpp' === ecosystem) {`,
      `if ('csharp' !== ecosystem) {`,
      `const t = id === 'javascript';`,
    ];
    for (const line of violations) {
      expect(LANG_IDENTITY_RE.test(line)).toBe(true);
    }

    // Legitimate core branches that name a NON-ecosystem discriminator or merely DECLARE a capability
    // manifest must stay out of the sweep; otherwise the law would flag correct code.
    const allowed = [
      `if (route.source === 'jsx') {`,
      `if (route.source !== 'config') continue;`,
      `sourceAdapterIds: ['typescript', 'python'],`,
      `if (status === 'ready') {`,
      `const exts = ['ts', 'tsx', 'js'];`,
    ];
    for (const line of allowed) {
      expect(LANG_IDENTITY_RE.test(line)).toBe(false);
    }
  });

  it('IaC parsers return a semantics-only delta (kind + resources + facts), never module mechanics', () => {
    // `facts` is the third semantic key: what the ecosystem knows about the document beyond the
    // canonical resource fields. Like the other two it says nothing about where the file sits.
    const SEMANTIC_KEYS = ['facts', 'kind', 'resources'];
    const MECHANICAL_KEYS = ['contentHash', 'filePath', 'id', 'relativeFilePath'];
    const deltas = [
      dockerfileParser.parse('/repo/Dockerfile', 'Dockerfile', 'FROM node:20\n'),
      terraformParser.parse('/repo/main.tf', 'main.tf', 'resource "aws_s3_bucket" "b" {}\n'),
      kubernetesParser.parse('/repo/dep.yaml', 'dep.yaml', {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'web' },
      }),
    ];
    for (const delta of deltas) {
      expect(delta).not.toBeNull();
      const keys = Object.keys(delta!).sort();
      expect(keys.filter(key => !SEMANTIC_KEYS.includes(key))).toEqual([]);
      for (const mechanical of MECHANICAL_KEYS) expect(keys).not.toContain(mechanical);
    }
  });

  it('the engine stamps mechanical metadata onto every assembled module/infra fact', async () => {
    // sam-lambda-app carries both TS modules and IaC resources, so one run exercises both producers
    // against the engine assembly boundary.
    const fixtureRoot = path.join(findFixturesRoot(), 'sam-lambda-app');
    const origLog = console.log;
    console.log = () => {};
    try {
      const snapshot = await collectRepositoryFactsAsync(fixtureRoot);

      expect(snapshot.modules.length).toBeGreaterThan(0);
      for (const mod of snapshot.modules) {
        expect(mod.id).toMatch(/^mod:/);
        expect(path.isAbsolute(mod.filePath)).toBe(true);
        expect(mod.relativeFilePath.length).toBeGreaterThan(0);
        expect(mod.packageName.length).toBeGreaterThan(0);
        expect(mod.contentHash).toMatch(/^[0-9a-f]{16}$/);
        expect(mod.sourcePluginId).toBeDefined();
      }

      expect((snapshot.infraModules ?? []).length).toBeGreaterThan(0);
      for (const infra of snapshot.infraModules ?? []) {
        expect(infra.id).toBe(`infra:${infra.kind}:${infra.relativeFilePath}`);
        expect(path.isAbsolute(infra.filePath)).toBe(true);
        expect(infra.contentHash).toMatch(/^[0-9a-f]{16}$/);
      }
    } finally {
      console.log = origLog;
    }
  });
});
