import * as fs from 'node:fs';
import * as path from 'node:path';
import { PLUGIN_API_VERSION } from './runtime.js';
import { HASH_WIDTH, sha256Hex } from './content-hash.js';
import { validateSemanticModuleDelta, validateSemanticInfraDelta } from './fact-schemas.js';
import type { SourcePlugin, SourceExtractInput } from './source-plugin/types.js';
import { mintModuleId } from './source-plugin/module-id.js';
import type { IaCPluginDescriptor } from './factory.js';
import type { PackageInfo, PendingModule, PendingModuleDraft, IaCParser } from './types.js';

/**
 * Conformance kit. A plugin author runs these checks against
 * their plugin to claim SDK compatibility — the objective, self-certified bar that keeps a bad
 * plugin from being blamed on repovine. It is a TEST HELPER, not a runtime gate: the loader's only
 * runtime check is apiVersion. The bundled plugins pass the same kit (dogfood).
 *
 * The checks encode the contract the engine enforces internally:
 *   - the plugin is authored against the current contract major (apiVersion);
 *   - it has the right shape (discover/extract or parsers);
 *   - its output passes the fact Zod schemas (so the untrusted boundary accepts it);
 *   - it emits SEMANTICS ONLY — never mechanical metadata the engine owns;
 *   - it is deterministic — same input twice yields identical output.
 */

export interface ConformanceCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ConformanceReport {
  passed: boolean;
  checks: ConformanceCheck[];
}

/** Keys the engine stamps. A producer delta that carries any of these is leaking mechanics. */
const MECHANICAL_KEYS = ['id', 'filePath', 'relativeFilePath', 'contentHash', 'packageName'];

function check(name: string, ok: boolean, detail?: string): ConformanceCheck {
  return detail === undefined ? { name, ok } : { name, ok, detail };
}

function reportOf(checks: ConformanceCheck[]): ConformanceReport {
  return { passed: checks.every(c => c.ok), checks };
}

/**
 * Run conformance checks against a source plugin. `sampleRepoRoot` should be a small repo the plugin
 * can discover (at least one file it owns) so the behavioral checks have something to extract; when
 * discovery yields nothing the behavioral checks are reported as skipped (ok) with a note.
 */
export async function checkSourcePluginConformance(
  plugin: SourcePlugin,
  opts: { sampleRepoRoot: string },
): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];

  checks.push(check('has string id', typeof plugin.id === 'string' && plugin.id.length > 0));
  checks.push(check(
    'apiVersion matches SDK major',
    plugin.apiVersion === undefined || plugin.apiVersion === PLUGIN_API_VERSION,
    plugin.apiVersion === undefined ? 'no apiVersion (authored via factory recommended)' : undefined,
  ));
  checks.push(check('has discover() function', typeof plugin.discover === 'function'));
  checks.push(check('has extract() function', typeof plugin.extract === 'function'));
  if (plugin.available) {
    let availOk = false;
    let detail: string | undefined;
    try {
      const a = await plugin.available();
      availOk = typeof a === 'object' && a !== null && typeof a.ok === 'boolean';
    } catch (e) {
      detail = `available() threw: ${(e as Error).message}`;
    }
    checks.push(check('available() returns { ok: boolean }', availOk, detail));
  }

  // Behavioral: discover the sample repo and extract once (+ again for determinism).
  let discovery: { packages: PackageInfo[]; pendingByPath: Map<string, PendingModuleDraft>; extractContext?: unknown };
  try {
    discovery = plugin.discover(opts.sampleRepoRoot, {});
  } catch (e) {
    checks.push(check('discover() does not throw', false, (e as Error).message));
    return reportOf(checks);
  }
  checks.push(check('discover() returns packages + pendingByPath', Array.isArray(discovery.packages) && discovery.pendingByPath instanceof Map));

  // The kit stands in for the engine, so it mints ids the same way a real build does: the plugin
  // under test never supplies one, and it sees exactly the ids it will see in production.
  const pendingModules: PendingModule[] = [...discovery.pendingByPath.values()].map(draft => ({
    ...draft,
    moduleId: mintModuleId(draft.pkg.name, draft.relPath, plugin.capabilities?.moduleIdNormalize),
  }));
  if (pendingModules.length === 0) {
    checks.push(check('behavioral extract checks', true, 'skipped — sample repo had no files this plugin owns'));
    return reportOf(checks);
  }

  const sourceByModuleId = new Map<string, { content: string; contentHash: string }>();
  for (const pm of pendingModules) {
    try {
      const content = fs.readFileSync(pm.filePath, 'utf-8');
      sourceByModuleId.set(pm.moduleId, { content, contentHash: sha256Hex(content, HASH_WIDTH.content) });
    } catch { /* unreadable file — plugin simply gets no source for it */ }
  }
  const input: SourceExtractInput = {
    repoRoot: opts.sampleRepoRoot,
    packages: discovery.packages,
    pendingModules,
    prevByPath: new Map(),
    absPathToId: new Map(pendingModules.map(pm => [pm.filePath, pm.moduleId])),
    sourceByModuleId,
    extractContext: discovery.extractContext,
    analysisVersion: 0,
  };

  let first;
  try {
    first = await plugin.extract(input);
  } catch (e) {
    checks.push(check('extract() does not throw', false, (e as Error).message));
    return reportOf(checks);
  }

  const deltaValidity = first.deltas.map(d => validateSemanticModuleDelta(d));
  const firstInvalid = deltaValidity.find(v => !v.ok);
  checks.push(check(
    'extract() deltas pass the fact schema',
    deltaValidity.every(v => v.ok),
    firstInvalid && !firstInvalid.ok ? firstInvalid.error : undefined,
  ));

  const leaking = first.deltas.find(d => MECHANICAL_KEYS.some(k => k in (d as unknown as Record<string, unknown>)));
  checks.push(check(
    'deltas emit semantics only (no engine-owned mechanics)',
    leaking === undefined,
    leaking ? `delta carries a mechanical key (one of ${MECHANICAL_KEYS.join(', ')})` : undefined,
  ));

  const second = await plugin.extract(input);
  checks.push(check(
    'extract() is deterministic for identical input',
    JSON.stringify(first.deltas) === JSON.stringify(second.deltas),
  ));

  return reportOf(checks);
}

/**
 * SDK-local mirror of the engine's fileMatch pre-filter (src/stage1/iac/registry.ts
 * parserMatchesFile): a parser with no fileMatch sees every candidate; otherwise the base
 * name must match one of extensions/fileNames/fileNamePatterns.
 */
function iacParserMatchesFile(parser: IaCParser, filePath: string): boolean {
  const fm = parser.fileMatch;
  if (!fm) return true;
  const base = path.basename(filePath);
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot).toLowerCase() : '';
  if (fm.extensions?.some(e => e.toLowerCase() === ext)) return true;
  if (fm.fileNames?.some(n => n === base)) return true;
  if (fm.fileNamePatterns?.some(re => re.test(base))) return true;
  return false;
}

/** Run conformance checks against an IaC plugin descriptor over a set of sample documents. */
export function checkIaCPluginConformance(
  descriptor: IaCPluginDescriptor,
  opts: { samples: Array<{ filePath: string; relPath: string; doc: unknown }> },
): ConformanceReport {
  const checks: ConformanceCheck[] = [];

  checks.push(check('has string id', typeof descriptor.id === 'string' && descriptor.id.length > 0));
  checks.push(check(
    'apiVersion matches SDK major',
    descriptor.apiVersion === undefined || descriptor.apiVersion === PLUGIN_API_VERSION,
  ));
  checks.push(check('has at least one parser', Array.isArray(descriptor.parsers) && descriptor.parsers.length > 0));
  checks.push(check(
    'every parser has supports()/parse()',
    descriptor.parsers.every(p => typeof p.supports === 'function' && typeof p.parse === 'function'),
  ));

  const SEMANTIC_KEYS = ['kind', 'resources'];
  // Mirror the engine's dispatch (src/stage1/infra.ts): per document, only parsers whose
  // fileMatch admits the file run, supports() gates before parse(), and the FIRST parser
  // that claims a doc wins — the rest never see it. Running every parser's parse() on every
  // sample (the old kit) would false-pass or false-fail parsers that legitimately assume
  // supports()/first-match pre-filtering.
  for (const sample of opts.samples) {
    for (const parser of descriptor.parsers) {
      if (!iacParserMatchesFile(parser, sample.filePath)) continue;

      let claims: boolean;
      try {
        claims = parser.supports(sample.filePath, sample.doc);
      } catch (e) {
        checks.push(check(`supports(${sample.relPath}) does not throw`, false, (e as Error).message));
        continue; // a throwing supports() cannot claim the doc under the engine
      }
      if (!claims) continue; // parser declined via supports() — correct gating, next parser

      // First claiming parser: exercise parse() exactly as the engine would, then stop.
      let out: ReturnType<typeof parser.parse>;
      try {
        out = parser.parse(sample.filePath, sample.relPath, sample.doc);
      } catch (e) {
        checks.push(check(`parse(${sample.relPath}) does not throw`, false, (e as Error).message));
        break;
      }
      if (out === null) {
        checks.push(check(
          `parse(${sample.relPath}) honors its supports() claim`,
          false,
          'supports() returned true but parse() returned null',
        ));
        break;
      }
      const v = validateSemanticInfraDelta(out);
      checks.push(check(`parse(${sample.relPath}) output passes the fact schema`, v.ok, v.ok ? undefined : v.error));
      const keys = Object.keys(out).sort();
      checks.push(check(
        `parse(${sample.relPath}) emits semantics only (kind + resources)`,
        keys.length === 2 && SEMANTIC_KEYS.every(k => keys.includes(k)),
        keys.join(','),
      ));

      // This family mints its own `InfraResource.contentHash`, and that value drives runtime-resource
      // freshness. A parser that folded a Map, a Set or an object it built by iteration can emit a
      // different hash for the same document on a second read, and the resource then looks changed
      // every build. The source kit asks the same question of `extract`; here it is the only place
      // a producer-owned hash can be caught being unstable.
      const again = parser.parse(sample.filePath, sample.relPath, sample.doc);
      checks.push(check(
        `parse(${sample.relPath}) is deterministic for identical input`,
        JSON.stringify(again) === JSON.stringify(out),
      ));
      break; // first-match precedence — mirror the engine's break
    }
  }

  return reportOf(checks);
}
