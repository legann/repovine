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
| 1 | `0.1.x` | `0.1.x` | **preview** |

**API 1 is preview.** The integer `1` says which contract a plugin was written against. It is not a
stability promise, and preview is what says so. `0.y.z` carries the same signal: under SemVer it means
initial development.

| | preview `0.1.x` | stable `1.0.0` |
|---|---|---|
| changing the surface | an export may be removed, renamed or tightened; it arrives as a minor bump and a changelog entry | additive only; a break requires `apiVersion: 2` |
| what an author should assume | pin the exact version, read the release notes | `^1`, and that it keeps working |
| cost of a mistake in the surface | a changelog line | a compatible workaround, or API 2 |

Technically the two are the same code, the same `apiVersion: 1`, the same loader and the same
refusals. The difference is the promise, and the promise decides what may change next.

### Leaving preview

One condition, written down so preview has an end:

> A plugin written **outside this repository**, by someone who did not write the SDK, from
> [plugin-authoring.md](plugin-authoring.md) alone, published and loaded against the published
> tarballs — and every gap it exposes closed.

Then `@repovine/plugin-sdk@1.0.0` and API 1 stable. The engine keeps its own version line.

The measured reason for the condition: the one real integration performed so far exposed two gaps in
API 1, and before it no one had walked the authoring path end to end — both published examples were
broken, and both "external" canaries were written by the SDK's own author. A stability promise made
on that evidence would be a promise made on absent data.

### The named remainder under preview

The written register in [plugin-api-contract.json](plugin-api-contract.json) covers the **67 runtime
names** of the contract. The **155 type exports** beside them are registered by nothing. That is
acceptable under preview and is a condition of leaving it: the type surface gets the same pass the
runtime surface got.

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

Two files, and they answer different questions.

| File | Question | Kept by |
|---|---|---|
| [plugin-api-report.md](plugin-api-report.md) | what resolves today | generated from the built `.d.ts` through the `exports` map |
| [plugin-api-contract.json](plugin-api-contract.json) | which of it is contract | written by hand, reviewed on every surface change |

`test/laws/plugin-api-report.test.ts` fails when the two disagree, in either direction: a registered
name the build stopped publishing, and a published name nobody registered.

The register is written rather than derived from a consumer census, and the reason is measured. Across
all 78 runtime exports of the pre-move surface, counting importers put roughly 20 names in the wrong
bucket in both directions — `PLUGIN_API_VERSION`, `SEMANTIC_LINK_RELATIONS`, `PROJECTION_BUDGETS`,
`makeResourceId` and `validatePluginManifest` among them. A built-in writes the literal `'api'` rather
than importing the constant that publishes the closed vocabulary. The vocabulary is published so an
author *can* enumerate it, so a missing import disproves nothing.

Counts in the report include **type** exports; an earlier inventory in this project counted value
exports only, so the two numbers are not comparable measures of the same thing.

### Subpaths

Four authoring subpaths carry the contract:

| Subpath | For |
|---|---|
| `@repovine/plugin-sdk` | everything, re-exported |
| `@repovine/plugin-sdk/plugin` | manifest, descriptor, declarations, projection DTOs |
| `@repovine/plugin-sdk/source-plugin` | discovery, extraction, semantic hints |
| `@repovine/plugin-sdk/iac-plugin` | parsers, resources, identity |

One more subpath resolves and is **not** contract:

| Subpath | What it is |
|---|---|
| `@repovine/plugin-sdk/internal` | host machinery the engine imports because it is a separate package: the per-run layout table, the scan verdict halves, declaration stamping, canonical bytes and the digest over them |

`./internal` sits outside semver. Any name there may change or disappear in a patch release, and that
is not a break of API 1. It is excluded from the contract total, marked in the report, and refused for
every plugin — built-in, example, canary and third party — by
`test/laws/plugin-workspace-boundary.test.ts` and
`test/laws/external-authors-import-only-public-sdk.test.ts`. Reaching for something there means the
contract has a gap; the gap gets closed on the contract side, under a name chosen for authors.

The SDK publishes the `import` condition only, and withholds `./package.json`. `dist` and `src` are
not reachable as subpaths, so a private path does not resolve for an installed plugin — the resolver
refuses rather than the engine detecting it afterwards.

## Checklist — changing the public plugin API

Run through this before merging a change that touches `packages/plugin-sdk/src/**`.

1. **Regenerate the report.** `npm run api:report`, and read the diff. An unintended entry in that
   diff is the signal — the surface grew somewhere nobody looked.
2. **Update the register.** A runtime name added to or removed from an authoring subpath is a
   deliberate edit to [plugin-api-contract.json](plugin-api-contract.json). The law refuses the diff
   until the two agree, which is the point: the register is where the decision is recorded.
3. **Classify the change.**

   | Change | Compatible with API 1 |
   |---|---|
   | new optional field on an input DTO | yes |
   | new export | yes |
   | new optional capability, declaration family or refusal reason | yes |
   | new **required** field on an input DTO | no |
   | removed or renamed export | no |
   | narrowed accepted value set, tightened schema | no |
   | changed meaning of an existing field | no — and worse, it compiles |

4. **Route an incompatible change by the current status.** Under preview it is a minor SDK bump and a
   changelog entry naming what moved. Under stable it needs API 2: bump `PLUGIN_API_VERSION`, and
   decide the support window for API 1 explicitly. Neither is a silent break, and neither is a
   compatible-looking edit to API 1.
5. **Check the author trees.** `test/laws/external-authors-import-only-public-sdk.test.ts` reads the
   canary fixtures and the published examples; they are what an author copies.
6. **Check the frozen fixture.** `test/fixtures/api-1-compat/` is a prebuilt plugin that is never
   recompiled. It must keep loading. See below.
7. **Run the gates that install rather than resolve.** `npm run smoke:sdk-standalone`,
   `npm run smoke:canary-plugins`, `npm run smoke:isolated-install`.
8. **Update the matrix above** if the pairing changed.

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
