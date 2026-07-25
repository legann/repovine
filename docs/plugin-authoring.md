# Authoring a repovine plugin

Third-party plugins extend repovine at one public boundary: the **fact layer**. A plugin emits *facts*
about an artifact (a source file's imports/exports/`semanticHints`, or an IaC document's resources);
the engine owns everything else — node ids, paths, content hashes, provenance, and the graph
ontology (`NodeType`/`EdgeKind`). You never name an edge or node type.

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

The examples ship as plain ESM objects (`index.js`) so they run without compiling the SDK at
runtime. Production packages should use the factories for types, `apiVersion` stamping, and the
conformance kit — the loader validates shape either way.

### Source plugin

```ts
import { defineSourcePlugin } from '@repovine/plugin-sdk';
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
  discover(repoRoot, options) {
    /* ...enumerate packages and .go files... */
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
`SEMANTIC_HINTS_VERSION`, `zSemanticHints`). Fill the framework-general slots (`routes`, `envVars`,
`ssr`, `security`, `webFramework`, …) and the core's interpreters project them for free — a new
backend language often needs **no** interpreter, only correct hints.

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
