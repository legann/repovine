import { describe, expect, it } from '@jest/globals';
import { BUILTIN_MANIFESTS } from '../../src/agents/manifests.js';
import { toolDefs } from '../../src/mcp/tool-defs.js';

// Law: a list that claims to name the whole tool surface is checked against the registry.
//
// `ALL_PUBLIC_TOOLS` in the agent manifests is a curated copy of the registry's namespace. The
// mismatch was present in the initial e49381b revision, not introduced by later drift:
// `suggest_domains_config` and `decline_advisory` were already registered but absent here. The cost is
// not cosmetic — a role's `allowedTools` is built from these lists, so a tool absent here is a tool the
// role cannot call, while the instruction beside it says to call it. Registry parity alone is not
// enough: role-specific capability floors keep specialist contracts from thinning silently.

const REGISTRY = new Set(toolDefs.map(def => def.name));

/** The role whose allowedTools is meant to be the whole public surface. */
const FULL_SURFACE_ROLE = 'main';

const REQUIRED_ROLE_CAPABILITIES = [
  {
    role: 'annotation-writer',
    tools: [
      'get_annotation_status',
      'get_annotation_merge_status',
      'merge_annotations',
      'validate_annotations',
      'inspect_node',
      'write_annotation',
      'refresh_context',
      'decline_advisory',
    ],
  },
] as const;

function allowedToolsOf(role: string): string[] {
  const manifest = BUILTIN_MANIFESTS.find(m => m.role === role);
  if (!manifest) throw new Error(`No manifest for role "${role}"; the law needs one to check.`);
  return [...manifest.allowedTools];
}

describe('core-laws a list naming the tool surface matches the registry', () => {
  it('has a registry to check against', () => {
    // A registry that went empty would make every assertion below pass without asking anything.
    expect(REGISTRY.size).toBeGreaterThan(10);
  });

  it('gives the full-surface role every registered tool', () => {
    const allowed = new Set(allowedToolsOf(FULL_SURFACE_ROLE));
    const missing = [...REGISTRY].filter(name => !allowed.has(name)).sort();

    expect(missing).toEqual([]);
  });

  it('names no tool the registry does not ship', () => {
    // The other direction: a renamed tool leaves a manifest entry that resolves to nothing.
    for (const manifest of BUILTIN_MANIFESTS) {
      const unknown = manifest.allowedTools.filter(name => !REGISTRY.has(name)).sort();
      expect({ role: manifest.role, unknown }).toEqual({ role: manifest.role, unknown: [] });
    }
  });

  it.each(REQUIRED_ROLE_CAPABILITIES)(
    'keeps the $role capability floor',
    ({ role, tools }) => {
      const allowed = new Set(allowedToolsOf(role));
      const missing = tools.filter(tool => !allowed.has(tool));

      expect({ role, missing }).toEqual({ role, missing: [] });
    },
  );
});
