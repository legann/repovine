# repovine Design

This document defines repovine's system boundaries, design rationale, core
contracts, and known trade-offs. Operational configuration and integration
procedures live in the linked reference documentation.

The main flow describes design-level contracts. Collapsed **Deep dive** blocks
retain mechanics that directly justify those contracts.

## Overview

repovine is a verifiable software-development layer for coding agents. It builds
repository context for exploration, implementation, and review; preserves
authored knowledge as versioned annotations; and, in explicit Agent Protocol
runs, validates structured claims against repository state.

### Surfaces

One product, three interfaces:

| Surface | Role | Owned by repovine |
|---|---|---|
| **Engine** | Builds deterministic repo facts and checked memory. | Stage 1 syntax snapshot, Stage 2 graph, annotation store, freshness/orphans, consistency checks, context-session quality. |
| **MCP** | Gives an agent repo context during a session. | `search_context`, `map_context`, `inspect_node`, impact/flow/config/architecture/annotation tools, `refresh_context`. |
| **Agent Protocol** | Defines how a completed run is scoped, reported, and validated. | Schemas, manifests, projections, CLI validators (`repovine agents validate-*`, `compliance`). |

The **harness** runs the model, chooses provider/runtime, owns retries,
scheduling, isolation, permissions, budgets, CI/review gates, and final
accept/block policy; it calls repovine validators. In IDE/client mode the
developer and IDE play that orchestration role and repovine guidance is advisory.

### Layer model

The surfaces build on one bottom-up model:

```text
5  Acceptance     explicit Agent Protocol — assignments, run results, compliance
4  Agent runtime  client/harness-owned reasoning, editing, and review
3  MCP context    guided, navigable graph slices instead of raw files
2  Memory         versioned annotations attached to graph nodes
1  Engine facts   deterministic repository graph (`RepositoryGraph` in code)
```

Each layer is checked against the one below it. Annotations (2) validate against
engine facts (1); MCP results (3) project graph and annotation state; the
protocol (5) validates observable claims against the graph, snapshot,
annotations, and recorded context-session state. Durable authored repository
knowledge enters at layer 2. Ephemeral reasoning and run results remain in the
client or harness and never feed the deterministic graph. The acceptance layer
is harness-facing; the protocol definition and compliance validators live in
repovine core.

### Checkout-local state model

repovine has no central repository-knowledge service. Each process is rooted in
one checkout and builds context from that checkout's working tree. This keeps the
graph aligned with the code an agent can actually edit, including uncommitted
changes and worktree-specific branches.

| State class | Artifacts | Ownership and lifecycle |
|---|---|---|
| Repository input | source, config, IaC, templates | The working tree is the authority for deterministic facts. |
| Committed repovine state | `repovine.config.json`, `repovine.domains.json`, `repovine.annots.json` | Repository-owned configuration and authored knowledge shared through Git. |
| Local operational state | `.repovine/` caches, context sessions, review decisions, boundary index | Checkout-local and gitignored; derived caches are rebuildable, while session/review records are intentionally local. |
| Runtime generation | snapshot, graph, token/semantic indexes, derived entrypoint views | In-memory state published as one generation and replaced by `refresh_context`. |

The split keeps machine-specific build state out of Git while allowing domain
layout and authored knowledge to travel with the repository. Deleting derived
caches must not delete repository knowledge; deleting local session/review state
may re-open advisory work but does not change the graph contract. File layout and
cleanup behavior are documented in [Workspace files](docs/workspace-files.md).

### Determinism boundary

repovine separates deterministic repository facts from stochastic LLM output, and
checks the parts of an agent's structured claims that can be compared with
observable repository state.

| Artifact | Source | Deterministic (repovine) | Harness / runtime scope |
|---|---|---|---|
| Source files, config, IaC | Working tree | File discovery, hashes, parsed syntax, resource/config names | Runtime behavior not visible statically |
| `RepositoryFactsSnapshot` | Stage 1 | Packages, modules, imports, exports, hints, infra facts | Dynamic patterns the parser cannot infer |
| `RepositoryGraph` | Stage 2 | Typed nodes/edges: package/module/export-symbol/template/domain/runtime-resource, imports, template composition, runtime/config links | Natural-language meaning (Layer 2 annotations) |
| MCP tool results | Graph + snapshot + annotations + indexes | Scope resolution, pagination, confidence/gaps, empty diagnostics, token metadata; optional semantic rank/score on `search_context` | Agent interpretation of results |
| Annotations | Agent/developer-authored memory | Schema, freshness, orphan/stale state, merge-review markers, field consistency vs graph, secret-shape rejection, write provenance | Insight and completeness beyond checkable fields |
| Architecture findings | Detectors over graph + annotations | Review candidates, confidence, affected nodes, security/config signals | Proof that a refactor is desirable or safe |
| `AgentRunResult` | LLM/harness output | Schema, node resolution, requested-check reflection, annotation existence/freshness, context-session quality, review read-only constraints | Business correctness, real test execution, readiness |

### Trust and execution boundaries

Deterministic output validation is not process isolation. repovine separates
these trust decisions explicitly:

| Boundary | repovine guarantees | Outside the guarantee |
|---|---|---|
| Repository contents | Parsed as data; env names and resource references may enter the graph, secret values do not. | Static extraction cannot prove runtime behavior or that repository content is safe to execute. |
| Third-party plugins | Explicit install/config, `apiVersion` gate, schema validation of emitted fact deltas. | Plugin modules execute in the repovine process with that process's filesystem/network permissions; `trusted:false` describes their output path, not a sandbox. |
| Annotations | Schema, freshness, consistency checks, provenance signals, rejection of obvious secret-shaped values. | Authored meaning and completeness remain claims to verify. |
| MCP and client hooks | Bounded repository context and deterministic pre-edit boundary lookup. | The host client controls model execution, commands, file permissions, and user approval. |
| Harness runs | Protocol schemas and validation against observable repository state. | Isolation, network policy, tests, retries, budgets, review, and acceptance belong to the harness. |

Installing and listing a plugin is therefore an execution trust decision by the
repository owner. Fact validation prevents malformed output from corrupting the
graph model; it does not make third-party code safe to run. Plugin loading and
conformance details live in [Plugin authoring](docs/plugin-authoring.md#trust-model).

### Two consumption modes

The same engine and MCP surface serve interactive clients and autonomous harnesses.

| | Client mode | Harness mode |
|---|---|---|
| Orchestrator | Developer and IDE | External runner, CI, bot, or workflow engine |
| Agent runtime | Cursor, Claude Code, or Codex in the user session | Provider adapter in an isolated worker |
| MCP | Repository context during the session | The same context tools inside the worker |
| Agent Protocol | Inactive by default; explicit structured result/validation only | Assignment, result, and compliance boundary |
| Enforcement | Advisory by default | Harness policy may retry, block, or accept |
| Final acceptance | Developer | Harness, tests, review, and CI |

MCP is the repository API while an agent works. Agent Protocol is activated only
for an explicit completed-run contract. Client guidance and harness assignments
share the same graph and annotation model; orchestration and final acceptance
remain outside repovine.

Integration details live in [Agent Protocol](docs/agent-protocol.md) and [CLI and setup](docs/scripts.md).

### repovine vs RAG

repovine differs from semantic code search (RAG over embedded chunks) and agent
memory layers on index, answer shape, memory, and trust:

| | RAG code search | repovine |
|---|---|---|
| Index | text chunks → embeddings → vector DB | extracted graph: packages, modules, runtime resources, infra bindings |
| Answer | top-k similar chunks with a score (probabilistic) | deterministic nodes and edges, plus checked annotations |
| Query classes | "find similar code" | navigation **and** impact ("who breaks"), runtime flow, config surface, completeness ("all consumers, not 15 nearest") |
| Memory | typically retrieval-only; write-back requires a separate memory system | durable annotations agents write back, with freshness, provenance, consistency checks |
| Trust | similarity score | verifiable claims: stale detection, contradiction checks, protocol compliance |
| Infra | embedding API + vector DB, often cloud | local process + file-backed index; optional embedding model downloaded once and cached |
| Fuzzy entry | chunk similarity *is* the answer | embeddings rank **graph nodes**; structure, impact, freshness stay deterministic |

The two compose: optional local embeddings rank graph nodes for `search_context`,
and every step after the entry hit is graph-backed. Mechanics: [Semantic
search](#semantic-search).

## Engine: build pipeline

**Layer 1.** Two deterministic stages build the graph; a third builds the search
indexes. No LLM is in the loop, so the graph is reproducible and identical
between refreshes. Three concerns live inside this layer: build performance, IaC
extensibility, and `build.linking` (infra → code graph edges).

### Stage 1: repository facts snapshot

Input: workspace root. Output: a `RepositoryFactsSnapshot` of packages, modules,
infra modules, template facts, timestamps, and analysis metadata.

Code extraction is **source-plugin** based (see [Source parser
architecture](#source-parser-architecture)). The orchestrator (`stage1/index.ts`)
knows only the abstract `SourcePlugin` contract and never imports a language
toolchain. Built-ins ship in-repo: **TypeScript/JS** (`source-plugins/typescript/`,
ts-morph inside) and **Python** (`source-plugins/python/`, stdlib `ast` via
subprocess).

Built-ins differ in depth. TypeScript/JS is the first-class source path and emits
package, module, and export contracts plus richer framework and runtime hints.
Python emits a smaller AST-backed structural and route surface. Built-in IaC
producers provide partial, expanding extraction of selected resources and
relationships. Exact language and IaC coverage lives in [Supported
stacks](README.md#supported-stacks); unsupported facts are absent rather than
inferred.

Privacy: only env var **names** and resource **references** are stored. Env files
are never read; config values are never persisted in the graph.

### Stage 2: repository graph

The snapshot becomes `RepositoryGraph`: a deterministic, typed graph of packages,
modules, export symbols, runtime resources, domains, and relationships. It contains **no** NL
semantics, summaries, or annotations — those live one layer up in
`repovine.annots.json` as agent/developer-authored claims.

The graph schema is a core architecture contract, not an incidental TypeScript
union. The canonical runtime shape lives in `src/graph/model.ts`, re-exported by the
`src/types.ts` compatibility barrel: `NODE_TYPES` defines the seven graph node types
and `EDGE_KINDS` defines the fourteen graph edge kinds.
`NodeType` and `EdgeKind` are derived from those constants, and
`src/graph/delta.ts` builds its `GraphDelta` validation allowlists from the same
source of truth.

| Node | Meaning |
|---|---|
| `root` | Repository root. |
| `package` | A discovered source package/project. |
| `module` | A source file or IaC file. |
| `export-symbol` | An exported symbol from a module. |
| `template` | A template/rendered-surface artifact addressable by render/composition facts. |
| `domain` | A business, feature, layer, technical, or infra grouping. |
| `runtime-resource` | A runtime/resource entity from IaC. |

| Edge | Meaning |
|---|---|
| `contains` | Hierarchy: root → package → module → export-symbol; infra module → runtime-resource. |
| `imports` | Source module imports another source module. |
| `reexports` | Barrel module re-exports symbols from a leaf module (barrel → defining leaf). |
| `tagged` | Node belongs to a domain or subdomain. |
| `implements` | Exported class/symbol implements an exported interface contract. |
| `infra` | Runtime resource handled by a source module (Lambda handler, Dockerfile module, …). |
| `routes_to` | Kubernetes Ingress → backend Service (matched by manifest name). |
| `renders` | Render unit/view/module → template rendered by that unit. |
| `extends` | Template → parent/base template. |
| `includes` | Template → included partial/template. |
| `binds_to` | Source module bound to a resource through runtime config. |
| `uses_env` | Service/resource reference through environment/config. |
| `consumes` | Queue/topic consumed by a runtime resource. |
| `publishes` | Runtime action publishes/invokes another runtime resource. |

#### The contract-boundary model (why these levels)

The node tree is the nesting of **contract boundaries** every modular ecosystem
has, however a language names them. It models where units bind to each other, not
how a unit computes internally. The spine:

```text
repository  ⊃  distribution  ⊃  compilation  ⊃  contract       ⊃  (internals)
   root          package          module          export-symbol     fields, not a node
```

A boundary earns a node kind on **two criteria**:

1. **near-universality** — the boundary exists across paradigms as a structural fact, not one language's feature;
2. **cross-unit contract** — something on the other side binds to it by name: imports, links, deploys.

The two criteria fix the count at these levels. Each level is named by its **role
at the boundary** (what the other side addresses), not by syntax, so one model
spans languages: the mechanism differs, the boundary holds.

| Level | Boundary role | TypeScript | Python | Go | Java | C++ | If the ecosystem has none |
|---|---|---|---|---|---|---|---|
| `root` | analysis boundary | repo | repo | repo | repo | repo | always present |
| `package` | distribution / dependency unit | npm workspace | `pyproject` / dist | go module | Maven artifact | CMake target | no manager → one package = root |
| `module` | compilation / import-resolution unit | `.ts` | `.py` | `.go` | `.java` | `.cpp` / `.h` | always a file |
| `export-symbol` | cross-module contract (visible outside) | `export` | top-level / `__all__` | Capitalized name | `public` | header / `extern` | convention, not a keyword |
| symbol-detail | sub-contract internals — **fields, not a node** | — | — | — | — | — | always "inside" |

> The table shows *where each boundary lives* per language — the principle, not
> the shipped adapter list. Languages ship incrementally as source plugins
> (see [Supported stacks](README.md#supported-stacks)); the model does not change
> when one is added.

The same criteria exclude candidate levels:

- **namespace / sub-package** fails (1): a C++/C#/Java construct, not universal, so it is a path-and-name field on a node, never its own level;
- **statement / expression / block** fails (2): module-internal, nothing binds to it across a module, so it is a field on `export-symbol`. The tree halts at `export-symbol` — below the smallest cross-unit contract the analysis is inside an implementation.

**Two branches, one spine, plus an overlay.** The `contains` spine carries two
branches from different producers: a **code** branch `root → package → module →
export-symbol` from source plugins, and an **infra** branch `root → module(IaC) →
runtime-resource` from IaC plugins. `export-symbol` and `runtime-resource` are
siblings on parallel axes — the cross-module code contract and the runtime
contract. A `domain` is a logical grouping no physical boundary catches, so it
attaches through `tagged` as an overlay, outside the `contains` hierarchy.

Boundary-crossing is the first-class query — what an agent cannot recover from a
single file:

| Boundary-crossing question | Edges that answer it | Tool |
|---|---|---|
| who breaks if I change this contract? | `imports`, `implements` | `analyze_dependencies` |
| how does a request cross service boundaries? | `routes_to`, `binds_to`, `uses_env`, `publishes`, `consumes` | `trace_flow` |
| where does a dependency cross a package/domain line? | any edge between nodes of different `package`/`domain` | `map_context`, architecture detectors |

**Honest folding.** Where an ecosystem collapses a boundary, repovine folds: no
package manager → one package = root; convention exports → contract read from
convention; a dynamically-typed module with no nominal interface → `implements`
empty. A contract-poor repo gets a thinner, truthful map. The floor is a guarded
invariant (`test/laws/` honest-empty): absence is no-by-construction, distinct
from a fabricated edge.

**The cut is goal-relative.** Other tools slice a repository differently:

| Cut (by) | Nodes / edges | Tool family |
|---|---|---|
| AST / syntax | file → class → method → statement → token | tree-sitter, formatters, codemods |
| symbols / types / refs | symbols + references + type hierarchy | LSP / IDE |
| call / data-flow | functions + calls + flows | CodeQL, Semgrep (taint/security) |
| module-dep | module → module only | webpack, madge |
| deployment | services + wiring | service maps |
| concepts | domains, embeddings | semantic search |

repovine stops below `export-symbol`: no AST slicing, no materialized call graph
(`calls` would be strings, not edges). The cut is the fixed point of four
constraints:

1. **agent altitude** — architectural-reasoning granularity, not machine-precise tracing;
2. **cross-language survivability** — only contract boundaries survive a paradigm change;
3. **incremental-extraction cost** — per-file `contentHash` re-extraction; deep resolution is on-demand;
4. **validability** — nodes are durable, stable-ID artifacts for Agent Protocol compliance.

A different goal — refactor engine, taint scanner — has a different minimal cut.
For repovine's query set, the seven graph node types and fourteen graph edge kinds
form the current tested contract, defined below.

#### Core graph contract

The node and edge vocabulary is defined by the Stage 2 tables above. The core
graph shape is intentionally small and query-driven:

- every node/edge kind must have a producer in the deterministic build pipeline;
- every non-structural edge kind must have a consumer where removing that kind
  changes a query result;
- `contains` and `tagged` are structural/navigation edges, so they are witnessed
  through graph navigation and scope/domain lookup rather than ablation;
- node `data` is typed per node kind (`NodeDataByType`); the graph-delta validator
  rejects `data` keys foreign to a node type on the untrusted path;
- every source package and source module in `RepositoryFactsSnapshot` carries a
  source-plugin id stamped at the Stage 1 boundary, so ownership can be resolved
  by id or declared plugin capabilities rather than inferred from paths;
- unsupported higher-tier hints are honestly absent, not guessed.

This contract is guarded by `test/laws/` (`schema-shape`, producer and consumer
edge witnesses, honest-empty, determinism, source-plugin stamping, and per-type
node-data shape). Those tests are property and differential guards, not golden
graph snapshots: adding a new node or edge kind requires updating the canonical
constants, listing any new node-data keys in `NODE_DATA_KEYS` (a compile-time
assertion keeps it exactly in sync with `NodeDataByType`), adding producers,
proving a consumer where applicable, and keeping `GraphDelta` validation in sync.
It does not require changing fixture `expected.json` files unless behavior outside
this contract truly changed.

Domains are inferred from paths, package layout, import clusters, frontend/backend
conventions, IaC kind, and optional `repovine.domains.json` rules. Large
business/feature domains can receive generated subdomains by path clustering.
Stage 2 pass 6 labels each domain `business`/`feature`/`layer`/`technical` for
map/coverage scale.

#### Schema evolution — a primitive lives iff a query needs it

One operational law governs the schema: **a node or edge kind exists exactly when
a query needs it.** This is the principle behind the two contract rules above
(every kind has a producer; every query-bearing kind has a consumer where removing
it changes a result), making the schema a function of the question set.

Git history shows the law cutting both ways:

| Change | Kind | Reason |
|---|---|---|
| **Added** | `implements` | a string field answers "which symbols implement `I`?" wrong through barrel/namespace gaps |
| **Pruned** | `handles` / `exposes` | no producer; a closed union with dead members is dishonest |
| **Collapsed** | `uses_secret` → `uses_env` / `binds_to` | not a distinct relation, only a secret-typed target (`kind === "secret"`) |
| **Added** | `template` + `renders` / `extends` / `includes` | new query class (template composition) across Django/Jinja/Blade/Razor/Phoenix/Go — one primitive, not N edges |

The guard is **differential, not a golden snapshot**. A producer (`addNode`/`addEdge`
in `src/**`) is necessary but not sufficient: a kind counts only if removing its
edges/nodes changes at least one query tool's answer. `routes_to` shipped with a
producer but no consumer — deleting every `routes_to` edge changed no output, and
neither `tsc` nor the tests caught it; wiring it into `trace_flow` made the
differential non-empty. Guards live in `test/laws/` (`edge-witness-producer`,
`edge-witness-consumer`, `schema-shape`, `honest-empty`, `determinism`,
`source-plugin-stamping`, `node-data-shape`).

#### Scope of the graph model

The graph is a minimal navigational contract for a fixed set of agent questions: orientation, scope, impact, runtime topology, configuration, and template composition. It is designed for modular ecosystems with repository, distribution, compilation, and exported-contract boundaries.

Within that scope, every graph primitive has a deterministic producer and every query-bearing primitive has a consumer witness. Outside that scope the graph is an index, not a complete program model: taint analysis needs data flow, refactoring needs AST and type resolution, and runtime correctness needs execution.

This is a design constraint, not a claim of universal program representation. A new query class may justify a new primitive only when it preserves deterministic extraction, cross-language meaning, and a tested consumer.

#### Derived views outside the graph

Not every deterministic result receives durable node identity. Entrypoint
fragments are recorded and replayed for one graph generation; architecture
findings, configuration surfaces, flow summaries, and MCP envelopes are computed
for a query. These views may reference stable node ids, but they are not persisted
as repository facts and do not extend the graph ontology.

A result becomes a node only when it is an independently addressable,
cross-unit contract that must survive across query classes. Question-specific
aggregation, ranking, and judgment remain derived views. This distinction keeps
the graph small without limiting the answers built from it.

#### Domain configuration

Domains are a logical overlay on the physical graph. Inference provides a deterministic default; the committed `repovine.domains.json` file lets a repository refine paths, packages, structural directories, and noisy infrastructure without changing source code.

Advisor output is additive and requires explicit approval before the committed configuration changes. The MCP server reports suggestions and previews but does not write the file. Schema, merge behavior, and advisor operations are documented in [Workspace files](docs/workspace-files.md#repovinedomainsjson).

### Stage 3: search indexes

Stage 3 builds exact and optional semantic entry indexes inside the same refresh
barrier as the graph. Search therefore never describes an older graph snapshot,
and there is no independent reindex lifecycle. The index contract is described in
[Semantic search](#semantic-search).

### Build publication and degradation

A refresh constructs the next snapshot, graph, annotation state, indexes, and
derived views before publishing them as one runtime generation. Concurrent
refresh requests join the same build. A failed or cancelled refresh leaves the
previous ready generation in service; startup without a prior generation remains
in `building` state and never exposes a partial graph.

Degradation is explicit and local to the unavailable evidence:

- an unavailable producer or plugin yields a warning and absent capability;
- malformed external fact deltas are rejected rather than partially projected;
- unresolved static relationships remain gaps or absent edges;
- embedding failure falls back to persisted vectors when compatible and always
  retains token search.

The publication barrier is the consistency boundary: every MCP result describes
one complete generation, even when that generation has honest capability gaps.

### Build model and performance

Stage 1 is tuned for large TypeScript monorepos: ts-morph is used only where
syntax facts are needed, extraction runs on a persistent `worker_threads` pool
with short-lived per-shard `Project`s, and a per-machine calibration sizes the
pool. This keeps cold-build concurrency and peak memory bounded on large
monorepos. The MCP server
connects its transport **before** building, so tools return `status:"building"`
while loading and `get_build_status` stays callable — with `waitSec` it long-polls,
returning the moment the build settles instead of forcing a polling loop.
`stageEtaSec` is deliberately only the current-stage estimate; `stage` and
`remainingStages` expose how much of the pipeline still follows it. `repovine setup`
builds the graph by default (`--no-build` defers to first MCP start), so the cold
window normally exists only after an upgrade invalidates the cache.

<details>
<summary><b>Deep dive — ts-morph confinement, three passes, worker pool, calibration, cache</b></summary>

ts-morph is used only where syntax facts are needed — per-shard `Project`s
(`skipAddingFilesFromTsConfig`/`skipLoadingLibFiles`), files added one at a time
(one fs read shared between hash and parse), syntax-only export/signature
traversal. It avoids the `TypeChecker`, `getModuleSpecifierSourceFile()` (which
pulls cross-package files in), loading `lib.*`, and any long-lived repo-wide
`Project`.

- **Three passes.** *Discovery* lists candidate files; *deduplication* resolves
  files sharing a module identity; *extraction* assigns stable shards to the
  worker pool and reuses modules whose analysis version and content hash match.
- **Worker pool.** Each shard builds a short-lived `Project` and drops it, so peak
  RAM scales with `workers × per-shard footprint`, not total module count.
- **Calibration.** A representative cold run writes `build-calibration.json`
  (per-machine, gitignored); warm runs with reused modules do not replace it.
  Worker RAM is the observed peak minus the main-process baseline, divided by
  concurrently active shards. Later runs size the pool within that calibrated
  CPU and memory envelope. Explicit build limits take precedence.
- **Cache.** Warm cache is `repository-facts-snapshot.json`, invalidated by
  analysis version, engine identity where applicable, content, and extraction
  configuration. Build-status payloads are memoized so polling does not repeat
  snapshot work.

</details>

### Identity and compatibility

Structural ids are stable while their address is stable. A path, namespace, or
export rename is modeled as delete plus add and can orphan annotations; repovine
does not infer rename identity. Content hashes answer whether an addressed
artifact changed, and import baselines extend that signal to direct-dependency
freshness.

| Gate | Contract protected |
|---|---|
| `STAGE1_ANALYSIS_VERSION` | Cache compatibility when extraction semantics change. |
| `extractionConfigFingerprint` | Reuse only under equivalent discovery and extraction configuration. |
| Development `engineBuildId` | Invalidate checkout-built engine output without imposing that gate on installed packages. |
| Plugin `apiVersion` | Compatibility of external source and IaC producer contracts. |
| Annotation `schemaVersion` | Upgrade and maintenance of committed authored memory. |
| Semantic card hash | Reuse embeddings only for the same embedder and node-card content. |

These gates serve different lifecycles: build metadata protects derived cache,
API and schema versions protect public or committed contracts, and content hashes
protect artifact and memory freshness. None substitutes for the others.

### Extension families and boundaries

The word "plugin" is reserved for the two producer families that can become
out-of-tree npm packages: source producers and IaC producers. They write layer-1
facts through `@repovine/plugin-sdk` and never import graph ontology
(`NodeType`, `EdgeKind`, `GraphDelta`, `RepositoryGraph`) or Stage 2 projection
internals. Built-ins are first-party implementations of the same contract and
ship as the default preset inside the `repovine` package.

| Family | Public? | Contract package | Built-in location | Registry/bootstrap |
|---|---:|---|---|---|
| Source producers | Yes | `@repovine/plugin-sdk`, scoped as `@repovine/plugin-sdk/source-plugin` | `src/source-plugins/<name>/` | `src/stage1/source/` |
| IaC producers | Yes | `@repovine/plugin-sdk`, scoped as `@repovine/plugin-sdk/iac-plugin` | `src/iac-plugins/<name>/` | `src/stage1/iac/` |
| Template discovery | No | core-only `TemplateFileInfo` contract | `src/stage1/templates.ts` | direct Stage 1 pass |
| Interpreters | No | core-only TypeScript contract | `src/interpreters/<name>/` plus shared `src/interpreter/` types | `src/stage2/interpreter/` |
| Detector packs | No | core-only detector contract | `src/analysis/architecture-detectors/<pack>/` | `src/analysis/architecture/` |
| Mechanics | No | core-only `DeliveryMechanic` contract | `src/mechanics/` | `src/mechanics/registry.ts` |

Source and IaC producers are external-capable because their output is a validated
fact delta that the engine can stamp with module identity and provenance, cache,
and project. Interpreters and detector packs are internal because they consume
the core graph, annotation state, MCP response shapes, and architecture-finding
semantics. Moving them out would expose graph/projection internals as a public API
before those contracts are stable.

Template discovery is a third fact-producing path, but not a public plugin
family. Core currently owns dialect detection and the `TemplateFileInfo`
contract; an internal Stage 2 interpreter projects template nodes and composition
edges. Adding a template dialect is therefore a core change today. The path can
become an external producer family if its discovery and fact contract stabilizes,
without changing the graph ontology.

### IaC parser architecture

IaC producers parse deployment formats into deterministic resource facts. The
Stage 1 orchestrator dispatches through the shared IaC producer contract and
metadata registry rather than branching on format names.

Built-ins are explicit first-party plugins. A producer owns file discovery and
format parsing; Stage 2 owns graph projection and cross-format relationships.
The graph ontology is shared — formats do not receive their own node or edge
types — while internal Stage 2 linking may remain provider- or
resource-specific where the relationship itself requires it. A new format
extends the producer edge without a new graph primitive when its facts fit the
existing ontology.

Supported formats and current depth are listed in [Supported stacks](README.md#supported-stacks). Authoring and conformance are documented in [Plugin authoring](docs/plugin-authoring.md).

### Source parser architecture

Source producers follow the same boundary. A language plugin discovers packages and emits deterministic module and semantic-hint deltas; core stamps mechanical identity and projects those facts into the graph.

Language plugins may differ in extraction depth. Consumers interpret absent
capability-gated facts as unavailable, never as guessed data. Language-specific
inference stays inside producers. Core dispatches some internal interpreters by
declared `sourceAdapterIds`, semantic hints, or plugin capabilities; baseline
package/module structure is shared, while a language-specific projection
requires a compatible interpreter contract.

The public contract lives in `@repovine/plugin-sdk/source-plugin`. Author workflow, trust model, and conformance are documented in [Plugin authoring](docs/plugin-authoring.md).

### Graph build linking

Stage 2 links deployment facts to source modules and container definitions. Handler paths, bundle metadata, image references, and service names may produce `infra` or `routes_to` edges when the target resolves deterministically.

The optional `build.linking` configuration supplies search roots and bundle/container hints for repositories whose IaC points at build artifacts or registry names. It changes target resolution only; `build.scan` remains the source-discovery boundary.

Configuration and service-id conventions are documented in [Workspace files](docs/workspace-files.md#buildlinking).

## Annotations

**Layer 2.** Versioned annotations give the graph durable authored memory across
sessions, keyed by graph node id and stored in `repovine.annots.json` (committed). The on-disk
format is valid JSON but canonicalized as one entry per line — the top-level key is
the node id; redundant fields (`nodeId`, `nodeType`, default `pass`/`schemaVersion`)
are inferred on load. This keeps Git diffs and conflict markers scoped to changed
records.

### Annotation model

Each stored annotation carries identity, freshness, and audit metadata plus an
authored payload. Annotatable node types are `module`, `export-symbol`,
`runtime-resource`, `template`, and `domain`; `infra:` ids are stored as module
annotations. The payload requires `summary`. Its complete field and disk-format
contract is defined in [Workspace files](docs/workspace-files.md#annotation-payload-fields).

A `risks` entry is a plain string (**local** scope) or `{ text, scope }` with
scope `local`, `consumer`, or `boundary`. Scope selects the delivery channel
([Annotation delivery](#annotation-delivery)), independent of the text. `local` is the default;
`consumer` and `boundary` are the selective exceptions that drive the
`inspect_node` edge flags and the pre-edit hook.

### Persistence

Writes persist through a single-writer debounced save chain. Concurrent edits to
different fields of one node merge at field granularity, external conflict fails
the save closed, and shutdown drains pending writes. The save chain lives in
`src/annotations/store.ts`.

### Annotation quality and trust

Annotation trust has three independent axes:

- **Freshness** compares stored hashes, schema versions, and import baselines with the current graph.
- **Consistency** recomputes contradictions between filled fields and graph facts.
- **Provenance** records whether a write was grounded by inspecting or editing the node in the same context session.

The 0–10 annotation score measures field completeness only. It does not claim correctness or trust. Freshness drives maintenance state; consistency produces issues; provenance is validated at the write/run boundary because it cannot be reconstructed later.

Module kind selects recommended fields, but never changes the annotation schema or graph facts. Payload fields and queue behavior are documented in [Workspace files](docs/workspace-files.md#repovineannotsjson).

### sideEffects vocabulary

`sideEffects` is a closed structured vocabulary shared by annotations and architecture detectors. Structured kinds let consumers distinguish persistence, external I/O, global state, subscriptions, resources, and intentionally pure modules without keyword-matching prose.

The canonical kinds and detector contract are documented in [Workspace files](docs/workspace-files.md#annotation-payload-fields). The runtime source of truth is `src/annotations/side-effect-vocab.ts`.

### Freshness and incremental updates

Memory follows graph change. A note becomes content-stale when its owning artifact or schema changes, propagation-stale when a tracked direct dependency changes, and orphaned when its node disappears. Runtime resources use deterministic IaC fingerprints where available.

All stale classes enter one maintenance backlog. Freshness is intentionally conservative: a current hash proves that the annotated artifact is unchanged, not that the prose is complete.

### Semantic merge

Annotation files are merged through `merge_annotations`, never by resolving JSON conflict markers manually. Distinct records combine automatically. Conflicting scalar edits remain explicit merge-review drafts until an agent inspects the node and rewrites the field.

The merge workflow and marker format are documented in [Workspace files](docs/workspace-files.md#git-merge-workflow).

### Unified queue and coverage

Unannotated, content/schema-stale, and propagation-stale live nodes are exposed
through one prioritized queue. Coverage reports that backlog by node type and
domain. Orphaned annotations and merge-review drafts are separate maintenance
states surfaced by validation and dedicated actions rather than queue rows. The
single queue keeps annotation onboarding and stale-note maintenance on one
ordering. Risk-scope candidates and carrier-link gaps are advisory; they never
enter it.

Operational queue fields and coverage views are documented in [Workspace files](docs/workspace-files.md#freshness).

## Semantic search

Semantic search is fuzzy entry into the deterministic graph, not a parallel source of truth.

The token index is always available for exact symbol, path, domain, annotation, configuration, and entrypoint matches. An optional local embedding index ranks deterministic node cards for natural-language queries. Export symbols remain token-searchable through their parent modules rather than becoming a second high-cardinality embedding corpus.

Both indexes return stable graph node ids. Semantic scores orient the first hop; subsequent map, inspect, impact, flow, and configuration queries operate on graph facts. Card hashes make embedding updates incremental, and embedding failure degrades to persisted vectors plus token search.

Node cards are capped at 1000 characters before tokenization, matching the
roughly 256-token MiniLM input window instead of relying on silent tokenizer
truncation. Within annotation prose the retained order is summary, invariants,
risks, flow, integration points, then verbose per-export descriptions.

`search_context` performs exact matching first, bounded relaxation when needed,
then optional semantic rank fusion. Its response exposes the strategy, matched
tokens, confidence, gaps, and suggested graph scopes so callers can distinguish
strong matches from fuzzy recovery. A nearest semantic neighbour with no token
match is explicitly low-confidence advisory evidence, not proof that the
requested functionality exists. Dimension-incompatible persisted vectors are
reported rather than disappearing as an unexplained empty ranking.

Configuration and cache behavior are documented in [Workspace files](docs/workspace-files.md#semantic_search_embeddings).

## MCP context

**Layer 3.** MCP exposes bounded graph queries for orientation, inspection, impact, runtime flow, configuration, architecture review, annotations, build state, and context-session quality. Tool handlers share scope resolution and response shaping; protocol validation remains a CLI/harness surface.

The public tool list and usage examples are maintained in [README](README.md#mcp-tools).

### Guided envelope

Read-only tools return a common envelope used as a decision framework. The default
response mode is `concise`, so empty/default pieces are omitted:

```json
{
  "scope": "auth",
  "resolvedScope": { "kind": "domain", "id": "domain:auth" },
  "summary": "What this result tells you",
  "confidence": "high",
  "attention": [{ "nodeId": "$3x9a1", "investigate": ["boundary"], "note": "off-limits boundary surface", "next": { "tool": "analyze_dependencies", "args": { "scope": "$3x9a1", "mode": "impact" } } }],
  "result": { "...": "tool-specific payload", "emptyDiagnostic": "present only when totalResults is 0 (search_context also skips it when OR-relax or aux config/entrypoint matches produced hits)" },
  "gaps": ["Important limitations or missing graph links"],
  "refs": { "$3x9a1": "mod:pkg/src/session" },
  "navigation": { "deeper": [{ "tool": "inspect_node", "args": { "nodeId": "$3x9a1" }, "reason": "Inspect match" }] }
}
```

`summary` interprets the result; `confidence` says how directly scope/tool matched
the task (`search_context` may return `confidence: "low"` with hits after OR-relax when
the top hit has weak token coverage); `attention` hoists open obligations above
`result` for primacy ([Annotation delivery](#annotation-delivery)), capped at 3; `gaps` lists limitations;
`navigation` is a bounded next-step menu grouped by intent
(`deeper`/`sideways`/`up`/`cross_layer`/`validate`). In concise mode,
repeated long ID-like strings in `navigation.args` are replaced with per-session
`refs` (`$3x9a1`) that a follow-up call may pass directly. `responseFormat:
"concise" | "debug"` overrides per call.

### Annotation delivery

Layer 2 notes reach the agent through Layer 3 tools and one pre-edit hook.
Delivery splits into four **registers** — the same fact rides differently by
register. Three registers pull on an MCP call; the fourth pushes at the
edit site.

| Register | Carries | Channels |
|---|---|---|
| content | the annotation body verbatim | `inspect_node.result.annotation`; `map_context` domain scope; `analyze_architecture` detail excerpts |
| pointer | presence only — "inspect this node" | `investigate` tags on refs; `investigatePointers`; `search_context` escalation gap; `trace_flow` `runtimeHandoff` `trigger:"annotation"` |
| salience | obligations hoisted to primacy | envelope `attention` block |
| push | boundary text at the edit site | pre-edit hook over `.repovine/boundary-index.json` |

Health-and-coverage tools (`get_annotation_status`, `validate_annotations`) report
facts *about* notes — counts, staleness, quality, risk-scope candidates — under
[Unified queue and coverage](#unified-queue-and-coverage). The pointer register carries no annotation text: it
marks a node and routes the agent to `inspect_node` for the content.

#### Mechanics registry

A **delivery mechanic** pairs a detection trigger with the delivery surfaces its
signal reaches. `src/mechanics/registry.ts` is the enumerable source: which
mechanics exist, their tag priority (array order), and the detection dispatch
(`tagsForTarget`, `selfBoundaryAttention`). Delivery machinery — priority caps,
hub demotion, the boundary push index — stays with each register.

| Delivery mechanic (`id`) | Reads | Direction | Delivers to |
|---|---|---|---|
| `risk` | `scope:"consumer"` risk | propagating | pointer, advisory |
| `boundary` | `scope:"boundary"` risk | self | pointer, salience, push |
| `effect` | persistent `sideEffect` | self | pointer |
| `wiring` | runtime `infra`/`binds_to` edges (topology) | self | pointer, salience |
| `co-change` | `implements` edges (topology) | propagating | pointer |
| `hub` | import in-degree (topology) | self | pointer |
| `unannotated` | annotation absent | self | reserved — declared, emitted by none |

`direction` is `self` when the signal describes the node itself, `propagating`
when it obligates consumers; it sets register affinity and push admission.
`co-change` is semantically symmetric; the enum has no `symmetric` value, and
`propagating` keeps it out of push. A mechanic self-gates: `detect` returns
false when its primitive is absent, so a mechanic on an existing primitive is
one registry entry with no core edit and no language branch. A mechanic on a
new primitive also adds that primitive's ctx accessor (`edgeCount` for the
topology-edge mechanics). Applicability follows the primitive — a universal
mechanic reads primitives every plugin emits (node, annotation scope); a
language-scoped one reads a primitive only some plugins emit. The mechanic's
`channels` field names the pull surfaces and push; `pull-neighbor`/`pull-carrier`
map to the pointer register, `pull-self` to salience. The `risk` mechanic emits
the tag named `risk` (API-visible in `inspect_node`).

**Primitive coverage.** A mechanic reaches a language only where a plugin produces
its primitive:

| Primitive | Produced by | Mechanic | Languages |
|---|---|---|---|
| `annotation.scope:*`, `annotation.sideEffects`, `annotation:absent` | annotation store (authored) | `risk`, `boundary`, `effect`, `unannotated` | any node |
| `topology.inDegree` | import edges — every source plugin | `hub` | any |
| `topology.runtimeEdges` (`infra`/`binds_to`) | IaC plugins + the shared handler-resolver | `wiring` | any handler language (TS, Python) |
| `topology.implementsEdges` (`implements`) | TS plugin only (`implementsInterfaces`, `source-plugins/typescript/exports.ts`) | `co-change` | **TS only — Python emits none** |

A mechanic whose primitive no active plugin produces is **dormant**: `detect`
self-gates to false, not an error — the delivery-side view of an absent
capability-gated fact. To reach a new language, extend that language's plugin to
emit the primitive; the mechanic then fires with no registry or core change. For
`co-change` on Python that means populating `implementsInterfaces` from ABC /
`Protocol` conformance in `source-plugins/python/`.

<details>
<summary><b>Deep dive — investigate tags, attention, carriers, and pre-edit push</b></summary>

#### Investigate tags

The pointer register renders the mechanics above as `investigate` tags on a ref
(`links`, `drill_down`, or an `investigatePointers` target), read from the
target's stored annotation or its graph edges — structured fields only, never a
prose scan.

Tags rank highest-first `risk > boundary > effect > wiring > co-change > hub`;
`unannotated` sits reserved at rank 4 and never emits. Per-ref cap is 3 tags;
per-response cap is 12 tagged refs, with an `investigateTruncated` marker.
`hub`, `wiring`, and `co-change` are inline-only, capped at 2 refs each, and
never hoisted to `attention`; `wiring`'s salience surface is a self attention
item on the wired node. Implementation: `src/mcp/lib/investigate-refs.ts`.

#### Attention block

Tagged refs (except the advisory tags `hub`, `wiring`, `co-change`) are deduped
by node, ranked by top tag priority, and hoisted to the envelope `attention`
block above `result`, capped at 3. Each item pairs the reason with the cheapest
next call.

Two signals on the **inspected** node itself yield self items that lead the
block, in order: a `scope:"boundary"` risk points at `analyze_dependencies`
impact; runtime wiring names the wired resources and points at `trace_flow`.
Landing on a frozen edit-site or a deployed handler is then as salient as
reaching one through a ref. Implementation: `src/mcp/tools/inspect-node.ts`.

#### integrationPoints carrier

A note's own `integrationPoints` names deeper dependencies by node id. Tokens are
parsed, graph-membership filtered, and kept when the inspected node transitively
depends on the target (depth-4 forward-import guard). A surviving target that
carries a tag surfaces as an `investigatePointers` entry and a must-inspect
`navigation.deeper` hint — the facade→SSOT carrier pair ([Annotation model](#annotation-model)).
Structural refs are excluded.

The authoring counterpart runs at annotation health. A gap is
`missing-carrier-link` when a runtime 2-hop delegation omits the target from the
importer's `integrationPoints`, and `named-but-undeliverable` when a named target
sits outside the importer's dependency closure. Gaps are advisory and group by
consumer-risk SSOT target. Reviewed decisions persist in
`.repovine/carrier-review.json`, keyed by a hash of the target's consumer risks;
a changed set re-surfaces the target. Implementation:
`src/annotations/carrier-links.ts`, `src/annotations/carrier-review.ts`.

#### Pre-edit push

`scope:"boundary"` risks project into `.repovine/boundary-index.json` at graph
build, keyed by the repo-relative file each annotated node owns. A `PreToolUse`
hook reads the index standalone — no running server, O(1) per edited file — and
surfaces the boundary text before an edit to that file lands. It is the
deterministic backstop for the `node → boundary` lookup `inspect_node`'s
`attention` serves on the pull path; both derive from the same `scope:"boundary"`
source. Modules, exports, infra, and templates map to a file; domains and runtime
resources have no single owning file and stay pull-only. Implementation:
`src/mcp/boundary-index.ts`.

In harness mode a fifth path carries the same fields. `renderHarnessImplementerBrief`
directs the agent to read a note's `invariants`, `risks`, `sideEffects`, and
`integrationPoints` as edit-time obligations — preserve, mitigate/test/accept, then
close each as satisfied, tested, scoped-out, or a blocker. Harness projection
details live in [Agent Protocol](docs/agent-protocol.md#projections).

</details>

### Diagnostics and scope recovery

Empty or weak results are explicit states. Shared diagnostics distinguish an empty graph, unresolved scope, filtering, and pagination misses; tool-specific diagnostics explain why a valid scope has no result for that query class.

Diagnostics include bounded retry/navigation suggestions. Semantic scope suggestions may assist a free-text miss, but no scope resolves silently. The authoritative reason enum lives in `src/mcp/response/empty-diagnostics.ts`.

### Response budget

Response size is an architectural constraint. Concise mode omits empty/default fields, shortens repeated ids through session refs, pages collections, bounds source bodies, and caps navigation and attention. Larger bodies, limits, or debug envelopes require explicit caller choice.

## Agent work and Agent Protocol

**Layers 4–5.** repovine supplies agents with **shared graph tools + committed
annotations** and, for an explicit protocol run, validates the completed result.
The client or harness coordinates the agents.

### Client projections and delegation boundary

`setup` projects the same navigation, refresh, annotation, review, and handoff contracts into each supported client. Generated rules, skills, hooks, and utility-agent manifests are delivery artifacts; the repository graph and committed annotations remain the shared state.

The developer or external harness owns orchestration. repovine provides context, synchronization barriers, durable memory, and validation; it does not schedule models. Setup behavior and managed-file ownership are documented in [CLI and setup](docs/scripts.md).

### Context Session Quality

Context Session Quality derives a deterministic score from the MCP responses used
before handoff. Client mode treats the score as advisory; a harness may require a
session and enforce its threshold through assignment and compliance policy.

Signals, lifecycle, thresholds, and recovery semantics are documented in
[Context Session Quality](docs/context-quality.md).

### Agent Protocol boundary

The harness-facing contract is `AgentAssignment → AgentRunResult → AgentComplianceReport`. The harness runs the model and owns permissions, retries, tests, review, and final acceptance. repovine owns schemas and validation against observable graph and annotation state.

Compliance can verify that declared nodes resolve, written annotations exist and are fresh, required refresh and requested checks are reflected, assignment scope is respected, and context-session requirements are met. It cannot establish business correctness, real test execution, security readiness, or rollout safety.

Public protocol compliance runs through the CLI. The command builds current
repository state with the same engine pipeline used by MCP and passes that state
to the core validator; protocol validation itself is not an MCP tool.

Protocol objects, projections, commands, lifecycle, and integration examples are documented in [Agent Protocol](docs/agent-protocol.md).

## Executable contracts

Architecture claims that constrain extension or delivery behavior are enforced
at their narrowest observable boundary:

| Contract | Executable guard | What a failure means |
|---|---|---|
| Graph ontology and invariants | `test/laws/` | Schema shape, producer/consumer witnesses, typed node data, honest absence, determinism, or source ownership no longer matches the design. |
| Stage 1 extraction compatibility | `test/laws/extract-output-golden.test.ts` | Extracted facts changed; the change must be reviewed together with the analysis-version and cache-compatibility decision. |
| Plugin boundary and conformance | plugin law tests and `test/unit/plugin-sdk/conformance.test.ts` | A producer crossed the semantics-only boundary or no longer satisfies the public SDK contract. |
| Annotation delivery | focused MCP tests for investigate refs, self-attention, and boundary index | Pointer, salience, carrier, or pre-edit projection changed. |
| Agent Protocol | `test/integration/agent-protocol-cli-blackbox.test.ts` | Assignment, result, compliance, JSON, or exit-code behavior changed at the harness boundary. |

These tests protect architectural boundaries rather than freeze every output.
Golden extraction detects a fact-level change; graph laws determine whether the
ontology remains coherent. Benchmark reruns are a separate product-behavior
decision when a change can affect agent context or final diffs.

## Limitations and risks

Critique of the architecture itself: where it is thin, and what is **structural**
(the obvious fix only moves the frontier; the real fix is orthogonal) versus a
**maturity gap** (maturing a plugin or annotating more closes it).

The contract skeleton (package/module/export-symbol/runtime-resource/template +
`contains`/`imports`/template composition) is cheap and cross-language. The risk
surface is the interpretive superstructure on top — resolution edges, the domain
overlay, `semanticHints`, annotations: heuristic, language-asymmetric, or
drift-prone. Fidelity softens with distance from an extracted fact.

| # | Thin spot | Why it's a risk | Long-term failure | Grade |
|---|---|---|---|---|
| 1 | **No shared resolver layer** | `imports` (module-level), `implements` (ad-hoc pass), `calls` (unresolved strings), template resolver — each reference class is solved separately | many half-resolved links at different fidelity; barrel/namespace and string-name ambiguity recur for every new edge kind | **structural** |
| 2 | **No coverage signal** (honest-empty = not-yet-extracted) | a consumer can't tell "this language truly has no X" from "the adapter can't extract X yet" | cross-language analyses silently under-deliver on weak adapters, with no low-confidence signal | **structural** |
| 3 | **Domain overlay is a noisy heuristic** | path, cluster, and pattern inference can assign overlapping domains; `tagged` carries both membership and nesting | misleading groupings an agent trusts for scoping | mixed |
| 4 | **`semanticHints` is one versioned bag** | the whole producer→interpreter coupling rides fixed slots; passthrough slots are inert without code | the set ossifies (new facts don't fit) or bloats into a kitchen sink | **structural** |
| 5 | **Infra branch on brittle handler resolution** | the `infra` edge rides a string `resolveHandlerToModule` | as IaC diversifies (CDK, containers), islands of resources with no code linkage | **maturity** |
| 6 | **Annotation drift** (the one semantic layer) | decay can outpace repair; client maintenance is advisory and hard enforcement exists only when a harness or CI policy requires it | on an active repo the semantic layer drifts from reality | **structural** |

**Why #2 and #6 are structural.** Maturing the Python plugin raises Python
*coverage*, not *structure*: the frontier (N languages × M facts) always exists,
"done" is unobservable (honest-empty is indistinguishable from not-yet), and the
fix — a coverage signal in `gaps`/`confidence` — is orthogonal to any one
extractor. Annotation freshness is behavioral: decay can outpace authored repair,
client queues remain advisory, and enforcement requires an explicit harness or CI
policy. It is the only layer with no auto-extraction.

**Subtler risks.** Name-based identity (`export:module/name`) makes a rename
delete+add, so annotations orphan on refactor-heavy repos. The closed-union +
first-party model makes any new relation a core change (a v1 trade-off). No
temporal axis (churn/co-change) caps "what's risky to change" questions.

These risks do not imply an automatic refactoring roadmap. Resolver, coverage,
or freshness changes should be justified by concrete query failures and treated
as behavior changes. Expanding plugin coverage and maintaining annotations are
independent maturity work.

### Known gaps in 0.1.0

The table above grades the architecture. This one records measured shortfalls in
what 0.1.0 actually emits, and the response each one already carries. They ship
as listed.

| # | Gap | Measured | Response in 0.1.0 |
|---|---|---|---|
| 1 | `analyze_architecture` findings are often false | 31% of a 42-finding adjudicated sample were factually true about the named module; the sample is not retained | numeric `confidence` withdrawn from the MCP contract on input and output, report capped at 30, and `duplicate-like`, `god-module`, `authorization-policy-drift` excluded from the default category set |
| 2 | Semantic fusion constants are fitted to one repository | cosine floor and RRF weights chosen in-sample over 25 queries from a single codebase; that corpus is not retained | the four constants live in `semantic/relevance.ts` and reach the ranker by import, so recalibrating the semantic half is a one-file edit; lexical token scores stay in `mcp/lib/search-graph.ts` |
| 3 | Secret/public env classification is TypeScript-only | the Python producer fills `envVars` and framework hints; the `security` slot stays empty | a Python `os.getenv("DB_PASSWORD")` returns `kind: 'env'` and `get_config_surface({kind:'secret'})` omits it; `gaps` names only computed and aliased accesses, so the omission carries no signal |
| 4 | Same logical id in two IaC templates collapses to one node | node identity is `provider:kind:logicalId`, plus namespace for k8s; the second declaration overwrites the node payload while `declaredIn` accumulates both paths | annotation freshness hashes the set of declarations, and reference resolution reads `declaredIn` to prefer a target the referencing document declares. The set stays internal: no MCP response emits it, the merge carries no `gap`, and a reference from either document sees one in-scope candidate and resolves. `ambiguous` is returned only for candidates that stayed separate nodes |
| 5 | The CLI build-progress ETA extrapolates per package | package jobs span one module to the ~1600-module sharding threshold and the CLI weights every job equally, so early estimates on large monorepos are wrong by a similar factor | the MCP contract reports `stageEtaSec` for the current stage only, and clients wait via one `get_build_status` long-poll rather than reading an ETA; the CLI progress line is display-only and stays wrong |

Rows 1 and 2 need a labelled corpus spanning several repositories before either
number can move. Rows 3 to 5 are engineering, unblocked.

## Related documentation

- [README](README.md) — product overview, tools, setup, supported stacks, and examples.
- [Workspace files](docs/workspace-files.md) — configuration, domains, annotations, cache, and merge workflows.
- [Agent Protocol](docs/agent-protocol.md) — harness and CI integration.
- [Plugin authoring](docs/plugin-authoring.md) — source and IaC producer contracts.
- [CLI and setup](docs/scripts.md) — commands and managed assets.
- [Contributing](https://github.com/legann/repovine/blob/main/CONTRIBUTING.md) — development workflow and module ownership.
