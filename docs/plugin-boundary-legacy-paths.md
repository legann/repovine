# Plugin boundary migration inventory

Status: recorded 2026-07-29, after stage 7. Every plugin — bundled or independently installed —
reaches the engine through `src/plugins/load.ts`. The two named bootstrap files are gone, and no
file under `src/**` or `packages/plugin-sdk/src/**` names a product package.

This file was a removal checklist for stage 8. What remains on it is ecosystem semantics, not a
loading path.

## Built-in implementation homes

| Vertical | Home | Moved in |
|---|---|---|
| TypeScript, Python | `packages/plugins/source-*/src` | stage 5 |
| SAM, Kubernetes, Helm, Terraform, Vercel, Dockerfile, Compose | `packages/plugins/iac-*/src` | stage 6 |

## Composition and registration

Nothing is left. The table below records what each removed path did and what answers for it now.

| Removed | Replaced by |
|---|---|
| `src/stage1/source/bootstrap.ts` | the preset manifest names the package; the loader resolves and imports it |
| `src/stage1/iac/bootstrap.ts` | same, including the manifest read it did by hand |
| `src/stage1/source/registry.ts` | `src/plugins/source-set.ts` — the isolate's active set, installed whole |
| `src/stage1/iac/registry.ts` | `src/plugins/iac-set.ts` — same, for parsers, loaders and kind domains |
| `src/stage1/plugin-loader.ts` | `src/plugins/load.ts` — one path for bundled and installed packages |
| `@repovine/plugin-default-preset` source | the package's `package.json#repovine` manifest: nine names, no code |
| `defineIaCPlugin` / `IaCPluginDescriptor` | `definePlugin` and `capabilities.iac`, the one public descriptor |

`PRE_BOUNDARY_COMPOSITION_ROOTS` in `test/laws/plugin-workspace-boundary.test.ts` is an empty map.
Any core or SDK file importing a product package is a violation with no exception to fall into.

## Where the set is installed

Every isolate that runs plugin code loads it from the same serialisable spec.

| Isolate | Where the spec comes from |
|---|---|
| control plane | `config.plugins`, resolved by `collectRepositoryFactsAsync` |
| Stage 1 worker | `workerData.pluginSpec`, loaded before the first job |
| Stage 2 worker | `snapshot.plugins`, loaded before composition |
| `repovine doctor`, `repovine setup` | `ensurePluginsLoaded`, from the workspace config |
| test process | `test/jest.setup.ts`, the bundled preset |

Neither inline downgrade survives: an external source plugin extracts in the worker pool, and a
build with projectors composes off the control plane.

## Ecosystem knowledge still in core

Not loading paths; semantics stage 6 did not move and stage 7 did not reach.

| Path | What it still knows |
|---|---|
| `src/stage2/runtime-links.ts` | Kubernetes Ingress-to-Service routing, the namespace prefix an id shares, and the two Kubernetes kinds `shouldLinkResource` names. |
| `src/graph/resolve-infra-ref.ts` | A Kubernetes namespace comparison when resolving an infra scope. |
| `src/interpreters/infra-runtime-links/graph.ts` | Two node-data fields keyed on a provider: `k8sKind` and the Compose `dockerfile` attribute. |

Their honest form is a plugin projection — `routes-to` is already a canonical SDK contribution — and
the loading path that made it affordable is in place: a built-in that declares a projector no longer
moves Stage 2 composition off the worker.

## Direct core-to-implementation imports

None.
