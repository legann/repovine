# Plugin boundary migration inventory

Status: Stage 1 inventory, recorded 2026-07-29. The private packages under
`packages/plugins/*` are compile/package scaffolds only. Production still uses
the legacy paths below; this is intentional until the contract and migrations
in later stages are complete.

This file is a removal checklist for Stage 8. A path leaves the list only when
its replacement is active through the common plugin loading path and the
baseline fixtures remain unchanged.

## Built-in implementation homes

- `src/source-plugins/typescript/**`
- `src/source-plugins/python/**`
- `src/iac-plugins/sam/**`
- `src/iac-plugins/kubernetes/**`
- `src/iac-plugins/helm/**`
- `src/iac-plugins/terraform/**`
- `src/iac-plugins/vercel/**`
- `src/iac-plugins/dockerfile/**`
- `src/iac-plugins/docker-compose/**`

These trees continue to contain the production implementations in Stage 1.
The workspace packages do not re-export them through relative/private paths.

## Composition and process-global registration

| Path | Legacy responsibility |
|---|---|
| `src/stage1/source/bootstrap.ts` | Imports the two source implementations by relative core path, owns `INTERNAL_SOURCE_PLUGINS`, registers them as an import side effect, and resets the global source registry. |
| `src/stage1/iac/bootstrap.ts` | Imports the seven IaC implementations by relative core path, owns `INTERNAL_IAC_PLUGINS` and parser precedence, registers them as an import side effect, and rebuilds the global IaC registry. |
| `src/stage1/source/registry.ts` | Holds the process-global ordered source-plugin array and first-registered-wins file routing. |
| `src/stage1/iac/registry.ts` | Holds the process-global parser array, plugin ownership map, and kind/resource/trigger metadata maps. |
| `src/stage1/plugin-loader.ts` | Owns the pre-public `source-plugin` / `iac-plugin` manifest, resets both registries to the built-in arrays, and adds external packages to those global registries. |

The new `@repovine/plugin-default-preset` package is deliberately not imported
by these files in Stage 1.

## Runtime consumers that trigger or depend on the legacy registries

| Path | Legacy dependency |
|---|---|
| `src/stage1/index.ts` | Side-effect imports the source bootstrap, reads the source registry, and conditionally invokes the legacy external loader. |
| `src/stage1/worker.ts` | Side-effect imports the source bootstrap inside worker isolates and reads the source registry. |
| `src/stage1/infra.ts` | Side-effect imports the IaC bootstrap and routes documents through the global parser registry. |
| `src/agents/validation.ts` | Imports the source bootstrap and uses registry-derived index and module-name normalization during validation. |
| `src/analysis/architecture/detector-bootstrap.ts` | Imports the source bootstrap before composing architecture detectors. |
| `src/analysis/architecture/heuristics.ts` | Imports the source bootstrap and reads source suffix/index metadata from the registry. |
| `src/analysis/architecture/surfaces/ui.ts` | Reads source-plugin UI-surface capability metadata from the registry. |
| `src/annotations/module-kind.ts` | Imports the source bootstrap and reads UI-surface capability metadata when classifying modules. |
| `src/cli/init.ts` | Imports the source bootstrap and reads known source extensions while generating initial configuration. |
| `src/graph/module-files.ts` | Imports the source bootstrap and uses registry-derived suffix/index normalization for module files. |
| `src/interpreters/infra-runtime-links/graph.ts` | Imports both bootstraps and reads source/IaC registries while linking infrastructure resources to runtime modules. |
| `src/stage2/bundle-output-loader.ts` | Imports the source bootstrap and normalizes bundle output module suffixes through the registry. |
| `src/stage2/domains-advisor.ts` | Imports the source bootstrap and uses registry-owned source-extension rules. |
| `src/stage2/domains.ts` | Imports the source bootstrap and strips source suffixes through the registry. |
| `src/stage2/index.ts` | Reads registry-owned source index-basename and suffix normalization during Stage 2 projection. |
| `src/stage2/module-label.ts` | Imports the source bootstrap and strips module-id suffixes through the registry. |
| `src/stage2/runtime/trigger-entry-kind.ts` | Imports the IaC bootstrap and reads trigger-type metadata from the IaC registry. |
| `src/mcp/scope/resolve.ts` | Side-effect imports the source bootstrap before using registry-derived suffix and naming rules. |
| `src/mcp/index.ts` | Reads source-plugin lifecycle hooks from the global registry during shutdown. |
| `src/mcp/lib/dependencies/package-boundaries.ts` | Reads source normalization from the global registry. |

## Direct core-to-implementation imports

These are not bootstrap sites, but they also cross the target physical
boundary and must be removed or inverted before the final gate:

- `src/cli/health.ts` imports Python detection directly from
  `src/source-plugins/python/discover.ts`.
- `src/mcp/lib/dependencies/impact.ts` imports TypeScript call-graph policy
  directly from `src/source-plugins/typescript/call-graph.ts`.

## Stage 1 invariant

All paths above remain active and behavior-compatible with the Stage 0
baseline. The new packages are present in the installed `repovine` tarball but
carry `activation: "scaffold-only"` and do not change discovery, parsing,
projection, ids, worker behavior, CLI, MCP, cache, or annotations.
