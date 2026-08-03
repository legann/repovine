# Example plugin: `repovine-plugin-go`

Minimal **third-party source plugin** — a regex-based Go parser (no `go` toolchain). Copy this
directory as a starting point for your own `repovine-plugin-<lang>`.

Full walkthrough: [docs/plugin-authoring.md](../../docs/plugin-authoring.md).

## Layout

```
repovine-plugin-go/
  index.js              # plugin (discover + extract)
  run.mjs               # optional conformance + integration check
  fixtures/sample/      # tiny repo the plugin analyzes (main.go, handlers.go)
  package.json          # repovine manifest
```

The fixture lives **inside the example** — not at the repovine repo root. In production your plugin
repo carries its own `test/fixtures/` the same way.

## Optional author verification

This is not required to install or use the plugin. Run it while modifying the
example to check the plugin contract and its Stage-1 output. From the repovine
repo root:

```bash
npm run build
node examples/repovine-plugin-go/run.mjs
```

Expected: conformance passes, **2 Go modules**, **3 API entrypoints** projected from
`semanticHints.routes` (GET `/health`, GET `/orders/:id`, POST `/orders`).

`run.mjs` calls the core route collector directly. In a graph build the built-in
`server-entrypoints` interpreter reads normalized `semanticHints.routes` from any
source plugin. The route facts gate projection; the producer id does not.

## Use in another repo

```bash
# This checked-in example is private and is not published:
npm i -D "file:/absolute/path/to/repovine/examples/repovine-plugin-go"

# After adapting and publishing a plugin under its own package name:
npm i -D my-repovine-plugin-go
```

The configuration below enables the package installed from this example
directory. After publishing an adaptation, use its published package name in
both the install command and `plugins.add`.

```jsonc
// repovine.config.json in the repo you analyze
{ "plugins": { "defaults": true, "add": ["repovine-plugin-go"] } }
```

The loader resolves the package from **that repo's** `node_modules`, not from where repovine is
installed. A missing install is skipped with a warning (never a hard error).

## What it demonstrates

| Contract point | Where |
|---|---|
| Manifest (`package.json#repovine`) | `package.json` |
| Resolve from analyzed repo's `node_modules` | `run.mjs` symlinks plugin into `fixtures/sample/node_modules` |
| Semantics only in `extract()` | `index.js` — engine-minted `moduleId` key; no producer-minted identity, path, or hash fields |
| Normalized route facts | `index.js` — `semanticHints.routes` + `webFramework: 'gin'` |
| Conformance self-check | `run.mjs` → `checkSourcePluginConformance` |

The example already uses `definePlugin` from `@repovine/plugin-sdk` and declares
the SDK as a `peerDependency`, which is the production authoring surface. See the
guide for packaging and publishing.
