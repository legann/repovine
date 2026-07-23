import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACTS_DIR_NAME } from '../paths.js';
import { serializeKeyedRecordFile } from '../fs/keyed-json.js';
import { normalizeRisks } from '../annotations/format.js';
import { parentModuleId } from './scope/resolve.js';
import type { RepovineState } from './types.js';

/**
 * Build-emitted, path-keyed boundary index under `.repovine/`. The pre-edit boundary-notice hook
 * reads it standalone — no running server, O(1) per edited file. It is the deterministic backstop for
 * the same `node → boundary` lookup that `inspect_node`'s attention block surfaces on the pull path;
 * both derive the boundary risk from the SAME structured source (`scope: "boundary"` risks via
 * {@link normalizeRisks}), so delivery never depends on a ranked/fuzzy selection.
 */
export const BOUNDARY_INDEX_FILENAME = 'boundary-index.json';

/**
 * On-disk schema version of the boundary index. The pre-edit hook checks it verbatim
 * (`index.version !== 1`) as a standalone JS string it cannot import; the boundary-index unit test
 * locks that literal to this constant so a bump cannot land in one place only.
 */
export const BOUNDARY_INDEX_VERSION = 1 as const;

/** One boundary-carrying node owned by a file. A file can own several (its module plus exports). */
export interface BoundaryIndexEntry {
  /** Graph node id carrying the `scope:"boundary"` risk (module / export-symbol / template / infra). */
  nodeId: string;
  /** Human label for the node, best-effort from the graph. */
  label?: string;
  /** `scope:"boundary"` risk texts, verbatim, in stored order. */
  risks: string[];
}

export interface BoundaryIndexFile {
  version: 1;
  builtAt: string;
  /** Repo-relative forward-slash path → boundary entries on nodes the file owns. */
  entries: Record<string, BoundaryIndexEntry[]>;
}

export function boundaryIndexFilePath(repoRoot: string): string {
  return path.join(repoRoot, ARTIFACTS_DIR_NAME, BOUNDARY_INDEX_FILENAME);
}

/** Boundary-scoped risk texts on one annotation, in stored order (empty when none). */
function boundaryRiskTexts(risks: Parameters<typeof normalizeRisks>[0]): string[] {
  return normalizeRisks(risks)
    .filter((risk) => risk.scope === 'boundary')
    .map((risk) => risk.text);
}

/**
 * Repo-root-relative, forward-slash path from an absolute file path. Matches exactly what the pre-edit
 * boundary hook computes (`relative(repoRoot, editedPath)`), so module/export keys line up with the
 * path the editor touches. `repoRoot` is the snapshot root the graph was built for, which is also the
 * dir that owns `.repovine` and the root the hook resolves against.
 */
function toRepoRel(repoRoot: string, absFilePath: string): string {
  return path.relative(repoRoot, absFilePath).split(path.sep).join('/');
}

/**
 * Resolve the annotated node to the repo-root-relative file the editor would touch. Modules/infra/
 * templates map to their own path; an export-symbol inherits its parent module's file. Domains and
 * runtime resources have no single owning file (a domain spans many; a resource is an infra
 * projection), so they are absent from the path index — the pull path still carries them via
 * inspect_node.
 *
 * A module's `relativeFilePath` is package-relative (relative to its package root), so in a monorepo it
 * drops the package-dir prefix and would not match the hook's repo-root-relative lookup. Key modules
 * and their exports by the absolute `filePath` made relative to the snapshot root instead. Infra and
 * template paths are already repo-root-relative, so they are used as stored.
 */
function resolveNodeRelPath(state: RepovineState, nodeId: string): string | undefined {
  const repoRoot = state.snapshot.repoRoot;
  if (nodeId.startsWith('mod:')) {
    const mod = state.modulesById.get(nodeId);
    return mod?.filePath ? toRepoRel(repoRoot, mod.filePath) : mod?.relativeFilePath;
  }
  if (nodeId.startsWith('export:')) {
    const moduleId = parentModuleId(state.graph, nodeId);
    const mod = moduleId ? state.modulesById.get(moduleId) : undefined;
    return mod?.filePath ? toRepoRel(repoRoot, mod.filePath) : mod?.relativeFilePath;
  }
  if (nodeId.startsWith('infra:')) {
    return state.snapshot.infraModules?.find((im) => im.id === nodeId)?.relativeFilePath;
  }
  if (nodeId.startsWith('template:')) {
    return state.snapshot.templates?.find((t) => t.id === nodeId)?.relPath;
  }
  return undefined;
}

/**
 * Project the annotation store into a path-keyed boundary index. Pure over `state`; deterministic —
 * keys and per-file entries are sorted, so the same graph + annotations yield byte-identical output.
 */
export function buildBoundaryIndex(state: RepovineState): BoundaryIndexFile {
  const byPath = new Map<string, BoundaryIndexEntry[]>();
  for (const [nodeId, stored] of Object.entries(state.annotations.getAll())) {
    const risks = boundaryRiskTexts(stored.annotation?.risks);
    if (risks.length === 0) continue;
    const relPath = resolveNodeRelPath(state, nodeId);
    if (!relPath) continue;
    const label = state.graph.nodes.get(nodeId)?.label;
    const entry: BoundaryIndexEntry = label ? { nodeId, label, risks } : { nodeId, risks };
    const list = byPath.get(relPath);
    if (list) list.push(entry);
    else byPath.set(relPath, [entry]);
  }

  const entries: Record<string, BoundaryIndexEntry[]> = {};
  for (const relPath of [...byPath.keys()].sort()) {
    entries[relPath] = byPath.get(relPath)!.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  }

  return { version: BOUNDARY_INDEX_VERSION, builtAt: state.builtAt, entries };
}

/** Write the boundary index to `.repovine/boundary-index.json`. Best-effort, mirrors onboarding-state. */
export function writeBoundaryIndex(repoRoot: string, state: RepovineState): void {
  try {
    const filePath = boundaryIndexFilePath(repoRoot);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const index = buildBoundaryIndex(state);
    const serialized = serializeKeyedRecordFile({ version: index.version, builtAt: index.builtAt }, 'entries', index.entries);
    fs.writeFileSync(filePath, serialized, 'utf-8');
  } catch (err) {
    console.error(`[WARN] Failed to write repovine boundary index: ${(err as Error).message}`);
  }
}

/** Read the boundary index if present and well-formed. Used by tests; the hook reads it inline. */
export function readBoundaryIndex(repoRoot: string): BoundaryIndexFile | undefined {
  try {
    const filePath = boundaryIndexFilePath(repoRoot);
    if (!fs.existsSync(filePath)) return undefined;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<BoundaryIndexFile>;
    if (raw.version !== BOUNDARY_INDEX_VERSION || typeof raw.entries !== 'object' || raw.entries === null) return undefined;
    return raw as BoundaryIndexFile;
  } catch {
    return undefined;
  }
}
