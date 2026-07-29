import { validatePluginManifest } from './manifest.js';
import { validatePluginRuntimeDescriptor } from './descriptor.js';
import { checkProjectionRefs, validateProjectionBatch } from './projection-schema.js';
import type { AcceptedProjectionBatch } from './projection-schema.js';
import { makeResourceId } from './resource-identity.js';
import type { ResourceIdentity } from './resource-identity.js';
import type {
  ProjectionFactSelector,
  ReadonlyFactRecord,
  ReadonlyFactView,
  ReadonlyModuleFact,
} from './projection.js';
import type { ConformanceCheck, ConformanceReport } from '../conformance.js';

/**
 * Conformance for the unified plugin contract.
 *
 * A plugin author runs this to claim compatibility; the built-ins run the same kit, so the bar is
 * one bar. It asks the questions the host asks at load and composition time: does the manifest
 * validate, does the descriptor agree with it, and does every projected batch survive the untrusted
 * boundary — shape, budgets, extension ownership, reference resolution and determinism.
 */

export interface PluginConformanceInput {
  /** The `package.json#repovine` payload, exactly as it will be published. */
  manifest: unknown;
  /** The entry module's default export. */
  descriptor: unknown;
  /** Modules a projector may reference, standing in for the host's fact view. */
  modules?: readonly ReadonlyModuleFact[];
  /** Facts a projector's `requires` selectors will see. */
  facts?: readonly ReadonlyFactRecord[];
  /** Runtime resources the graph already holds, which a projected reference can point at. */
  resources?: readonly ResourceIdentity[];
  /** Repository root handed to projectors. Defaults to a neutral placeholder. */
  repoRoot?: string;
}

function check(name: string, ok: boolean, detail?: string): ConformanceCheck {
  return detail === undefined ? { name, ok } : { name, ok, detail };
}

function reportOf(checks: ConformanceCheck[]): ConformanceReport {
  return { passed: checks.every(c => c.ok), checks };
}

function factViewOf(
  modules: readonly ReadonlyModuleFact[],
  facts: readonly ReadonlyFactRecord[],
  resourceIds: ReadonlySet<string>,
): ReadonlyFactView {
  const byId = new Map(modules.map(module => [module.moduleId, module]));
  return {
    hasModule: (moduleId: string) => byId.has(moduleId),
    moduleIds: () => [...byId.keys()],
    module: (moduleId: string) => byId.get(moduleId),
    hasResource: (identity: ResourceIdentity) => resourceIds.has(makeResourceId(identity)),
    select: (selector: ProjectionFactSelector) => facts.filter(fact => fact.schema === selector.schema),
  };
}

/**
 * Run the plugin conformance kit. Every check is a question with one answer; the report lists them
 * in the order the host would ask them, so the first failure is also the first thing to fix.
 */
export function checkPluginConformance(input: PluginConformanceInput): ConformanceReport {
  const checks: ConformanceCheck[] = [];

  const manifest = validatePluginManifest(input.manifest);
  checks.push(check('package.json#repovine is a valid plugin manifest', manifest.ok, manifest.ok ? undefined : manifest.error));

  const descriptor = validatePluginRuntimeDescriptor(input.descriptor);
  checks.push(check('default export is a valid runtime descriptor', descriptor.ok, descriptor.ok ? undefined : descriptor.error));
  if (!manifest.ok || !descriptor.ok) return reportOf(checks);

  checks.push(check(
    'manifest id and descriptor id agree',
    manifest.manifest.id === descriptor.descriptor.id,
    manifest.manifest.id === descriptor.descriptor.id
      ? undefined
      : `manifest "${manifest.manifest.id}" vs descriptor "${descriptor.descriptor.id}"`,
  ));

  const pluginId = descriptor.descriptor.id;
  const projectors = descriptor.descriptor.capabilities.projectors ?? [];
  if (projectors.length === 0) {
    checks.push(check('projection checks', true, 'skipped — the descriptor declares no projector'));
    return reportOf(checks);
  }

  const modules = input.modules ?? [];
  const facts = input.facts ?? [];
  const knownResourceIds = new Set((input.resources ?? []).map(makeResourceId));
  const view = factViewOf(modules, facts, knownResourceIds);
  const projectionInput = { repoRoot: input.repoRoot ?? '/repo', facts: view };
  const accepted: AcceptedProjectionBatch[] = [];

  for (const projector of projectors) {
    let batches;
    try {
      batches = projector.project(projectionInput);
    } catch (e) {
      checks.push(check(`projector "${projector.id}" does not throw`, false, (e as Error).message));
      continue;
    }
    if (!Array.isArray(batches)) {
      checks.push(check(`projector "${projector.id}" returns an array of batches`, false, typeof batches));
      continue;
    }

    const seen = new Set<string>();
    let firstInvalid: string | undefined;
    let duplicate: string | undefined;
    for (const candidate of batches) {
      const result = validateProjectionBatch(candidate, { pluginId });
      if (!result.ok) {
        firstInvalid ??= result.error;
        continue;
      }
      if (seen.has(result.batch.batchId)) duplicate ??= result.batch.batchId;
      seen.add(result.batch.batchId);
      accepted.push({ pluginId, contributorId: projector.id, batch: result.batch });
    }
    checks.push(check(
      `projector "${projector.id}" emits batches that pass the projection schema and budgets`,
      firstInvalid === undefined,
      firstInvalid,
    ));
    checks.push(check(
      `projector "${projector.id}" batch ids are unique within the contributor`,
      duplicate === undefined,
      duplicate === undefined ? undefined : `duplicate batchId "${duplicate}"`,
    ));

    let second;
    try {
      second = projector.project(projectionInput);
    } catch (e) {
      checks.push(check(`projector "${projector.id}" is deterministic`, false, (e as Error).message));
      continue;
    }
    checks.push(check(
      `projector "${projector.id}" is deterministic for identical input`,
      JSON.stringify(second) === JSON.stringify(batches),
    ));
  }

  const problems = checkProjectionRefs({
    accepted,
    knownModuleIds: new Set(modules.map(module => module.moduleId)),
    knownResourceIds,
  });
  checks.push(check(
    'every projected reference resolves against the global index',
    problems.length === 0,
    problems[0]
      ? `${problems[0].reason} in batch "${problems[0].batchId}" of "${problems[0].contributorId}"`
      : undefined,
  ));

  return reportOf(checks);
}
