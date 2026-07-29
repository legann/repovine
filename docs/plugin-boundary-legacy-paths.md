# Plugin boundary migration inventory

Status: recorded 2026-07-29, after stage 6-b. Both producer verticals ship as
workspace packages under `packages/plugins/*`. What remains is the loading path:
core reaches those packages through two named bootstrap files instead of
config-driven plugin loading.

This file is a removal checklist for Stage 8. A path leaves the list only when
its replacement is active through the common plugin loading path and the
baseline fixtures remain unchanged.

## Built-in implementation homes

Nothing is left. `src/source-plugins/**` moved in stage 5 and
`src/iac-plugins/**` in stage 6; both trees are gone, and two laws assert their
absence rather than the emptiness of a scan over them.

| Vertical | Home | Moved in |
|---|---|---|
| TypeScript, Python | `packages/plugins/source-*/src` | stage 5 |
| SAM, Kubernetes, Helm, Terraform, Vercel, Dockerfile, Compose | `packages/plugins/iac-*/src` | stage 6 |

## Composition and process-global registration

| Path | Legacy responsibility |
|---|---|
| `src/stage1/source/bootstrap.ts` | Names the two source packages, owns `INTERNAL_SOURCE_PLUGINS`, registers them as an import side effect, and resets the global source registry. |
| `src/stage1/iac/bootstrap.ts` | Names the seven IaC packages, owns `INTERNAL_IAC_PLUGINS`, registers them as an import side effect, rebuilds the global IaC registry, and reads their manifests from disk instead of receiving them from the plugin loader. |
| `src/stage1/source/registry.ts` | Holds the process-global ordered source-plugin array and first-registered-wins file routing. |
| `src/stage1/iac/registry.ts` | Holds the process-global parser array, plugin ownership map, document-loader table, and kind→domain map. |
| `src/stage1/plugin-loader.ts` | Resets both registries to the built-in arrays and adds external packages to those global registries. |

Both bootstrap files are named in `PRE_BOUNDARY_COMPOSITION_ROOTS` in
`test/laws/plugin-workspace-boundary.test.ts`, with the exact package set each
may import. Any other core or SDK file importing a product package is a
violation.

The `@repovine/plugin-default-preset` package is deliberately not imported by
these files: config-driven loading is stage 7.

## Runtime consumers that trigger or depend on the legacy registries

| Path | Legacy dependency |
|---|---|
| `src/stage1/index.ts` | Side-effect imports the source bootstrap, reads the source registry, and conditionally invokes the legacy external loader. |
| `src/stage1/worker.ts` | Side-effect imports the source bootstrap inside worker isolates and reads the source registry. |
| `src/stage1/infra.ts` | Side-effect imports the IaC bootstrap and routes documents through the global parser and loader registry. |
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
| `src/mcp/scope/resolve.ts` | Side-effect imports the source bootstrap before using registry-derived suffix and naming rules. |
| `src/mcp/index.ts` | Reads source-plugin lifecycle hooks from the global registry during shutdown. |
| `src/mcp/lib/dependencies/package-boundaries.ts` | Reads source normalization from the global registry. |

## Ecosystem knowledge still in core

These are not loading paths; they are the semantics stage 6 did not move.

| Path | What it still knows |
|---|---|
| `src/stage2/runtime-links.ts` | Kubernetes Ingress-to-Service routing, including the namespace prefix an id shares, and the two Kubernetes kinds `shouldLinkResource` names. |
| `src/graph/resolve-infra-ref.ts` | A Kubernetes namespace comparison when resolving an infra scope. |
| `src/interpreters/infra-runtime-links/graph.ts` | Two node-data fields keyed on a provider: `k8sKind` and the Compose `dockerfile` attribute. |

Resource-kind, trigger-type and runtime-action semantics left core in stage 6-b:
what carries code, where a runtime call writes, and the service label a topology
publishes are declarations the owning package states in
`package.json#repovine.declarations`.

The rows above are one piece of work. Their honest form is a plugin projection —
`routes-to` is already a canonical SDK contribution — and a built-in that
declares a projector moves Stage 2 composition off the worker for every default
build (`src/stage2/index.ts`, `composeRepositoryGraphAsync`). The single
plugin-loading path in stage 7 removes that cost; these move then.

## Direct core-to-implementation imports

None. The two named in the stage-1 inventory were resolved in stage 5: the
call-index budget is published by the SDK, and the doctor asks the plugin
registry instead of importing one ecosystem's probe.
