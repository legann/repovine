# Example plugin: `repovine-plugin-iac`

Minimal **third-party IaC plugin** — a parser for fictional `edge-stack.json`
with no format-specific parser dependency. Copy this directory as a starting
point for your own `repovine-plugin-<format>`.

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
# This checked-in example is private and is not published:
npm i -D "file:/absolute/path/to/repovine/examples/repovine-plugin-iac"

# After adapting and publishing a plugin under its own package name:
npm i -D my-repovine-plugin-iac
```

The configuration below enables the package installed from this example
directory. After publishing an adaptation, use its published package name in
both the install command and `plugins.add`.

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

The example already uses `definePlugin` and `defineIaCParser` from
`@repovine/plugin-sdk` and declares the SDK as a `peerDependency`, which is the
production authoring surface. See the guide for packaging and publishing.
