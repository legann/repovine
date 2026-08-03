# Contributing to repovine

> **Early / preview stage.** The graph schema still moves and the SDK is `0.1.0`.
> For anything non-trivial, **open an issue first** so we can place it — see
> [Where things live](#where-things-live).

## Ways to contribute

- **A new language or IaC format** — the main extension surface. Author a plugin
  against `@repovine/plugin-sdk`: you emit *facts* about a file (imports/exports/
  `semanticHints`, or IaC resources); the engine owns ids, paths, provenance, and
  the graph ontology — you never name a node or edge type. Two paths (PR into core
  vs your own npm package) in [docs/plugin-authoring.md](docs/plugin-authoring.md).
  Copy [`examples/repovine-plugin-go/`](examples/repovine-plugin-go/) or
  [`examples/repovine-plugin-iac/`](examples/repovine-plugin-iac/) as a starting
  point. Each example includes an optional `run.mjs` integration check for use
  while adapting the plugin.
- **Core engine** (interpreters, schema, detector packs, mechanics) — internal
  composition points; PR with an issue first. Schema
  changes (`NodeType`/`EdgeKind`) are
  governed by the executable law-suite in `test/laws/`: a new primitive needs a
  producer **and** a consumer witness **and** a law update — a "schema-only" PR
  will not go green.

## Dev setup (self-dogfood)

repovine navigates its own codebase, so the dev loop is repovine-on-repovine.
Requires **Node ≥ 22**. Source development uses npm, pinned by
`packageManager` in `package.json`; commit `package-lock.json` with dependency
changes.

```bash
git clone https://github.com/legann/repovine && cd repovine
npm ci
npm run build                          # engine + SDK + plugin workspaces
node dist/mcp/index.js setup claude    # or: cursor | codex | all
```

Running `setup` from your built `dist/` **auto-wires the MCP at that local build**
(not `npx`), so the `repovine` MCP in your IDE runs *your* changes. Reload the
client and enable the MCP. (`--published` forces the npx launcher; an existing
`repovine` MCP entry is not overwritten, so re-run after `repovine clear` to
switch one over. See [docs/scripts.md](docs/scripts.md).)

**Loop:** edit `src/…` or `packages/…` → `npm run build` → restart the MCP (or call
`refresh_context`) → query the graph.

A rebuild changes the engine-build id in a git checkout, so the next build
re-extracts from scratch — a `.repovine` snapshot from the previous build is not
reused, and no manual `rm -rf .repovine` is needed. Installed packages skip this
check, so an engine upgrade keeps warm caches. Force dev behavior anywhere with
`REPOVINE_DEV=1`.

## Changing Stage-1 extract output

`test/laws/extract-output-golden.test.ts` pins the Stage-1 extract fingerprint on
a fixture corpus. A change to how modules are extracted reds it. Regenerate and
decide on the cache version:

```bash
UPDATE_EXTRACT_GOLDEN=1 npm test -- extract-output-golden
```

Checkout builds invalidate local snapshots through `engineBuildId`, so local
iteration does not require a version bump. The version decision applies to the
change that will ship:

| Change | Action |
|---|---|
| makes snapshots from a released version unsafe to reuse | bump `STAGE1_ANALYSIS_VERSION` (`src/stage1/index.ts`), then refresh the golden |
| cache-compatible | refresh the golden without a version bump |

## Adding a delivery mechanic

A **delivery mechanic** surfaces one edit-relevant graph or annotation signal.
Its model, current registry, primitive coverage, and dormant behavior are defined
in [DESIGN.md](DESIGN.md#mechanics-registry). Add one as a single entry in
`src/mechanics/registry.ts` —
`{ id, reads, direction, channels, detect }` placed in `DELIVERY_MECHANICS` at
its priority slot. `detect(ctx)` is total: it returns false when the mechanic's
primitive is absent, so it self-gates and requires no changes to delivery
channels or language-specific branching.
Applicability follows the primitive: a mechanic is universal when that primitive
exists across its target node class. If only some plugins emit it (for example, a
language-specific edge kind), the change also needs the producer and a schema-law
update, as above.

The registry is the dispatch SSOT; delivery machinery (priority caps, hub
demotion, the boundary push index) stays with each channel. The delivery freeze
tests (`investigate-refs`, `boundary-index`, `inspect-node-self-boundary`) must
stay green **unedited** — a mechanic that changes existing output is a behavior
change, not an addition. Contract and current mechanics:
[DESIGN.md](DESIGN.md#mechanics-registry).

## Where things live

| Area | Path |
|---|---|
| Source producers (plugins) | `packages/plugins/source-<name>/src/` |
| IaC producers (plugins) | `packages/plugins/iac-<name>/src/` |
| Interpreters — Stage 2 projection (internal) | `src/interpreter/`, `src/interpreters/`, `src/stage2/` |
| Detector packs (internal) | `src/analysis/architecture/`, `src/analysis/architecture-detectors/` |
| Mechanics (internal) | `src/mechanics/` |
| Public SDK contract | `packages/plugin-sdk/` |
| Graph model and queries | `src/graph/`, `src/stage2/` |
| Annotation memory and quality | `src/annotations/` |
| Semantic node-card index | `src/semantic/` |
| MCP tools and response shaping | `src/mcp/tools/`, `src/mcp/lib/`, `src/mcp/response/` |
| Delivery Protocol and compliance | `src/agents/`, `src/context-quality/` |
| CLI setup and projections | `src/cli/` |
| Schema laws | `test/laws/` |
| Examples / fixtures | `examples/`, `test/` |

System design: [DESIGN.md](DESIGN.md).

## License

By contributing, you agree your contributions are licensed under the repo's
[MIT License](LICENSE).
