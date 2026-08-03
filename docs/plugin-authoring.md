# Authoring a repovine plugin

Third-party plugins extend repovine through one public SDK boundary with two complementary stages:

- **producers** extract facts from individual artifacts — source imports, exports and `semanticHints`,
  or resources from an IaC document;
- **projectors** read the completed repository fact view and contribute bounded semantics — resources,
  links from a closed relation vocabulary, entrypoints and namespaced extensions.

Core validates both stages and retains ownership of graph ids, paths, provenance, graph application
and the canonical ontology (`NodeType`/`EdgeKind`). Plugins never name a node or edge type directly.

The SDK exposes the few engine-defined spellings a producer must use. An import that resolves to a
package rather than a file is reported as `packageNodeId(name)`, so a plugin does not reproduce the id
format from a sample. A per-resource `contentHash` is produced with `hashResourcePayload(payload)`:
the SDK owns the digest, width and canonicalization because the hash drives runtime-resource freshness.
Two parsers reading the same resource must agree, so key order carries no meaning, array order does,
and a key set to `undefined` is the same fact as an absent key.

The complete taxonomy of public producers and projectors, and core-only interpreters, detectors and
delivery mechanics, is defined in [DESIGN.md](../DESIGN.md#extension-families-and-boundaries).

> **Status: API 1 is preview.** `@repovine/plugin-sdk` is at `0.1.0` and the runtime contract is
> `apiVersion: 1`. The two are separate axes: the npm version of the SDK and the runtime `apiVersion`
> a manifest declares move independently, and the pairing is published in
> [`plugin-api-compatibility.md`](plugin-api-compatibility.md).
>
> Preview means an export can still be removed, renamed or tightened. That arrives as the next minor
> SDK line and a changelog entry, so **stay on the current minor line and read the release notes before
> upgrading** (`^0.1.0` stays within `0.1.x`). `apiVersion: 1` says which contract you wrote against;
> it is not yet a compatibility promise.
>
> Preview ends on one written condition: a plugin authored outside this repository, by someone who did
> not write the SDK, from this document alone, published and loaded against the published tarballs —
> with every gap it exposes closed. Then `@repovine/plugin-sdk@1.0.0` and API 1 stable.
>
> What holds today regardless: the exported surface is inventoried and diffed on every build
> (`test/laws/plugin-api-report.test.ts`, `docs/plugin-api-report.md`), the runtime half of it is
> registered in writing (`docs/plugin-api-contract.json`), an incompatible `apiVersion` is refused at
> load, and four subpaths are the only way in — `@repovine/plugin-sdk`, `/plugin`, `/source-plugin`,
> `/iac-plugin`. A fifth, `/internal`, resolves and is host machinery: it is outside semver, outside
> API 1, and a law fails the build on a plugin that imports it.

## Quick start — copy an example

The fastest path is to copy one of the working examples and adapt it:

| Example | Kind | Copy from |
|---|---|---|
| Go (source) | `source-plugin` | [`examples/repovine-plugin-go/`](https://github.com/legann/repovine/blob/main/examples/repovine-plugin-go/) |
| edge-stack (IaC) | `iac-plugin` | [`examples/repovine-plugin-iac/`](https://github.com/legann/repovine/blob/main/examples/repovine-plugin-iac/) |

Each example is self-contained:

```
examples/repovine-plugin-go/
  index.js              # the plugin
  run.mjs               # optional conformance + integration check
  fixtures/sample/      # tiny repo the plugin analyzes
  package.json          # npm manifest + repovine block
```

`run.mjs` is not part of plugin installation or normal repovine use. It is an
optional executable check for plugin authors: it validates the contract against
the included fixture and shows how the core projects the emitted facts.

Run it from the repovine repo root after modifying an example (requires
`npm run build` first):

```bash
node examples/repovine-plugin-go/run.mjs
node examples/repovine-plugin-iac/run.mjs
```

Both scripts: (1) run the SDK conformance kit, (2) symlink the plugin into the fixture's
`node_modules` (same as `npm i` would), (3) run the real Stage-1 pipeline on `fixtures/sample/`,
(4) print facts and what the **core** projected from them (API entrypoints or runtime resources).

### Author workflow (Path B — your own npm package)

```
1. cp -r examples/repovine-plugin-go my-repovine-plugin-rust
2. Edit index.js (or src/index.ts): fileMatch, discover(), extract() / parsers[]
3. Replace fixtures/sample/ with minimal files your plugin should understand
4. Optionally run node run.mjs while adapting the plugin
5. Wrap with definePlugin + declare the manifest + peerDep on @repovine/plugin-sdk
6. npm publish (or npm pack / file: link for local use)
7. Users: npm i -D my-repovine-plugin-rust + list in repovine.config.json plugins.add
```

**Two repos, one mechanism:** your plugin is an npm package; the repo you analyze is separate.
The loader resolves plugins from **the analyzed repo's `node_modules`**, not from where repovine is
installed (CLI, MCP, embed — same rule, like ESLint plugins).

## Two ways to contribute a language/format

| Path | What it is | Cost | When |
|---|---|---|---|
| **A — PR into the core** | Your plugin is adopted as a built-in and ships inside the `repovine` tarball. | maintenance budget on the core | broad languages the maintainers choose to guarantee |
| **B — your own npm package** | You publish `repovine-plugin-<lang>`; users install it into the repo they analyze. | ~zero for the core | the long tail |

Both author against the **same** SDK surface (`definePlugin`) — the built-ins are the dogfood.
Nothing below is private to the core.

## Anatomy of a plugin package

A plugin is a normal npm package with two halves: a `repovine` manifest in its `package.json` and a
runtime descriptor as the entry module's default export.

```jsonc
// package.json
{
  "name": "repovine-plugin-go",
  "type": "module",
  "main": "dist/index.js",
  "repovine": {
    "kind": "plugin",           // one transport kind; capabilities come from the descriptor
    "id": "go",                 // the descriptor must claim the same id
    "apiVersion": 1,            // must match the SDK contract major
    "entry": "dist/index.js",   // optional POSIX path; falls back to "main", then index.js
    "declarations": {           // optional JSON facts, read before any plugin code runs
      "ecosystem": "go"
    }
  },
  "peerDependencies": { "@repovine/plugin-sdk": "^0.1.0" }
}
```

### Declarations and capabilities

| Half | Form | Lives in | Lifetime |
|---|---|---|---|
| `declarations` | JSON data | `package.json#repovine` | retained when an executable capability is unavailable |
| `capabilities` | code | the entry module's descriptor | active while the plugin is selected and available |

The host reads and validates declarations before importing plugin code, so an unavailable executable
capability does not discard the facts that bound a scan. Disabling or removing the plugin removes its
declarations as well. Ownership is host-stamped from package identity: a declaration that spells its
own `declaredBy` is refused.

| Declaration | States |
|---|---|
| `dirs` | directory names this ecosystem owns, with a role and a reason |
| `values` | values this plugin adds to a canonical or namespaced axis |
| `resourceKinds` | resource metadata keyed by `(namespace, provider, kind)` |
| `triggerTypes` | trigger metadata and the canonical entrypoint kind it projects into |
| `runtimeActions` | the identity namespace a runtime call named in semantic hints writes to |

| Capability | Provides |
|---|---|
| `source` | `discover` / `extract` for one language or ecosystem |
| `iac` | infrastructure `parsers`, and the graph domain each kind they emit belongs to |
| `loaders` | document decoding, by loader id |
| `projectors` | bounded repository semantics: resources, links, entrypoints and extensions |

`capabilities.iac.kindDomains` sits with the parsers rather than in the manifest: it is metadata
about the kinds those parsers emit, and a kind with no parser to emit it names a domain nothing
reaches. A kind with no entry gets the host's derived `domain:infra-<kind>`.

`requires` and `available` sit on the descriptor and cover every capability, so a missing toolchain
produces one actionable message rather than a failure per file.

Arbitrary npm is never auto-installed: the user installs your package and lists it in
`config.plugins.add`, which is their trust decision.

### How a package is loaded

One path loads every plugin. The bundled defaults resolve from repovine's own installation and a
package you installed resolves from the analyzed repository; everything after that — manifest schema,
entry containment, descriptor validation, id agreement, provenance stamp — is the same code.

```
preset manifest / config.plugins.add
        │  package name
        ▼
resolve package.json ──► validate manifest ──► import entry ──► validate descriptor ──► install
```

The default selection is itself a manifest: `@repovine/plugin-default-preset` carries
`"kind": "preset"` and an ordered list of package names, and nothing imports its members. A preset is
data, so the isolates that ask which packages are selected do not pull nine implementations into
their module graph.

Every isolate that runs plugin code loads the set itself from the same serialisable spec — the
control plane from `config.plugins`, the Stage 1 pool from its worker data, the Stage 2 worker from
the snapshot. Your `extract()` runs in a worker isolate and your projector composes off the control
plane, exactly as a bundled plugin's does.

Both examples are authored through the SDK, which is what a production package does: the manifest
carries `apiVersion` so no descriptor holds a version number that goes stale, `walkRepository` is the
discovery traversal, and `hashResourcePayload` is the one content hash a producer mints. CI runs both
end to end, so a contract change that would break an author breaks them first.

### Path bases

Every public path field states which of three bases it is measured from, and the three are distinct
branded types, so passing one where another belongs is a compile error rather than a wrong answer.

| Type | Base | Spelling | Enter with |
|---|---|---|---|
| `HostPath` | absolute | the host's own separators | `asHostPath` |
| `RepoRelPath` | the repository root | POSIX, always `/` | `asRepoRelPath` |
| `PkgRelPath` | the package root | POSIX, always `/` | `asPkgRelPath` |

The field name carries the base too: `absPath`, `repoRelPath`, `pkgRelPath`, `repoRelDir`.

Two consequences worth stating, because both have caused defects:

- a monorepo module keeps its package segment in `repoRelPath`. `packages/app/src/index.ts` is not
  `src/index.ts`; `repoRelPath` is derived from `absPath` against the repository root, never renamed
  from `pkgRelPath`;
- when you key a map by absolute path, key it with `hostPathKey(absPath)`. On win32 the same file has
  more than one spelling, and the engine canonicalizes before merging producers' drafts — a map keyed
  on the raw string registers one file twice.

### Source plugin

```ts
import {
  asPkgRelPath,
  asRepoRelPath,
  definePlugin,
  hostPathKey,
  walkRepository,
} from '@repovine/plugin-sdk';
import type { SourceExtractInput, SourceExtractResult, SourceRuntimeCapability } from '@repovine/plugin-sdk';

const goSource: SourceRuntimeCapability = {
  fileMatch: { extensions: ['.go'] },
  capabilities: {
    extensions: ['.go'],
    // Ecosystem facts the ENGINE applies when it mints module ids. Declare the suffixes that are
    // not part of a module's identity, and any basename standing for its own directory.
    moduleIdNormalize: { stripSuffixes: ['.go'] },
  },

  // Pass 1 — discovery (NO AST). Return packages + candidate files keyed by absolute path.
  // Each entry is a PendingModuleDraft: absPath, pkg, pkgRelPath — and NO moduleId. The engine mints
  // `mod:<pkg>/<path>` from pkg + pkgRelPath, so a plugin never spells that format itself.
  // `walkRepository` is the traversal: it prunes what the graph never indexes (dependency trees,
  // build output, test layouts) and enumerates in an order that does not depend on the filesystem,
  // so a plugin keeps no skip list of its own.
  discover(repoRoot, options) {
    const pkg = {
      name: 'go-app',
      repoRelDir: asRepoRelPath('.'),
      sourcePluginId: 'go',
    };
    const packages = [pkg];
    const pendingByAbsPath = new Map();
    walkRepository(repoRoot, {
      onFile: ({ absPath, repoRelPath, name }) => {
        if (!name.endsWith('.go')) return;
        // Canonical key: the engine merges producers' drafts on one key form, and on win32 the same
        // file spelled two ways would register twice.
        pendingByAbsPath.set(hostPathKey(absPath), {
          absPath,
          pkg,
          pkgRelPath: asPkgRelPath(repoRelPath),
          sourcePluginId: 'go',
        });
      },
    });
    return { packages, pendingByAbsPath };
  },

  // Pass 2 — extract SEMANTICS ONLY, keyed back to the engine-minted PendingModule.moduleId.
  // The engine reads the file and computes the hash (input.sourceByModuleId); never set
  // id/absPath/pkgRelPath/contentHash on the delta — those fields are not on the return type.
  extract(input: SourceExtractInput): SourceExtractResult {
    const deltas = input.pendingModules.map(pm => ({
      moduleId: pm.moduleId,
      imports: /* ImportInfo[] */ [],
      exports: /* ExportInfo[] */ [],
      semanticHints: { webFramework: 'gin', routes: [/* ... */] },
    }));
    return { deltas, reused: 0, rescanned: deltas.length };
  },
};

export default definePlugin({
  id: 'go',
  // Optional graceful degradation: declare an external prerequisite and a probe. When `available()`
  // resolves `{ ok: false }` the engine skips the plugin with ONE warning instead of failing per file.
  requires: { runtime: 'go' },
  available() {
    return hasGoToolchain() ? { ok: true } : { ok: false, reason: 'go not found on PATH' };
  },
  capabilities: { source: goSource },
});
```

The nested `capabilities` inside `goSource` is the source capability's own language metadata —
extensions and id-normalisation rules the engine applies. The outer `capabilities` is the
descriptor's capability set.

The cross-language contract is **`semanticHints`** — a versioned, `passthrough` bag. The SDK publishes
the version (`SEMANTIC_HINTS_VERSION`) and the verdict (`validateSemanticHints`); the schema behind
them stays private, so a producer branches on a verdict and the schema is free to change shape. It has
ten slots with different reach: four carry values any ecosystem can produce, two assume a framework
that serves requests, and four describe web or JavaScript shapes. Fill the ones your ecosystem has.

An interpreter is gated on the facts a repository carries, never on who produced them. Fill a slot
and the interpreter that reads it runs for your plugin the same way it runs for a bundled one.

| Interpreter | Runs when |
|---|---|
| `code-structure` | always |
| `infra-runtime-links` | always |
| `server-entrypoints` | any module carries `routes` |
| `ui-entrypoints` | any module carries `routes` or `conditionalRenders` |
| `server-templates` | the snapshot carries `templates` facts |

| Slot | Reach | Filled by | Read by |
|---|---|---|---|
| `envVars` | any ecosystem | TypeScript, Python | config surface, annotation quality, dump |
| `effectImports` | any ecosystem | Python | side-effect vocabulary |
| `webFramework` | any ecosystem — open string | TypeScript, Python | server and UI entrypoints |
| `routes` | serves requests | TypeScript, Python | server and UI entrypoints, edges |
| `hasRoutes` | serves requests | TypeScript, Python | entrypoint listing |
| `conditionalRenders` | renders a UI | TypeScript | UI entrypoints |
| `security` | web — `kind` is a closed set of eight, three of them browser storage and cookies | TypeScript | config surface, architecture detail |
| `ssr` | JavaScript — eight of its ten fields name JS directives and exports | TypeScript | module kind, architecture heuristics |
| `ui` | JavaScript — component trees, lifecycle effects | TypeScript | UI entrypoints |
| `runtimeActions` | any ecosystem — `action` is an open string paired with a declaration | TypeScript | side-effect vocabulary, module kind, publish edges |

Five qualifications the table cannot hold:

- `runtimeActions.action` is an open string. What a producer names there reaches a resource only
  through a `runtimeActions` declaration that states the namespace the call writes to.
- `ssr.runsOn` and `ssr.dataLoader` read as ecosystem-neutral and are derived from the eight
  JavaScript markers beside them. Nothing in the engine branches on either; only `useServer` and
  `useClient` are read.
- `ui` validates as any object. The `Ui*` types describe what a producer may emit, not what the
  schema checks.
- `routes` projects into an API entrypoint only when `syntax` is `decorator` or `call` and `kind` is
  `api`. A route with any other provenance is carried but not projected.
- A `routes` entry with `kind` `frontend` and `syntax` `call` projects only when `framework` is
  `tanstack-router` or `angular`. `markup` and `table` project on their own; a `layout` route also
  needs `framework` and `fileType`.

`imports` and `exports` are not slots — they are required fields of `SemanticModuleDelta`, beside
`semanticHints` rather than inside it.

### IaC plugin

```ts
import { definePlugin, defineIaCParser } from '@repovine/plugin-sdk';

const pulumiParser = defineIaCParser({
  kind: 'pulumi',
  fileMatch: { fileNames: ['Pulumi.yaml'] },
  loaderId: 'yaml',
  supports(absPath, doc) { /* ... */ return true; },
  // Emit SEMANTICS ONLY: { kind, resources }. The engine stamps id/paths/module hash.
  parse(absPath, repoRelPath, doc) {
    return { kind: 'pulumi', resources: [/* InfraResource[] */] };
  },
});

export default definePlugin({
  id: 'pulumi',
  capabilities: { iac: { parsers: [pulumiParser] } },
});
```

Resource and trigger metadata are declarations, not code — they belong in `package.json#repovine`:

```jsonc
"declarations": {
  "ecosystem": "pulumi",
  "resourceKinds": [
    { "namespace": "pulumi", "provider": "pulumi", "kind": "function", "hasCodeHandler": true }
  ],
  "triggerTypes": [
    { "type": "pulumi-http", "namespace": "pulumi", "provider": "pulumi", "entrypointKind": "api" }
  ],
  "runtimeActions": [
    { "action": "pulumi.publish", "namespace": "pulumi" }
  ]
}
```

A kind with no declared domain lands in `domain:infra-<kind>`, so an unlisted kind gets its own
bucket rather than another plugin's.

What each declaration buys:

| Declared | The host then |
|---|---|
| `hasCodeHandler` | resolves the resource's `handler` attribute to a module, and gives that module the resource's env bindings |
| `service` | publishes the label beside a `publishes` edge in runtime topology |
| `isStreamLike` | draws `consumes` from the trigger source to the resource it drives |
| `entrypointKind` | projects the trigger into that canonical entrypoint |
| `runtimeActions` | pairs a `runtimeActions` hint from any producer with a resource in the named namespace |

A trigger type declared with a `provider` and no `namespace` answers for every namespace that
provider mints; one declared with both answers only for that pair. Nothing is inferred from a
resource id: an undeclared kind is a node with no linking, not a guess.

### Projectors — contributing repository semantics

A parser or extractor emits facts about one artifact. A **projector** reads the finished fact view of
the whole repository and contributes bounded semantics from it: graph links, resources and entrypoints,
plus namespaced extensions stored beside the graph. This is where a relation between two artifacts
belongs — routing, publication or deployment.

```ts
const orbitRoutes: ProjectionContributor = {
  id: 'orbit-routes',
  // Fact SCHEMAS, never producer ids. Your projector runs when the facts exist, whoever published
  // them, and one plugin's output is never another's input inside the same build.
  requires: [{ schema: 'orbit/service@1' }],
  project(input: ReadonlyProjectionInput): readonly PluginProjectionBatch[] {
    const services = input.facts.select({ schema: 'orbit/service@1' });
    return [{
      batchId: 'routes',
      delta: {
        links: services.map(s => ({
          from: { type: 'resource', namespace: 'orbit', localKey: String(s.value.key) },
          to: { type: 'module', moduleId: String(s.value.handler) },
          relation: 'routes-to',
          because: 'the orbit service names this handler',
        })),
      },
    }];
  },
};
```

The closed vocabulary has six relations: `publishes`, `consumes`, `binds-to`, `uses-env`, `routes-to`
and `builds-from`. `builds-from` says the target is the build document the source was produced from,
which is a different claim from `binds-to` ("runs as").

To link to an infrastructure document — a build recipe, a deployment manifest — read the documents the
graph holds and reference the id it hands you:

```ts
const recipes = input.facts.infraModules({ kind: 'my-format' });
const match = recipes.find(recipe => recipe.repoRelPath.endsWith('/build.myformat'));
if (match) links.push({
  from: { type: 'resource', namespace: 'mine', localKey: 'checkout' },
  to: { type: 'module', moduleId: match.moduleId },
  relation: 'builds-from',
  because: 'the unit names this recipe',
});
```

Never assemble `infra:<kind>:<path>` yourself — the id format is the engine's, and `infraModules()`
exists so a plugin reads it rather than reproduces it.

**Composition is two-phase and order-independent.** Every batch from every plugin is collected first,
then validated, stamped and budgeted, then ids are minted and a global reference index is built, then
references and conflicts resolve, and only then are nodes and resources applied before links. Reversing
the order plugins were registered in changes nothing a reader can see.

| Property | What it means for you |
|---|---|
| **references** | `ProjectionRef` names a `module`, `resource` or `extension`. Both resource and module refs resolve against everything the graph holds, not only your own contributions — and `module` covers infrastructure documents as well as code modules. Ask `input.facts.hasModule` / `hasResource` first when the target is optional |
| **batch atomicity** | a batch applies whole or not at all. An invalid batch leaves none of its nodes behind and does not touch your other batches or any other plugin's work |
| **dangling reference** | takes down its batch, not the build. Drop the link yourself when the target may be absent |
| **provenance** | host-stamped from package identity. You never write `declaredBy`, plugin id, package name or version; a contribution that spells its own owner is refused |
| **minted ids** | the engine mints them. A contribution that supplies a node id where an identity component belongs is refused |
| **budgets** | `PROJECTION_BUDGETS` caps contributions per batch. Over budget is a refusal naming your contributor |
| **conflicts** | two plugins declaring the same key with the same effect is one record with both owners. Different effects is a conflict, and it drops **both** sides while naming both — no winner is picked |
| **determinism** | your `project()` is called twice by the conformance kit and must return the same batches |

### Extensions — namespaced data core carries but never interprets

When a fact has no canonical DTO, contribute a namespaced **extension** instead of bending one.

```ts
extensions: [{
  schema: 'orbit/deployment@1',
  localKey: 'checkout-deployment',
  subjectRef: { type: 'resource', namespace: 'orbit', localKey: 'checkout' },
  payload: { rolloutStrategy: 'blue-green' },
}]
```

An extension lands in a sidecar store, not in the graph. It reaches `inspect_node` on its subject,
travels through the worker, the dump and the cache, and is echoed verbatim. It is never a node: it does
not appear in `map_context` or `search_context`, and no graph algorithm reads it. The payload must be
JSON-serializable, and the schema namespace must be one you own — the host stamps the owner and refuses
an extension claiming another plugin's namespace.

### Built-in parity

Bundled plugins compile against the published SDK alone: each lives in its own package under
`packages/plugins/`, and a boundary law fails the build on an import of engine or SDK internals. A
bundled plugin states its ecosystem the way an installed one does: the engine grants no privilege
based on plugin identity, and a plugin outside this repository can say everything a bundled plugin
says.

Every isolate that runs plugin code loads the set from the same serialisable spec.

| Isolate | Where the spec comes from |
|---|---|
| control plane | `config.plugins`, resolved by `collectRepositoryFactsAsync` |
| Stage 1 worker | `workerData.pluginSpec`, loaded before the first job |
| Stage 2 worker | `snapshot.plugins`, loaded before composition |
| `repovine doctor`, `repovine setup` | `ensurePluginsLoaded`, from the workspace config |

An installed source plugin extracts in the worker pool, and a build with projectors composes in the
Stage 2 worker: declaring either costs a plugin nothing.

## Enabling plugins (`repovine.config.json`)

In the **repo you analyze** (not the repovine install):

```jsonc
{
  "plugins": {
    "defaults": true,                 // bundled TS/Python/IaC preset on (auto by file-match)
    "add": ["repovine-plugin-go"],    // third-party — must be npm-installed in THIS repo
    "disable": ["python"]             // drop a bundled or added plugin by id
  }
}
```

- **Bundled language** → just have its files; the preset activates by file-match, zero config.
- **Third-party language/format** → `npm i -D repovine-plugin-go` + list it in `add`.
- **Drop a bundled one** → `disable: ["python"]`. `defaults: false` drops the whole preset.

Local development without publishing:

```bash
npm i -D "file:/absolute/path/to/my-repovine-plugin-go"
```

## Trust model

**An installed plugin is trusted executable code.** The engine imports your entry module into its own
process and calls it. There is no sandbox: no separate process, no permission set, no filesystem or
network confinement. A plugin can do anything the repovine process can do, and installing one is the
same trust decision as installing any other npm dependency.

Code trust and output validation are separate boundaries:

| Boundary | Treatment |
|---|---|
| plugin code | trusted execution — it runs in-process without confinement |
| plugin output | untrusted data — source and IaC deltas and projection batches are schema-validated |

This distinction is not configurable per plugin. Bundled and independently installed plugins pass
through the same output-validation path.

Validation is applied to what a plugin returns, so a malformed fact is dropped with a refusal instead
of corrupting the graph. The verdict is what the SDK publishes (`checkPluginConformance` and the
`validate*` functions); the raw schemas are deliberately not exported, so a plugin depends on the
answer rather than on the shape of the check.

An untrusted marketplace would need process isolation, a permission model or a container, and none of
those exists today. A verified-origin badge in a catalog is a social signal and gives no isolation.

### Refusals a plugin can be given

Every one of these names the plugin and the reason, and none of them is silent.

| Refusal | When |
|---|---|
| incompatible `apiVersion` | the manifest value does not match `PLUGIN_API_VERSION` |
| manifest invalid | `kind`, `id` or `declarations` fail the schema — an unknown declaration key rejects the whole package |
| entry escapes the package | `entry` resolves outside the package directory |
| id disagreement | the manifest id and the descriptor id differ |
| declaration ambiguous | two plugins declare the same key with different effects |
| fact rejected | a published fact fails its schema, or names a schema the plugin does not own |
| file claimed twice | two parsers claim one document `exclusive` |

`apiVersion` is the only compatibility gate. Nothing else about your package — name, author, registry
— changes how it is loaded.

## Conformance — self-certify before you publish

Run the conformance kit against your plugin. Both example `run.mjs` scripts do this first.

```ts
import { checkPluginConformance, checkSourcePluginConformance } from '@repovine/plugin-sdk';
import descriptor from '../index.js';
import pkg from '../package.json' with { type: 'json' };

const contract = checkPluginConformance({ manifest: pkg.repovine, descriptor });
const behaviour = await checkSourcePluginConformance(
  { ...descriptor.capabilities.source, id: descriptor.id },
  { sampleRepoRoot: 'fixtures/sample' },
);
for (const report of [contract, behaviour]) {
  if (report.passed) continue;
  for (const c of report.checks.filter(c => !c.ok)) console.error(`FAIL ${c.name}: ${c.detail ?? ''}`);
  process.exit(1);
}
```

| Kit | Asks |
|---|---|
| `checkPluginConformance` | manifest validates, descriptor validates, both claim the same id, projected batches pass shape, budgets, extension ownership, reference resolution and determinism |
| `checkSourcePluginConformance` | discover/extract shape, fact schemas pass, semantics only (no engine-owned mechanics), deterministic `extract()` |
| `checkIaCPluginConformance` | parser gating, fact schemas pass, semantics only (`kind` + `resources`), deterministic `parse()` |

A bundled first-party plugin and an independently installed one run the same kits: shipping in the
box is packaging, not privilege.

## Governance — permissionless

The core owns the **contract**, not the **ecosystem**. Anyone may publish `repovine-plugin-*`.

| Lever | What it is | Gate type |
|---|---|---|
| Default preset | which bundled plugins are selected by default | strongest "allow" |
| Path A (adoption) | merge plugin into core | full control, costs maintenance |
| Verified tier (registry) | social badge in a catalog | **social**, not runtime |
| Conformance kit | objective self-cert bar | objective, self-served |
| Contract validation + `apiVersion` | loader validates the package contract and version; output that fails validation is dropped | runtime enforcement |

There is no per-plugin trust flag. A bundled plugin and an installed one are validated by the same
code; the difference is ownership, bundling and default selection.

Package and module nodes carry their `sourcePluginId` as provenance — who produced this node. No
interpreter is handed the set of producers, and nothing in the engine branches on the value.
`semanticHints` is versioned (`SEMANTIC_HINTS_VERSION`); new slots are additive, not breaking.

## What stays in the core (never a plugin)

- **Canonical interpreters** (facts → canonical nodes/edges) and **the graph schema**
  (`NodeType`/`EdgeKind`). Plugins may contribute through the bounded projector contract, but they do
  not define node or edge types.
- **Architecture detectors** — the opinion/curation layer.
- **Delivery mechanics** — graph/annotation signals projected through core response and hook contracts.

Use `semanticHints` for normalized module facts, declarations for ecosystem metadata, projectors for
repository-wide resources, links and entrypoints, and namespaced extensions for data with no canonical
meaning yet.

## SDK reference

Package: [`packages/plugin-sdk/`](https://github.com/legann/repovine/blob/main/packages/plugin-sdk/) (`@repovine/plugin-sdk`).

Built-in producers (Path A reference): `packages/plugins/`.

Integration test (minimal external plugin E2E): `test/integration/external-source-plugin.test.ts`.
