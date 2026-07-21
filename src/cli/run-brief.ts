/**
 * Pre-run prompt material for harnesses: the generic protocol brief derived
 * from a built-in capability manifest.
 *
 * Backed by `repovine agents run-brief` (CLI only — not an MCP tool).
 */
import type { AgentRole } from '../agents/protocol.js';
import { getManifest, getManifestByRole } from '../agents/manifests.js';
import { PROJECTION_VERSION, renderImplementerBrief } from './agent-projection.js';

export interface RunBriefOptions {
  role?: AgentRole;
  name?: string;
}

export interface RunBriefResult {
  protocolVersion: string;
  projectionVersion: string;
  role: string;
  name: string;
  brief: string;
}

export function resolveRunBriefManifest(role?: AgentRole, name?: string) {
  return name
    ? getManifest(name)
    : role
      ? getManifestByRole(role)
      : getManifestByRole('implementer');
}

export function buildRunBrief(
  options: RunBriefOptions,
): RunBriefResult | { error: string } {
  const manifest = resolveRunBriefManifest(options.role, options.name);
  if (!manifest) {
    return {
      error: `No built-in manifest for ${options.name ? `name "${options.name}"` : `role "${options.role ?? 'implementer'}"`}.`,
    };
  }

  return {
    protocolVersion: manifest.protocolVersion,
    projectionVersion: PROJECTION_VERSION,
    role: manifest.role,
    name: manifest.name,
    brief: renderImplementerBrief(manifest),
  };
}
