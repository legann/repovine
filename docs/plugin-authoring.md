# Authoring a repovine plugin

Third-party plugins extend repovine at one public boundary: the **fact layer**. A plugin emits *facts*
about an artifact (a source file's imports/exports/`semanticHints`, or an IaC document's resources);
the engine owns everything else — node ids, paths, content hashes, provenance, and the graph
ontology (`NodeType`/`EdgeKind`). You never name an edge or node type.

Two of those the SDK hands back, because a producer does have to write them. An import that resolves
to a package rather than a file is reported as `packageNodeId(name)` — the engine's own spelling of
the id, exported so a plugin matches it instead of reproducing it from a sample. And a per-resource
`contentHash` is `hashResourcePayload(payload)`: the SDK owns the digest, the width, and the
canonicalization, because this is the one hash a producer mints and it drives runtime-resource
freshness. Two parsers reading the same resource have to agree, so key order carries no meaning,
array order does, and a key set to `undefined` is the same fact as an absent key.

The complete taxonomy of public producers and core-only interpreters, detectors, and delivery
mechanics is defined in [DESIGN.md](../DESIGN.md#extension-families-and-boundaries).

> **Status:** the SDK (`@repovine/plugin-sdk`) is a **0.1.0 preview** package in this repo.
> Path B (out-of-tree community plugins) is open as a preview contract: publish/use plugins with
> conformance checks, expect semver-0 migration notes for breaking changes, and keep runtime
> compatibility gated by `package.json#repovine.apiVersion`.

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
5. Wrap with defineSourcePlugin / defineIaCPlugin + peerDep on @repovine/plugin-sdk
6. npm publish (or npm pack / file: link for local use)
7. Users: npm i -D my-repovine-plugin-rust + list in repovine.config.json plugins.add
```

**Two repos, one mechanism:** your plugin is an npm package; the repo you analyze is separate.
The loader resolves plugins from **the analyzed repo's `node_modules`**, not from where repovine is
installed (CLI, MCP, embed — same rule, like ESLint plugins).

## Two ways to contribute a language/format

| Path | What it is | Cost | When |
|---|---|---|---|
| **A — PR into the core** | Your plugin is adopted as a built-in, shipped with `repovine`, `trusted:true`. | maintenance budget on the core | broad languages the maintainers choose to guarantee |
| **B — your own npm package** | You publish `repovine-plugin-<lang>`; users install it; `trusted:false`. | ~zero for the core | the long tail |

Both author against the **same** SDK surface (`defineSourcePlugin` / `defineIaCPlugin`) — the
built-ins are the dogfood. Nothing below is private to the core.

## Anatomy of a plugin package

A plugin is a normal npm package that declares a `repovine` manifest in its `package.json` and
default-exports a plugin object built with an SDK factory.

```jsonc
// package.json
{
  "name": "repovine-plugin-go",
  "type": "module",
  "main": "dist/index.js",
  "repovine": {
    "kind": "source-plugin",   // or "iac-plugin"
    "apiVersion": "1",          // must match the SDK contract major
    "entry": "dist/index.js"    // optional; falls back to "main", then index.js
  },
  "peerDependencies": { "@repovine/plugin-sdk": "^0.1.0" }
}
```

Arbitrary npm is never auto-installed: the user installs your package and lists it in
`config.plugins.add`, which is their trust decision.

Both examples are authored through the SDK, which is what a production package does: the factories
stamp `apiVersion` so no descriptor carries a version number that goes stale, `walkRepository` is the
discovery traversal, and `hashResourcePayload` is the one content hash a producer mints. CI runs both
end to end, so a contract change that would break an author breaks them first. The loader validates
shape either way — the factories are what keep the mechanics from being written a second time.

### Source plugin

```ts
import { defineSourcePlugin, hostPathKey, walkRepository } from '@repovine/plugin-sdk';
import type { SourceExtractInput, SourceExtractResult } from '@repovine/plugin-sdk';

export default defineSourcePlugin({
  id: 'go',
  // Optional graceful-degradation: declare an external prerequisite and a probe. When `available()`
  // resolves `{ ok: false }` the engine skips the plugin with ONE warning instead of failing per file.
  requires: { runtime: 'go' },
  available() {
    return hasGoToolchain() ? { ok: true } : { ok: false, reason: 'go not found on PATH' };
  },
  fileMatch: { extensions: ['.go'] },
  capabilities: {
    extensions: ['.go'],
    // Ecosystem facts the ENGINE applies when it mints module ids. Declare the suffixes that are
    // not part of a module's identity, and any basename standing for its own directory.
    moduleIdNormalize: { stripSuffixes: ['.go'] },
  },

  // Pass 1 — discovery (NO AST). Return packages + candidate files keyed by absolute path.
  // Each entry is a PendingModuleDraft: filePath, pkg, relPath — and NO moduleId. The engine mints
  // `mod:<pkg>/<path>` from pkg + relPath, so a plugin never spells that format itself.
  // `walkRepository` is the traversal: it prunes what the graph never indexes (dependency trees,
  // build output, test layouts) and enumerates in an order that does not depend on the filesystem,
  // so a plugin keeps no skip list of its own.
  discover(repoRoot, options) {
    const pendingByPath = new Map();
    walkRepository(repoRoot, {
      onFile: ({ absPath, relFromRoot, name }) => {
        if (!name.endsWith('.go')) return;
        // Canonical key: the engine merges producers' drafts on one key form, and on win32 the same
        // file spelled two ways would register twice.
        pendingByPath.set(hostPathKey(absPath), { filePath: absPath, pkg, relPath: relFromRoot, sourcePluginId: 'go' });
      },
    });
    return { packages, pendingByPath };
  },

  // Pass 2 — extract SEMANTICS ONLY, keyed back to the engine-minted PendingModule.moduleId.
  // The engine reads the file and computes the hash (input.sourceByModuleId); never set
  // id/filePath/contentHash on the delta — those fields are not on the return type.
  extract(input: SourceExtractInput): SourceExtractResult {
    const deltas = input.pendingModules.map(pm => ({
      moduleId: pm.moduleId,
      imports: /* ImportInfo[] */ [],
      exports: /* ExportInfo[] */ [],
      semanticHints: { webFramework: 'gin', routes: [/* ... */] },
    }));
    return { deltas, reused: 0, rescanned: deltas.length };
  },
});
```

The cross-language contract is **`semanticHints`** — a versioned, `passthrough` bag (see
`SEMANTIC_HINTS_VERSION`, `zSemanticHints`). It has ten slots, and they differ in reach: three carry
values any ecosystem can produce, two assume a framework that serves requests, and five encode web,
JavaScript or AWS shapes in their own field types. Fill the ones your ecosystem has; the core's
interpreters project them with no new interpreter.

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
| `runtimeActions` | AWS — `action` is a closed set of four AWS calls | TypeScript | side-effect vocabulary, module kind |

Four qualifications the table cannot hold:

- `runtimeActions.action` is a closed union in the type **and** the schema. A non-AWS producer that
  fills the slot fails fact validation.
- `ssr.runsOn` and `ssr.dataLoader` read as ecosystem-neutral and are derived from the eight
  JavaScript markers beside them. Nothing in the engine branches on either; only `useServer` and
  `useClient` are read.
- `ui` validates as any object. The `Ui*` types describe what a producer may emit, not what the
  schema checks.
- `routes` projects into an API entrypoint only when `source` is `decorator` or `ast` and `kind` is
  `api`. A route with any other provenance is carried but not projected.

`imports` and `exports` are not slots — they are required fields of `SemanticModuleDelta`, beside
`semanticHints` rather than inside it.

### IaC plugin

```ts
import { defineIaCPlugin, defineIaCParser } from '@repovine/plugin-sdk';

const pulumiParser = defineIaCParser({
  kind: 'pulumi',
  fileMatch: { fileNames: ['Pulumi.yaml'] },
  docFormat: 'yaml',
  supports(filePath, doc) { /* ... */ return true; },
  // Emit SEMANTICS ONLY: { kind, resources }. The engine stamps id/paths/module hash.
  parse(filePath, relPath, doc) {
    return { kind: 'pulumi', resources: [/* InfraResource[] */] };
  },
});

export default defineIaCPlugin({
  id: 'pulumi',
  parsers: [pulumiParser],
  kindDomains: [{ kind: 'pulumi', meta: { domainId: 'domain:infra-pulumi', label: 'infra-pulumi', description: '…' } }],
});
```

### Built-in parity (0.1.0)

Bundled plugins may import engine internals the SDK does not export — the shared IaC helpers
(`src/stage1/iac/utils`) and, for Kubernetes, workload attribute enrichment
(`enrichK8sResourceAttributes`). An out-of-tree IaC plugin emits the same `InfraResource` facts and
reaches the same node/edge schema, but does not reproduce that Kubernetes enrichment in 0.1.0.
Exposing those helpers through the SDK is a post-0.1.0 API decision; the privileged boundary is a
documented limitation, not a frozen contract.

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

A config-loaded plugin is always **`trusted:false`**: the engine wraps its output in Zod validation
at the boundary (`zSemanticModuleDelta` / `zSemanticInfraDelta`) and drops malformed facts with a
warning instead of corrupting the graph. The **only** runtime compatibility gate is `apiVersion` —
a mismatched major is refused.

## Conformance — self-certify before you publish

Run the conformance kit against your plugin. Both example `run.mjs` scripts do this first.

```ts
import { checkSourcePluginConformance, checkIaCPluginConformance } from '@repovine/plugin-sdk';
import plugin from '../index.js';

const report = await checkSourcePluginConformance(plugin, {
  sampleRepoRoot: 'fixtures/sample',   // or test/fixtures/sample
});
if (!report.passed) {
  for (const c of report.checks.filter(c => !c.ok)) console.error(`FAIL ${c.name}: ${c.detail ?? ''}`);
  process.exit(1);
}
```

Checks: correct shape, fact schemas pass, **semantics only** (no engine-owned mechanics),
deterministic `extract()`.

## Governance — permissionless

The core owns the **contract**, not the **ecosystem**. Anyone may publish `repovine-plugin-*`.

| Lever | What it is | Gate type |
|---|---|---|
| Default preset | TS/Python/IaC built-ins, `trusted:true` | strongest "allow" |
| Path A (adoption) | merge plugin into core | full control, costs maintenance |
| Verified tier (registry) | social badge in a catalog | **social**, not runtime |
| Conformance kit | objective self-cert bar | objective, self-served |
| Contract + `apiVersion` | loader refuses incompatible major / failed Zod | **only runtime gate** |

Package and module nodes carry their `sourcePluginId`. `semanticHints` is versioned (`SEMANTIC_HINTS_VERSION`);
new slots are additive, not breaking.

## What stays in the core (never a plugin)

- **Interpreters** (facts → nodes/edges) and **the schema** (`NodeType`/`EdgeKind`).
  Route through `semanticHints` instead.
- **Architecture detectors** — the opinion/curation layer.
- **Delivery mechanics** — graph/annotation signals projected through core response and hook contracts.

## SDK reference

Package: [`packages/plugin-sdk/`](https://github.com/legann/repovine/blob/main/packages/plugin-sdk/) (`@repovine/plugin-sdk`).

Built-in producers (Path A reference): `src/source-plugins/`, `src/iac-plugins/`.

Integration test (minimal external plugin E2E): `test/integration/external-source-plugin.test.ts`.
