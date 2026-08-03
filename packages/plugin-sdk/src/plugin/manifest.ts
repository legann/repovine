import { z } from 'zod';
import { PLUGIN_API_VERSION } from '../runtime.js';
import { parseEntryPath, pluginContractIdProblem } from './ids.js';
import { zPluginDeclarationCatalog } from './declarations.js';
import type { PluginDeclarationCatalog } from './declarations.js';

/**
 * The serialisable half of a plugin package: `package.json#repovine`.
 *
 * One transport kind (`plugin`) carries every capability. What a package can do is read from its
 * runtime descriptor, so a package that gains an IaC parser beside its source extractor changes its
 * code, not its manifest kind.
 *
 * The host reads and validates this before importing any plugin code, which is what lets a
 * declaration catalog stay in effect while the executable capabilities are disabled.
 */

export const PLUGIN_MANIFEST_KIND = 'plugin' as const;
export type PluginManifestKind = typeof PLUGIN_MANIFEST_KIND;

/**
 * A preset package names plugin packages and carries no implementation.
 *
 * `kind` is a literal on both schemas, so one package is readable as a plugin or as a preset and
 * never as both. A preset that listed itself would be a plugin package with no entry.
 */
export const PRESET_MANIFEST_KIND = 'preset' as const;
export type PresetManifestKind = typeof PRESET_MANIFEST_KIND;

export interface PluginManifest {
  kind: PluginManifestKind;
  /** Stable plugin id. The runtime descriptor must repeat it; the host stamps it into provenance. */
  id: string;
  apiVersion: typeof PLUGIN_API_VERSION;
  declarations?: PluginDeclarationCatalog;
  /** Package-root-relative POSIX path to the entry module. Falls back to `main`, then `index.js`. */
  entry?: string;
}

/**
 * Manifest schema. `apiVersion` accepts the JSON spellings `1` and `"1"`; the version comparison
 * itself is `validatePluginManifest`'s job so an incompatible plugin gets a version diagnostic
 * rather than a schema error.
 */
export const zPluginManifest = z.strictObject({
  kind: z.literal(PLUGIN_MANIFEST_KIND),
  id: z.string(),
  apiVersion: z.union([z.string(), z.number()]),
  declarations: zPluginDeclarationCatalog.optional(),
  entry: z.string().optional(),
});

export type PluginManifestValidation =
  | { ok: true; manifest: PluginManifest; entrySegments?: string[] }
  | { ok: false; error: string };

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid manifest';
  const where = issue.path.join('.');
  return where ? `${where}: ${issue.message}` : issue.message;
}

/**
 * Validate one `package.json#repovine` payload.
 *
 * This is the only manifest schema in the product: the engine imports it rather than keeping a
 * second copy, so an author reading the SDK and the host reading the package agree by construction.
 * On success `entrySegments` carries the parsed entry path when the manifest declares one — the
 * host joins those segments against the package directory and re-checks containment there.
 */
export function validatePluginManifest(value: unknown): PluginManifestValidation {
  const parsed = zPluginManifest.safeParse(value);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const idProblem = pluginContractIdProblem(parsed.data.id, 'id');
  if (idProblem) return { ok: false, error: idProblem };

  const apiVersion = Number(parsed.data.apiVersion);
  if (!Number.isInteger(apiVersion)) {
    return { ok: false, error: `apiVersion "${String(parsed.data.apiVersion)}" is not an integer` };
  }
  if (apiVersion !== PLUGIN_API_VERSION) {
    return { ok: false, error: `apiVersion ${apiVersion} is incompatible with SDK v${PLUGIN_API_VERSION}` };
  }

  const manifest: PluginManifest = {
    kind: PLUGIN_MANIFEST_KIND,
    id: parsed.data.id,
    apiVersion: PLUGIN_API_VERSION,
    ...(parsed.data.declarations ? { declarations: parsed.data.declarations as PluginDeclarationCatalog } : {}),
    ...(parsed.data.entry === undefined ? {} : { entry: parsed.data.entry }),
  };

  if (parsed.data.entry === undefined) return { ok: true, manifest };
  const entry = parseEntryPath(parsed.data.entry);
  if (!entry.ok) return { ok: false, error: entry.error };
  return { ok: true, manifest, entrySegments: entry.segments };
}

/**
 * A preset: an ordered list of plugin package names selected by default.
 *
 * The list is data, not code. A composition root that imported its members would put every
 * implementation into the module graph of every isolate that reads the selection, and the host reads
 * it in isolates that go on to load a different set.
 */
export interface PresetManifest {
  kind: PresetManifestKind;
  id: string;
  apiVersion: typeof PLUGIN_API_VERSION;
  /** npm package names, in the order the preset states them. */
  plugins: string[];
}

export const zPresetManifest = z.strictObject({
  kind: z.literal(PRESET_MANIFEST_KIND),
  id: z.string(),
  apiVersion: z.union([z.string(), z.number()]),
  plugins: z.array(z.string().min(1)).min(1).max(256),
});

export type PresetManifestValidation =
  | { ok: true; manifest: PresetManifest }
  | { ok: false; error: string };

/** Validate one `package.json#repovine` payload that claims to be a preset. */
export function validatePresetManifest(value: unknown): PresetManifestValidation {
  const parsed = zPresetManifest.safeParse(value);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const idProblem = pluginContractIdProblem(parsed.data.id, 'id');
  if (idProblem) return { ok: false, error: idProblem };

  const apiVersion = Number(parsed.data.apiVersion);
  if (!Number.isInteger(apiVersion)) {
    return { ok: false, error: `apiVersion "${String(parsed.data.apiVersion)}" is not an integer` };
  }
  if (apiVersion !== PLUGIN_API_VERSION) {
    return { ok: false, error: `apiVersion ${apiVersion} is incompatible with SDK v${PLUGIN_API_VERSION}` };
  }

  // A duplicate name would load one package twice under one id; the second load is refused there,
  // so the list is held to naming each member once here.
  const seen = new Set<string>();
  for (const name of parsed.data.plugins) {
    if (seen.has(name)) return { ok: false, error: `plugins lists "${name}" twice` };
    seen.add(name);
  }

  return {
    ok: true,
    manifest: {
      kind: PRESET_MANIFEST_KIND,
      id: parsed.data.id,
      apiVersion: PLUGIN_API_VERSION,
      plugins: [...parsed.data.plugins],
    },
  };
}
