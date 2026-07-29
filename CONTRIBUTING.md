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
- **Fixtures & examples** — a redacted IaC manifest plus the relationship it
  should expose; a tiny fixture for a node/edge repovine misses; a note about
  where the graph misread your repo. Good first contributions.
- **Docs** — corrections and gaps.

## Dev setup (self-dogfood)

repovine navigates its own codebase, so the dev loop is repovine-on-repovine.
Requires **Node ≥ 22**. Source development uses npm, pinned by
`packageManager` in `package.json`; commit `package-lock.json` with dependency
changes.

```bash
git clone https://github.com/<you>/repovine && cd repovine
npm ci
npm run build                          # engine + @repovine/plugin-sdk
node dist/mcp/index.js setup claude    # or: cursor | codex | all
```

Running `setup` from your built `dist/` **auto-wires the MCP at that local build**
(not `npx`), so the `repovine` MCP in your IDE runs *your* changes. Reload the
client and enable the MCP. (`--published` forces the npx launcher; an existing
`repovine` MCP entry is not overwritten, so re-run after `repovine clear` to
switch one over. See [docs/scripts.md](docs/scripts.md).)

**Loop:** edit `src/…` → `npm run build` → restart the MCP (or call
`refresh_context`) → query the graph.

A rebuild changes the engine-build id in a git checkout, so the next build
re-extracts from scratch — a `.repovine` snapshot from the previous build is not
reused, and no manual `rm -rf .repovine` is needed. Installed packages skip this
check, so an engine upgrade keeps warm caches. Force dev behavior anywhere with
`REPOVINE_DEV=1`.

## Before you open a PR

```bash
npm run typecheck && npm run lint && npm test
```

CI (Node 22) runs typecheck, lint, build, and test on every PR to `main`. Keep PRs
small and focused, and say what the graph should now show. Don't hand-edit
`repovine.annots.json` — use the annotation MCP tools / CLI.

### Changing Stage-1 extract output

`test/laws/extract-output-golden.test.ts` pins the Stage-1 extract fingerprint on
a fixture corpus. A change to how modules are extracted reds it. Regenerate and
decide on the cache version:

```bash
UPDATE_EXTRACT_GOLDEN=1 npm test -- extract-output-golden
```

| Change | Action |
|---|---|
| alters graph structure consumers rely on | bump `STAGE1_ANALYSIS_VERSION` (`src/stage1/index.ts`) first, then refresh the golden — caches invalidate on upgrade |
| cache-compatible (no consumer-visible shape change) | refresh the golden without a bump |

### Adding a delivery mechanic

A **delivery mechanic** surfaces one edit-relevant graph or annotation signal.
Its model, current registry, primitive coverage, and dormant behavior are defined
in [DESIGN.md](DESIGN.md#mechanics-registry). Add one as a single entry in
`src/mechanics/registry.ts` —
`{ id, reads, direction, channels, detect }` placed in `DELIVERY_MECHANICS` at
its priority slot. `detect(ctx)` is total: it returns false when the mechanic's
primitive is absent, so it self-gates and needs no core edit or language branch.
A mechanic reading only primitives every plugin emits is universal; one reading a
plugin-specific primitive (e.g. a new edge kind) also needs the producer and a
schema-law update, as above.

The registry is the dispatch SSOT; delivery machinery (priority caps, hub
demotion, the boundary push index) stays with each channel. The delivery freeze
tests (`investigate-refs`, `boundary-index`, `inspect-node-self-boundary`) must
stay green **unedited** — a mechanic that changes existing output is a behavior
change, not an addition. Contract and current mechanics:
[DESIGN.md](DESIGN.md#mechanics-registry).

## Where things live

| Area | Path |
|---|---|
| Source producers (plugins) | `src/source-plugins/<name>/` |
| IaC producers (plugins) | `packages/plugins/iac-<name>/src/` |
| Interpreters — Stage 2 projection (internal) | `src/interpreter/`, `src/interpreters/`, `src/stage2/` |
| Detector packs (internal) | `src/analysis/architecture/`, `src/analysis/architecture-detectors/` |
| Mechanics (internal) | `src/mechanics/` |
| Public SDK contract | `packages/plugin-sdk/` |
| Graph model and queries | `src/graph/`, `src/stage2/` |
| Annotation memory and quality | `src/annotations/` |
| Semantic node-card index | `src/semantic/` |
| MCP tools and response shaping | `src/mcp/tools/`, `src/mcp/lib/`, `src/mcp/response/` |
| Agent Protocol and compliance | `src/agents/`, `src/context-quality/` |
| CLI setup and projections | `src/cli/` |
| Schema laws | `test/laws/` |
| Examples / fixtures | `examples/`, `test/` |

System design: [DESIGN.md](DESIGN.md).

## Security

repovine stores structure, names, and relationships — **never** env values or
secrets. Don't put tokens, `.env` values, or customer data in issues, fixtures,
or annotations. Report suspected vulnerabilities through the private channel in
our [security policy](.github/SECURITY.md); do not open a public issue with
sensitive details.

## License

By contributing, you agree your contributions are licensed under the repo's
[MIT License](LICENSE).
