# @repovine/plugin-sdk

Preview package for authoring repovine source and IaC plugins.

This package owns the public fact-layer contract: plugin factories, producer fact types, semantic
hint schemas, runtime `apiVersion`, and conformance helpers. It deliberately does not expose
repovine graph ontology or projection internals.

**Start here:** [docs/plugin-authoring.md](../../docs/plugin-authoring.md) — full guide plus
copy-paste examples in [`examples/repovine-plugin-go/`](../../examples/repovine-plugin-go/) and
[`examples/repovine-plugin-iac/`](../../examples/repovine-plugin-iac/).

```ts
import { defineSourcePlugin, defineIaCPlugin } from '@repovine/plugin-sdk';
```

Scoped barrels:

```ts
import { defineSourcePlugin } from '@repovine/plugin-sdk/source-plugin';
import { defineIaCPlugin } from '@repovine/plugin-sdk/iac-plugin';
```
