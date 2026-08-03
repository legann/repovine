# @repovine/plugin-sdk

Package for authoring repovine source and IaC plugins. Runtime contract `apiVersion: 1`, **status
preview**: an export can still be removed, renamed, or tightened in a minor release. Stay on the
current minor line (for example, `^0.1.0`) and read the release notes before moving to the next one.
The pairing of SDK, `apiVersion`, and engine, and the written condition for leaving preview, are in
[docs/plugin-api-compatibility.md](../../docs/plugin-api-compatibility.md).

This package owns the public authoring contract: plugin manifests and descriptors, source and IaC
producer facts, restricted projection DTOs, runtime `apiVersion`, and conformance helpers. Plugins
publish facts and contributions through these contracts; graph identities and ontology stay in the
engine.

**Start here:** [docs/plugin-authoring.md](../../docs/plugin-authoring.md) — full guide plus
copy-paste examples in [`examples/repovine-plugin-go/`](../../examples/repovine-plugin-go/) and
[`examples/repovine-plugin-iac/`](../../examples/repovine-plugin-iac/).

```ts
import { defineIaCParser, definePlugin, defineSourcePlugin } from '@repovine/plugin-sdk';
```

The same contract is available through focused authoring subpaths:

```ts
import { definePlugin } from '@repovine/plugin-sdk/plugin';
import { defineSourcePlugin } from '@repovine/plugin-sdk/source-plugin';
import { defineIaCParser } from '@repovine/plugin-sdk/iac-plugin';
```

The contract subpaths are the package root, `/plugin`, `/source-plugin`, and `/iac-plugin`.
`@repovine/plugin-sdk/internal` also resolves, but contains host machinery for the engine. It sits
outside semver and API 1; plugins must not import it.
