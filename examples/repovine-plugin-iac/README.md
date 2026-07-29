# Example plugin: `repovine-plugin-iac`

Minimal **third-party IaC plugin** — a dependency-free parser for fictional `edge-stack.json`.
Copy this directory as a starting point for your own `repovine-plugin-<format>`.

Full walkthrough: [docs/plugin-authoring.md](../../docs/plugin-authoring.md).

## Layout

```
repovine-plugin-iac/
  index.js              # plugin descriptor (IaC parsers)
  run.mjs               # optional conformance + integration check
  fixtures/sample/      # tiny repo with edge-stack.json
  package.json          # repovine manifest
```

## Optional author verification

This is not required to install or use the plugin. Run it while modifying the
example to check the plugin contract and its Stage-1/2 output. From the repovine
repo root:

```bash
npm run build
node examples/repovine-plugin-iac/run.mjs
```

Expected: conformance passes, **1 infra module**, **2 lambdas**, **2 entrypoints** (HTTP + queue
consumer), resource edges projected by core interpreters.

## Use in another repo

```bash
npm i -D repovine-plugin-iac   # or file:/path/to/this/directory
```

```jsonc
{ "plugins": { "defaults": true, "add": ["repovine-plugin-iac"] } }
```

## What it demonstrates

| Contract point | Where |
|---|---|
| `parse()` emits `{ kind, resources }` only | `index.js` |
| Per-resource `contentHash` (producer-owned) | `index.js` `hashResourcePayload` |
| Custom trigger types → entrypoints | `package.json` `declarations.triggerTypes` (`edge-http`, `edge-queue`) |
| IaC facts → runtime resources/edges with no new interpreter | `run.mjs` Stage-2 compose |
| Conformance self-check | `run.mjs` → `checkIaCPluginConformance` |

For production, use `definePlugin` / `defineIaCParser` from `@repovine/plugin-sdk` — see the guide.
