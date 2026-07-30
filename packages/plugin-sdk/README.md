# @repovine/plugin-sdk

Package for authoring repovine source and IaC plugins. Runtime contract `apiVersion: 1`, **status
preview**: an export can still be removed, renamed or tightened, arriving as a minor bump and a
changelog entry — pin the exact version. The pairing of SDK, `apiVersion` and engine, and the written
condition for leaving preview, are in
[docs/plugin-api-compatibility.md](../../docs/plugin-api-compatibility.md).

This package owns the public fact-layer contract: plugin factories, producer fact types, the
semanticHints version and verdict, runtime `apiVersion`, and conformance helpers. The graph ontology
and projection internals stay in the engine.

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

`@repovine/plugin-sdk/internal` also resolves. It is host machinery the engine imports across the
package boundary, it sits outside semver, and it is not part of API 1. A plugin that imports it will
break on a patch release.
