# Plugin API compatibility

Two versions govern a plugin, on separate axes.

| Axis | Where it lives | What it answers |
|---|---|---|
| `apiVersion` | `package.json#repovine.apiVersion` in the plugin | which runtime contract the plugin was written against |
| SDK npm version | `@repovine/plugin-sdk` in the plugin's dependencies | which published types and helpers the plugin compiled against |
| engine npm version | `repovine` in the analyzed project | which implementation runs |

They are separate because they change for different reasons: the engine ships fixes and features
continuously, while the contract a plugin was written against must keep answering. An author reads
the pairing below, not the engine version.

## Matrix

| `apiVersion` | SDK range | Engine range | Status |
|---|---|---|---|
| 1 | `0.1.x` | `0.1.x` | current — stable-vs-preview **not yet declared** |

The status column is deliberately unresolved. `apiVersion: 1` being an integer does not make it a
stability promise; the promise is a separate decision, recorded here when it is taken. Until then an
author should read API 1 as: mechanically inventoried, refused on mismatch, and not yet covered by a
compatibility guarantee.

## What the runtime enforces today

| Check | Effect |
|---|---|
| `apiVersion` major differs from `PLUGIN_API_VERSION` | the plugin is refused at load, by name |
| manifest fails its schema | the whole package is refused — an unknown `declarations` key rejects it, not just that entry |
| `entry` resolves outside the package | refused |
| manifest id and descriptor id differ | refused |
| output fails validation | that delta or batch is dropped with a refusal; the build continues |

Nothing else gates loading. There is no allowlist, no registry check and no signature.

## What "compatible" covers

Compatibility is a claim about two things only:

1. the **exported SDK contract** — the names in [plugin-api-report.md](plugin-api-report.md) and their
   shapes;
2. the **observable runtime behaviour** — the lifecycle a plugin is driven through, the DTOs it
   exchanges, the refusals it can be given, and the composition semantics it can rely on.

It is not a claim about engine internals, the graph model, the source of any bundled plugin, or the
output of any particular analyzer. Those move freely.

## Surface inventory

[plugin-api-report.md](plugin-api-report.md) is generated from the built declaration files through the
SDK's own `exports` map, and `test/laws/plugin-api-report.test.ts` fails when it drifts. The count
there includes **type** exports; an earlier inventory in this project counted value exports only, so
the two numbers are not comparable measures of the same thing.

The four subpaths are the whole entrance:

| Subpath | For |
|---|---|
| `@repovine/plugin-sdk` | everything, re-exported |
| `@repovine/plugin-sdk/plugin` | manifest, descriptor, declarations, projection DTOs |
| `@repovine/plugin-sdk/source-plugin` | discovery, extraction, semantic hints |
| `@repovine/plugin-sdk/iac-plugin` | parsers, resources, identity |

The SDK publishes the `import` condition only, and withholds `./package.json`. `dist` and `src` are
not reachable as subpaths, so a private path does not resolve for an installed plugin — the resolver
refuses rather than the engine detecting it afterwards.

## Checklist — changing the public plugin API

Run through this before merging a change that touches `packages/plugin-sdk/src/**`.

1. **Regenerate the report.** `npm run api:report`, and read the diff. An unintended entry in that
   diff is the signal — the surface grew somewhere nobody looked.
2. **Classify the change.**

   | Change | Compatible with API 1 |
   |---|---|
   | new optional field on an input DTO | yes |
   | new export | yes |
   | new optional capability, declaration family or refusal reason | yes |
   | new **required** field on an input DTO | no |
   | removed or renamed export | no |
   | narrowed accepted value set, tightened schema | no |
   | changed meaning of an existing field | no — and worse, it compiles |

3. **An incompatible change needs API 2.** Not a silent break, and not a compatible-looking edit to
   API 1. Bump `PLUGIN_API_VERSION`, and decide the support window for API 1 explicitly.
4. **Check the author trees.** `test/laws/external-authors-import-only-public-sdk.test.ts` reads the
   canary fixtures and the published examples; they are what an author copies.
5. **Check the frozen fixture.** `test/fixtures/api-1-compat/` is a prebuilt plugin that is never
   recompiled. It must keep loading. See below.
6. **Run the gates that install rather than resolve.** `npm run smoke:sdk-standalone`,
   `npm run smoke:canary-plugins`, `npm run smoke:isolated-install`.
7. **Update the matrix above** if the pairing changed.

## The frozen API-1 fixture

`test/fixtures/api-1-compat/` holds a plugin written against API 1 as plain JavaScript, with no build
step and no `devDependencies`. It is loaded by the current engine exactly as installed, without being
recompiled.

That is the whole point. Every other gate compiles its plugin against the SDK of the same commit, so
a breaking type change is fixed in the fixture in the same diff and the gate stays green. This one
cannot be fixed by recompiling — the checked-in bytes are what an already-published plugin looks like.
A change that breaks it breaks every plugin already in the wild.

Do not regenerate it, reformat it, or update it to a newer idiom. If it must change, that change is
the API 2 conversation.
