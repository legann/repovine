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

## Use in another repo

```bash
npm i -D repovine-plugin-go   # or file:/path/to/this/directory
```

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
| Semantics only in `extract()` | `index.js` — no id/paths/hash on deltas |
| Routes → API entrypoints without a new interpreter | `semanticHints.routes` + `webFramework: 'gin'` |
| Conformance self-check | `run.mjs` → `checkSourcePluginConformance` |

For production, wrap the same object with `defineSourcePlugin` from `@repovine/plugin-sdk` and add
the SDK as a `peerDependency` — see the guide.
