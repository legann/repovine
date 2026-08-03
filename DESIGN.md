# Design

This document defines repovine's system boundaries, design rationale, core
contracts, and known trade-offs. Operational configuration and integration
procedures live in the linked reference documentation.

The main flow describes design-level contracts. Collapsed **Deep dive** blocks
retain mechanics that directly justify those contracts.

## Overview

repovine is a verifiable software-development layer for coding agents. It builds
repository context for exploration, implementation, and review; preserves
authored knowledge as versioned annotations; and, in explicit Delivery Protocol
runs, validates structured claims against repository state.

repovine models a repository as a set of cross-unit contract boundaries
connected by deterministic structural relations. A boundary becomes a graph
level when its meaning survives across languages and another repository unit
addresses it as a contract. This yields the `root → package → module →
export-symbol` code hierarchy, with templates and runtime resources as parallel
contract surfaces. Domains form a logical navigation and scoping layer across
the physical graph, grouping related nodes while the containment hierarchy
retains repository structure. Below exported symbols, analysis enters
implementation internals handled by source inspection, language tooling, and
execution.

This cut keeps the graph at the level of repository-wide architectural
reasoning. It supports deterministic incremental extraction, durable identities
for annotations, and bounded queries for navigation, impact, configuration, and
runtime topology. The ontology is query-driven: a primitive belongs in core when
it has a deterministic producer and changes the result of a supported query.

Language- and format-specific extraction stays at the producer boundary. Source
and IaC plugins emit validated facts; core assigns identity and owns ontology,
linking, and query semantics. Core analysis heuristics also match file-naming
conventions that no plugin capability declares. New producers expand extraction
coverage while every tool continues to operate on one graph vocabulary.
Extraction depth may vary, and unsupported facts remain absent.

Derived facts and authored knowledge follow different trust models. The graph is
rebuilt from repository state independently of annotations. Intent, invariants,
risks, and operational constraints live in a separate versioned layer. repovine
checks freshness and structural consistency from repository state and validates
provenance at the write or run boundary; semantic correctness remains an agent
and developer verification responsibility.

Agent runs follow the same boundary. In an explicit Delivery Protocol run, the
harness records task intent, acceptance criteria, scope, and optional evidence
policy in an assignment before execution; the returned result contains
structured claims that repovine re-checks only where repository state is
observable. In client mode, MCP returns bounded results for explicit search and
graph queries, and generated hooks provide a limited pre-edit path for
boundary-scoped risks on file-owned nodes. Developers and harnesses retain
execution policy, test execution, behavioral review, and final acceptance
because those decisions require evidence beyond repository-observable state.

The same model-agnostic engine supports interactive and autonomous development.

### Surfaces

One product, three surfaces:

| Surface | Role | Owned by repovine |
|---|---|---|
| **Engine** | Builds deterministic repo facts and checked memory. | Stage 1 syntax snapshot, Stage 2 graph, annotation store, freshness/orphans, consistency checks, context-session quality. |
| **MCP** | Gives an agent repo context during a session. | `search_context`, `map_context`, `inspect_node`, impact/flow/config/architecture/annotation tools, `refresh_context`. |
| **Delivery Protocol** | Defines how a completed run is scoped, reported, and validated. | Schemas, manifests, projections, CLI validators (`repovine delivery validate-*`, `compliance`). |

The **harness** runs the model, chooses provider/runtime, owns retries,
scheduling, isolation, permissions, budgets, CI/review gates, and final
accept/block policy; it calls repovine validators. In IDE/client mode the
developer and IDE play that orchestration role and repovine guidance is advisory.

### Layer model

The operating model separates repository facts, authored memory, agent-facing
context, agent execution, and run validation:

```text
5  Run validation  explicit Delivery Protocol assignments, results, and compliance
4  Agent runtime   client- or harness-owned reasoning, editing, and review
3  MCP context     guided, navigable projections of repository state
2  Memory          versioned annotations attached to graph nodes
1  Engine facts    deterministic repository graph (`RepositoryGraph` in code)
```

Layers 1–3 form repovine's context stack. Layer 4 belongs to the client or
harness. In explicit protocol runs, Layer 5 validates observable claims against
repository facts, annotations, and recorded context-session state; it does not
validate the agent's reasoning or execution. Durable authored knowledge enters at
Layer 2, while ephemeral reasoning and run results remain outside the
deterministic graph. The protocol definition and compliance validators live in
repovine core.

### Checkout-local state model

repovine has no central repository-knowledge service. Each process is rooted in
one checkout and builds context from that checkout's working tree. This keeps the
graph aligned with the code an agent can actually edit, including uncommitted
changes and worktree-specific branches.

| State class | Artifacts | Ownership and lifecycle |
|---|---|---|
| Repository input | source, config, IaC, templates | The working tree is the authority for deterministic facts. |
| Committed repovine state | `repovine.config.json`, `repovine.domains.json`, configured annotations file (default `repovine.annots.json`) | Repository-owned configuration and authored knowledge shared through Git. |
| Local operational state | `.repovine/` caches, context sessions, review decisions, boundary index | Checkout-local and gitignored; derived caches are rebuildable, while session/review records are intentionally local. |
| Runtime generation | snapshot, graph, token/semantic indexes, derived entrypoint views | In-memory state published as one generation and replaced by `refresh_context`. |

The split keeps machine-specific build state out of Git while allowing domain
layout and authored knowledge to travel with the repository. Deleting derived
caches must not delete repository knowledge; deleting local session/review state
may re-open advisory work but does not change the graph contract. File layout and
cleanup behavior are documented in [Workspace files](docs/workspace-files.md).

### Determinism boundary

repovine deterministically derives structural facts from the working tree. Agent
claims are validated only when they can be recomputed from that observable state.

| Artifact | Source | Deterministic (repovine) | Harness / runtime scope |
|---|---|---|---|
| Source files, config, IaC | Working tree | File discovery, hashes, parsed syntax, resource/config names | Runtime behavior not visible statically |
| `RepositoryFactsSnapshot` | Stage 1 | Packages, modules, imports, exports, hints, infra facts | Dynamic patterns the parser cannot infer |
| `RepositoryGraph` | Stage 2 | Typed nodes/edges: package/module/export-symbol/template/domain/runtime-resource, imports, template composition, runtime/config links | Natural-language meaning (Layer 2 annotations) |
| MCP tool results | Graph + snapshot + annotations + indexes | Scope resolution, pagination, confidence/gaps, empty diagnostics, token metadata; optional semantic rank/score on `search_context` | Agent interpretation of results |
| Annotations | Agent/developer-authored memory | Schema, freshness, orphan/stale state, merge-review markers, field consistency vs graph, secret-shape rejection, grounding checks at write/run boundaries | Insight and completeness beyond checkable fields |
| Architecture findings | Detectors over graph + annotations | Review candidates, confidence, affected nodes, security/config signals | Proof that a refactor is desirable or safe |
| `AgentRunResult` | LLM/harness output | Schema and optional assignment linkage; graph/annotation claims; review read-only constraints; acceptance-criteria/result/policy registry integrity; repository-evidence grounding; optional revision-delta membership; advisory check/scope/context signals | Business correctness, real test execution, security/readiness, final acceptance |

### Trust and execution boundaries

Validation, execution, and isolation are separate trust boundaries. repovine
makes their ownership explicit:

| Boundary | repovine guarantees | Outside the guarantee |
|---|---|---|
| Repository contents | Parsed as data; env names and resource references may enter the graph, secret values do not. | Static extraction cannot prove runtime behavior or that repository content is safe to execute. |
| Third-party plugins | Explicit install/config, `apiVersion` gate, schema validation of emitted fact deltas. | Plugin modules execute in the repovine process with that process's filesystem/network permissions; `trusted:false` describes their output path, not a sandbox. |
| Annotations | Schema, freshness, consistency checks, provenance signals, rejection of obvious secret-shaped values. | Authored meaning and completeness remain claims to verify. |
| MCP and client hooks | Bounded repository context and deterministic pre-edit boundary lookup. | The host client controls model execution, commands, file permissions, and user approval. |
| Harness runs | Protocol schemas and validation against observable repository state. | Isolation, network policy, tests, retries, budgets, review, and acceptance belong to the harness. |

Operational guidance follows the same boundary: keep tokens and customer data
out of issues, fixtures, and annotations. repovine records environment-variable
names, and `write_annotation` rejects obvious secret-shaped values.

Installing and listing a plugin is therefore an execution trust decision by the
repository owner. Fact validation prevents malformed output from corrupting the
graph model; it does not make third-party code safe to run. Plugin loading and
conformance details live in [Plugin authoring](docs/plugin-authoring.md#trust-model).

### Two consumption modes

The same engine and MCP surface serve interactive clients and external harnesses.
In harness mode, Delivery Protocol adds the assignment, result, and compliance
boundary.

| | Client mode | Harness mode |
|---|---|---|
| Orchestrator | Developer and IDE | External runner, CI, bot, or workflow engine |
| Agent runtime | Cursor, Claude Code, or Codex in the user session | Provider adapter in an isolated worker |
| MCP | Repository context during the session | The same context tools inside the worker |
| Delivery Protocol | Inactive by default; explicit structured result/validation only | Assignment, result, and compliance boundary |
| Enforcement | Advisory by default | Harness policy may retry, block, or accept |
| Final acceptance | Developer | Harness, tests, review, and CI |

MCP is the repository API while an agent works. Delivery Protocol is activated only
for an explicit completed-run contract. Client guidance and harness assignments
share the same graph and annotation model; orchestration and final acceptance
remain outside repovine.

Integration details live in [Delivery Protocol](docs/delivery-protocol.md) and [CLI and setup](docs/scripts.md).

### repovine and RAG

repovine and semantic code search operate at different layers, with different
indexes, answer shapes, memory models, and trust guarantees:

| | RAG code search | repovine |
|---|---|---|
| Index | text chunks → embeddings → vector DB | extracted graph: packages, modules, runtime resources, infra bindings |
| Answer | top-k similar chunks with a score (probabilistic) | deterministic nodes and edges, plus checked annotations |
| Query classes | "find similar code" | navigation **and** impact ("who breaks"), runtime flow, config surface, graph-known consumers with explicit pagination, truncation, and extraction gaps |
| Memory | typically retrieval-only; write-back requires a separate memory system | durable annotations agents write back, with freshness, grounding, and consistency checks |
| Trust | similarity score | verifiable claims: stale detection, contradiction checks, protocol compliance |
| Infra | embedding API + vector DB, often cloud | local process + file-backed index; optional embedding model downloaded once and cached |
| Fuzzy entry | chunk similarity *is* the answer | embeddings rank **graph nodes**; structure, impact, freshness stay deterministic |

The two compose: optional local embeddings rank graph nodes for `search_context`,
and every step after the entry hit is graph-backed. Mechanics: [Semantic
search](#semantic-search).

## Engine: build pipeline

**Layer 1.** Two deterministic stages build the graph; a third assembles the
runtime state and search indexes. No LLM is in the loop, so the graph is
reproducible and identical between refreshes. Three concerns live inside this
layer: build performance, IaC extensibility, and `build.linking` (infra → code
graph edges).

### Stage 1: repository facts snapshot

Input: workspace root. Output: a `RepositoryFactsSnapshot` of packages, modules,
infra modules, template facts, timestamps, and analysis metadata.

Source extraction is plugin-based (see [Source parser
architecture](#source-parser-architecture)). Stage 1 loads a per-build plugin set
and interacts with source producers only through the public `SourcePlugin`
lifecycle; it never imports language-specific toolchains. The bundled default
preset selects separate **TypeScript/JavaScript**
(`packages/plugins/source-typescript/`) and **Python**
(`packages/plugins/source-python/`) plugin packages, which follow the same
manifest, loading, and fact-validation path as externally installed plugins. The
TypeScript plugin lazy-loads `ts-morph` for extraction; the Python plugin runs a
bundled stdlib-`ast` script in a Python subprocess.

Built-in source plugins use the same contract but differ in extraction depth.
TypeScript/JavaScript currently has the deepest source coverage, emitting package,
module, and export facts plus broader framework, UI, security, and runtime hints.
Python provides a narrower stdlib-AST-backed surface for structure, backend
routes, environment access, and effect imports. Built-in IaC plugins extract
selected resource types and relationships rather than complete format schemas.
Current language and IaC coverage is summarized in [Supported
stacks](README.md#supported-stacks); capability-gated facts a producer does not
support remain absent.

Privacy: only env var **names** and resource **references** are stored. Env files
are never read; config values are never persisted in the graph.

#### Extraction and performance

Stage 1 bounds source extraction across the active source plugins. The engine owns
discovery, canonical-path and module-identity deduplication, sharding, compatible-
snapshot reuse, and worker scheduling; each plugin owns its language-specific
parser. Parallel extraction uses a build-scoped `worker_threads` pool whose workers
are reused across shard jobs. A representative parallel cold run records a local
calibration that advises later worker counts within the available CPU and memory
budget; explicit build limits take precedence.

<details>
<summary><b>Deep dive — extraction phases, parser confinement, workers, calibration, and reuse</b></summary>

- **Extraction phases.** Each source plugin discovers candidate files; the engine
  canonicalizes paths, resolves duplicate module identities, and assigns pending
  modules to package shards. Results are merged in stable package and shard order.
- **TypeScript confinement.** Each TypeScript shard creates a short-lived
  `ts-morph` `Project` with `skipAddingFilesFromTsConfig` and
  `skipLoadingLibFiles`. Engine-owned source text is added incrementally, and type
  and signature text is read from syntax rather than checker-derived inference.
  Export collection still invokes compiler resolution through
  `getExportedDeclarations()`, so the plugin blocks `node_modules` resolutions and
  avoids `getModuleSpecifierSourceFile()`, library loading, and a long-lived
  repository-wide `Project`.
- **Plugin isolation.** The bounded `Project` is specific to the TypeScript plugin;
  Python extraction runs its bundled stdlib-`ast` parser in a subprocess. The
  build-scoped pool schedules source-plugin shard jobs without importing either
  language toolchain into the Stage 1 orchestrator. With one effective worker,
  extraction runs inline and no worker pool is created.
- **Calibration.** A representative parallel cold run writes the gitignored
  `build-calibration.json`; runs that reuse modules do not replace it. The observed
  incremental peak memory is divided across concurrently active shards, and later
  runs use that estimate with the CPU and memory budget to advise pool size.
- **Snapshot reuse.** Compatibility is gated by the analysis version, extraction
  and plugin configuration, and the development engine identity where applicable.
  Within a compatible `repository-facts-snapshot.json`, content hashes select
  unchanged modules for reuse; changed modules are re-extracted rather than
  invalidating the entire snapshot.

</details>

### Stage 2: repository graph

The snapshot becomes `RepositoryGraph`: a deterministic, typed graph of the
repository root, packages, modules, export symbols, templates, runtime resources,
domains, and relationships. It contains **no** NL semantics, summaries, or
annotations — those live one layer up in the configured annotations file (default
`repovine.annots.json`) as agent/developer-authored claims.

The graph schema is a core architecture contract, not an incidental TypeScript
union. The canonical runtime shape lives in `src/graph/model.ts`, re-exported by the
`src/types.ts` compatibility barrel: `NODE_TYPES` defines the seven graph node types
and `EDGE_KINDS` defines the fourteen graph edge kinds.
`NodeType` and `EdgeKind` are derived from those constants, and
`src/graph/delta.ts` builds the internal `GraphDelta` validation allowlists from
the same source of truth.

Stage 2 composes through two contribution paths. Internal interpreters project
normalized snapshot facts into core structure. Plugin projectors receive an
immutable fact view and return restricted public DTO batches for runtime
resources, semantic links, entrypoints, and namespaced extensions; they never
receive the mutable graph or construct graph identities. The host validates each
batch, mints resource ids, resolves structured references against one global
index, and maps accepted canonical relations into the core ontology. Projected
entrypoints and extensions remain generation-scoped sidecars rather than graph
nodes.

| Node | Meaning |
|---|---|
| `root` | Repository root. |
| `package` | A discovered source package/project. |
| `module` | A source file or IaC file. |
| `export-symbol` | An exported symbol from a module. |
| `template` | A template/rendered-surface artifact addressable by render/composition facts. |
| `domain` | A logical grouping inferred or configured from code and infrastructure, tiered as business, feature, layer, or technical. |
| `runtime-resource` | A runtime/deployment entity from IaC facts or an accepted plugin projection. |

| Edge | Meaning |
|---|---|
| `contains` | Physical hierarchy: root → package → module → export-symbol; root → IaC module → runtime-resource. Projected resources need not have a containing IaC module. |
| `imports` | Source module imports another source module. |
| `reexports` | Barrel module re-exports symbols from a leaf module (barrel → defining leaf). |
| `tagged` | Node belongs to a domain or subdomain. |
| `implements` | Exported class/symbol implements an exported interface contract. |
| `infra` | Runtime resource → source or build module that implements or produces it (handler, Dockerfile, …). |
| `routes_to` | Request-routing resource → backend resource; the built-in Kubernetes case is Ingress → Service. |
| `renders` | Render unit/view/module → template rendered by that unit. |
| `extends` | Template → parent/base template. |
| `includes` | Template → included partial/template. |
| `binds_to` | Module/resource → runtime resource it is deployed as or backed by. |
| `uses_env` | Service/resource reference through environment/config. |
| `consumes` | Event source such as a queue/topic → runtime resource that consumes it or is invoked by it. |
| `publishes` | Runtime resource → target resource it publishes to or invokes. |

#### The contract-boundary model (why these levels)

The node tree captures recurring **contract boundaries** across modular
ecosystems, however a language names them. It models where units bind to each
other, not how a unit computes internally. The spine:

```text
repository  ⊃  distribution  ⊃  compilation  ⊃  contract       ⊃  (internals)
   root          package          module          export-symbol     fields, not a node
```

A boundary earns a node kind on **two criteria**:

1. **near-universality** — the boundary recurs across paradigms as a structural fact, not one language's feature;
2. **cross-unit contract** — something on the other side binds to it by name: imports, links, deploys.

Within the code spine, these criteria select four levels. Each level is named by
its **role at the boundary** (what the other side addresses), not by syntax, so
one model spans languages: the mechanism differs, the boundary holds.

| Level | Boundary role | TypeScript | Python | Go | Java | C++ | If the ecosystem has none |
|---|---|---|---|---|---|---|---|
| `root` | analysis boundary | repo | repo | repo | repo | repo | always present |
| `package` | distribution / dependency unit | `tsconfig` project / workspace | `pyproject` / dist | go module | Maven artifact | CMake target | no producer-established unit → absent |
| `module` | compilation / import-resolution unit | TS/JS/SFC file | `.py` | `.go` | `.java` | `.cpp` / `.h` | always a file |
| `export-symbol` | cross-module contract (visible outside) | `export` | top-level / `__all__` | Capitalized name | `public` | header / `extern` | convention, not a keyword |
| symbol-detail | sub-contract internals — **fields, not a node** | — | — | — | — | — | always "inside" |

> The table shows *where each boundary lives* per language — the principle, not
> the shipped adapter list. Languages ship incrementally as source plugins
> (see [Supported stacks](README.md#supported-stacks)); the model does not change
> when one is added.

The same criteria exclude candidate levels:

- **namespace / sub-package** fails (1): a C++/C#/Java construct, not universal, so it is a path-and-name field on a node, never its own level;
- **statement / expression / block** fails (2): module-internal, nothing binds to it across a module, so it is a field on `export-symbol`. The tree halts at `export-symbol` — below the smallest cross-unit contract the analysis is inside an implementation.

**Two containment branches, a template surface, and a domain overlay.** The
`contains` spine carries a **code** branch `root → package → module →
export-symbol` from source producers and a document-backed **infra** branch `root
→ module(IaC) → runtime-resource` from IaC producers. A runtime resource added by
a plugin projector may have no containing IaC document; canonical semantic links
connect it to the rest of the graph. Templates form a separate composition
surface connected through `renders`, `extends`, and `includes`, not through
`contains`. A `domain` is a logical grouping no physical boundary catches, so it
attaches through `tagged` outside the containment hierarchy.

Boundary-crossing is the first-class query — what an agent cannot recover from a
single file:

| Boundary-crossing question | Edges that answer it | Tool |
|---|---|---|
| who breaks if I change this contract? | `imports`, `reexports`, `implements` | `analyze_dependencies` |
| how does a request cross service boundaries? | `infra`, `routes_to`, `binds_to`, `uses_env`, `publishes`, `consumes` | `trace_flow` |
| where does an import cross a package line? | cross-package `imports` | `analyze_dependencies` (`package-boundaries`) |
| what belongs to a domain? | `tagged` | `map_context` |

There is no generic cross-domain edge report. Architecture detectors surface the
specific boundary patterns they support; `map_context` provides domain scope and
navigation rather than claiming an exhaustive dependency cut.

**Honest absence.** repovine materializes only boundaries that an active producer
can establish. Without a supported source-package marker, the graph has no source
package or code-module nodes, although independent IaC and template producers or
compatible plugin projectors may still populate their surfaces. Convention-based
exports are emitted only when a source plugin defines that convention;
unsupported nominal relationships, such as Python `implements`, remain absent. A
contract-poor repository therefore yields a thinner graph rather than synthetic
structure. An absent fact means only that no producer established it — not
whether the construct is truly absent or unsupported.
`test/laws/honest-empty.test.ts` guards one concrete case: Python builds remain
non-empty while frontend-only hints remain absent by construction.

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
(`calls` remain string fields on export-symbol nodes, not edges). The cut is the
fixed point of four constraints:

1. **agent altitude** — architectural-reasoning granularity, not machine-precise tracing;
2. **cross-language survivability** — only contract boundaries survive a paradigm change;
3. **incremental-extraction cost** — per-file `contentHash` re-extraction; deep resolution is on-demand;
4. **validability** — nodes are durable, stable-ID artifacts for Delivery Protocol compliance.

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
- public plugin projections are validated as restricted contribution batches;
  the host alone mints graph identities and maps their canonical relations to
  internal edge kinds;
- every source package and source module in `RepositoryFactsSnapshot` carries a
  source-plugin id stamped at the Stage 1 boundary, so ownership can be resolved
  by id or declared plugin capabilities rather than inferred from paths;
- unsupported higher-tier hints are honestly absent, not guessed.

This contract is guarded by `test/laws/` (`schema-shape`, producer and consumer
edge witnesses, honest-empty, determinism, source-plugin stamping, per-type
node-data shape, projection composition, and projected-entrypoint visibility).
Those tests are property and differential guards, not golden graph snapshots:
adding a new node or edge kind requires updating the canonical constants, listing
any new node-data keys in `NODE_DATA_KEYS` (a compile-time assertion keeps it
exactly in sync with `NodeDataByType`), adding producers, proving a consumer where
applicable, and keeping internal and public projection validation in sync. It does
not require changing fixture `expected.json` files unless behavior outside this
contract truly changed.

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
| **Added** | `template` + `renders` / `extends` / `includes` | one cross-ecosystem query class for render/composition facts instead of framework-specific graph primitives |

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

#### Graph build linking

Stage 2 materializes deterministic cross-artifact links through two paths. The
internal `infra-runtime-links` interpreter resolves code-bearing deployment
resources to source modules and connects resources when their declared references
resolve unambiguously. Plugin projectors may contribute relationships such as a
container image or explicit build path pointing to an in-repository Dockerfile;
the host validates those contributions and maps their public relation vocabulary
to core edge kinds.

The optional `build.linking` configuration provides additional evidence for the
internal handler resolver: extra source roots and explicit or conventionally
discovered bundle scripts. It does not change Stage 1 discovery and does not
configure image-to-Dockerfile projection. Ambiguous references produce no link
rather than a registration-order or best-effort guess.

Configuration is documented in [Workspace files](docs/workspace-files.md#buildlinking).

#### Derived views outside the graph

Not every deterministic result receives durable node identity. Entrypoint
fragments, accepted namespaced extensions, contributor outcomes, and projection
refusals are recorded alongside one graph generation. Extensions carry provenance
and opaque payloads; generic surfaces may expose them, but graph traversal and
architecture algorithms do not interpret them. Architecture findings,
configuration surfaces, flow summaries, and MCP envelopes are computed for a
query. These views may reference stable node ids, but they are not persisted as
repository facts and do not extend the graph ontology.

A result becomes a node only when it is an independently addressable,
cross-unit contract that must survive across query classes. Question-specific
aggregation, ranking, and judgment remain derived views. This distinction keeps
the graph small without limiting the answers built from it.

#### Domain configuration

Domains are a logical overlay on the physical graph. Inference provides a deterministic default; the committed `repovine.domains.json` file lets a repository refine paths, packages, structural directories, and noisy infrastructure without changing source code.

Advisor output is additive and requires explicit approval before the committed configuration changes. The MCP server reports suggestions and previews but does not write the file. Schema, merge behavior, and advisor operations are documented in [Workspace files](docs/workspace-files.md#repovinedomainsjson).

### Stage 3: runtime state and search indexes

Input: the candidate snapshot and graph plus authored and checkout-local state.
Output: a complete `RepovineState` ready for publication. Stage 3 loads or reloads
the annotation store, reads runtime domain and advisory state, and derives domain
suggestions for the candidate graph.

It then builds an in-memory lexical token index over current graph node ids,
labels, selected export-contract fields, and annotation prose. The optional
semantic path projects eligible graph nodes into deterministic cards and
synchronizes a local file-backed embedding index. The sync uses card hashes to
reuse unchanged vectors, re-embed changed cards, and prune cards that left the
corpus.

If semantic synchronization fails, Stage 3 reports the degraded state and may
retain compatible persisted vectors; the current lexical index remains available.
Public semantic candidates are still resolved against the current graph, so a
cached id that is no longer present cannot become a search result. Derived local
onboarding and boundary indexes are projected from the same candidate state.

The complete state is published with one runtime swap after the build finishes.
Each search request pins that state for its duration, so a concurrent refresh
cannot combine semantic ranking from one generation with the graph from another.
There is no independently published search generation: every refresh rebuilds the
lexical index and synchronizes the semantic index before publishing the candidate
runtime state. Query and ranking behavior is described in [Semantic
search](#semantic-search).

### Build publication and degradation

A refresh constructs the next snapshot, graph, indexes, and derived views before
publishing them as one runtime generation. Annotation state lives in one store
across generations; a refresh re-reads the annotations file into it. Concurrent
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

#### Availability during builds

On startup, the MCP server connects its transport before starting the graph build,
so the initialize handshake and `get_build_status` remain available on a cold
cache. Other tools return a successful envelope carrying
`result.status:"building"` until a generation is ready. With `waitSec`,
`get_build_status` long-polls and returns when the build settles; `stageEtaSec`
estimates only the current stage, while `stage` and `remainingStages` describe the
remaining pipeline shape.

`repovine setup` builds eagerly by default, moving the first full build out of the
initial MCP session; `--no-build` deliberately defers it to MCP startup. Later
starts may rebuild after cache incompatibility and incrementally re-extract changed
modules. Operational commands and flags are documented in [CLI and
setup](docs/scripts.md).

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

A plugin is an npm package with a validated manifest and runtime descriptor. One
descriptor may expose any combination of four public capabilities: `source`,
`iac`, `loaders`, and `projectors`. Source and IaC capabilities publish Stage 1
facts; loaders decode documents for IaC parsers; projectors read an immutable fact
view and return restricted Stage 2 contribution batches. Plugins never receive a
mutable graph or import the internal graph ontology (`NodeType`, `EdgeKind`,
`GraphDelta`, `RepositoryGraph`). The host validates outputs, stamps identity and
provenance, mints graph ids, and applies accepted contributions.

Built-ins are separate first-party packages compiled against the same public SDK
and loaded through the same path as installed plugins. They are bundled with the
`repovine` tarball and selected by `@repovine/plugin-default-preset`.

#### Public plugin capabilities

| Capability | Contract surface | Built-in location | Host integration |
|---|---|---|---|
| Source extraction | `@repovine/plugin-sdk/source-plugin` | `packages/plugins/source-<name>/src/` | `src/plugin-host/load.ts`, `src/plugin-host/source-set.ts`, `src/stage1/extract-runner.ts` |
| IaC parsing | `@repovine/plugin-sdk/iac-plugin` | `packages/plugins/iac-<name>/src/` | `src/plugin-host/load.ts`, `src/plugin-host/iac-set.ts`, `src/stage1/infra.ts` |
| Document loading | `DocumentLoader` from `@repovine/plugin-sdk/plugin` | host defaults in `src/plugin-host/document-loaders.ts`; plugin-specific loaders live with their package | `src/plugin-host/load.ts`, `src/plugin-host/iac-set.ts` |
| Projection contributors | `ProjectionContributor` from `@repovine/plugin-sdk/plugin` | `packages/plugins/*/src/projectors/` | `src/stage2/projection/` |

The public capabilities expose data and restricted contribution DTOs, not core
state. Source and IaC deltas are validated before entering the snapshot; document
loader ids have conflict rules; projection batches are schema-checked, budgeted,
host-stamped, and applied atomically.

#### Source parser architecture

Source plugins own package and candidate-file discovery plus language-specific
extraction. The engine enforces repository containment and configured scan filters,
resolves duplicate file claims, mints module ids, reads and hashes source text, and
passes that text to the selected plugin. The plugin returns imports, exports,
semantic hints, and optional schema-owned facts; the engine validates them and
stamps paths, content hash, package identity, and `sourcePluginId` provenance.

Language plugins may differ in extraction depth. Consumers interpret absent
capability-gated facts as unavailable, never as guessed data. Language-specific
inference stays inside producers. Internal interpreters are activated by observable
facts through `requiresSemanticHints` and `requiresSnapshotFacts`, never by
producer id. Baseline code structure and infrastructure linking run over the
shared snapshot; route, UI, and template interpreters run only when their required
fact slots are present. `sourcePluginId` records provenance and does not select an
interpreter. Cross-artifact semantics that do not fit an internal interpreter can
be published as schema-owned facts and consumed by a public projector.

The public contract lives in `@repovine/plugin-sdk/source-plugin`. Author workflow, trust model, and conformance are documented in [Plugin authoring](docs/plugin-authoring.md).

#### IaC parser architecture

IaC plugins parse deployment formats into deterministic resource and published
facts. The host owns repository traversal, scan filters, file reads, document
loader selection, and the raw-file content hash. Each parser declares its file
match and loader id, decides whether it supports a decoded document, and returns
only IaC semantics. The host validates that delta and stamps module identity,
paths, provenance, and content hash.

A decoded document is offered to every matching parser that supports it. Shared
claims may contribute together; overlapping exclusive claims and equally specific
loader disagreements become explicit refusals rather than registration-order
winners. Host-provided YAML, JSON, and text loaders share the same registry with
loaders supplied by plugins.

Stage 2 internal interpreters project baseline infrastructure structure and links.
A plugin may also publish schema-owned facts and provide projectors for
cross-artifact relationships; those projectors return restricted contributions,
while the host resolves references, mints ids, and applies the accepted graph
changes. The ontology remains shared — formats do not receive private node or edge
types. A new format needs no graph primitive when its facts and relationships fit
the existing contracts.

Supported formats and current depth are listed in [Supported stacks](README.md#supported-stacks). Authoring and conformance are documented in [Plugin authoring](docs/plugin-authoring.md).

#### Core-owned extension points

Unlike public plugin capabilities, these extension points compose core-owned
behavior and are not available through the plugin SDK.

| Extension point | Contract | Built-in location | Core composition |
|---|---|---|---|
| Interpreters | `Interpreter` | `src/interpreters/<name>/` plus shared `src/interpreter/` types | `src/stage2/interpreter/` |
| Detector packs | `DetectorPack` | `src/analysis/architecture-detectors/<pack>/` | `src/analysis/architecture/detector-bootstrap.ts`, `detector-registry.ts` |
| Delivery mechanics | `DeliveryMechanic` | `src/mechanics/` | `src/mechanics/registry.ts` |

Interpreters compose graph deltas and entrypoint fragments against the internal
ontology. Detector packs consume graph, snapshot, annotation, threshold, and
architecture-finding contracts. Delivery mechanics bind annotation and topology
primitives to MCP and hook delivery channels. Publishing these extension points
would therefore make their core dependencies public contracts.

#### Template pipeline

Template discovery is a separate built-in Stage 1 path in
`src/stage1/templates.ts`, with `TemplateFileInfo` defined by the internal graph
model. The `server-templates` interpreter projects those facts into template nodes
and composition edges during Stage 2. Adding a template dialect is therefore a
core change today, not a plugin registration. This path can become a public
capability if its discovery and fact contracts stabilize without requiring a
template-specific graph ontology.

## Annotations

**Layer 2.** Versioned annotations give the graph durable authored memory across
sessions, keyed by graph node id and stored in the configured annotations file
(default `repovine.annots.json`, committed). The on-disk format is valid JSON but
canonicalized as one entry per line — the top-level key is the node id; redundant
fields (`nodeId`, `nodeType`, default `pass`/`schemaVersion`) are inferred on load.
This keeps Git diffs and conflict markers scoped to changed records.

### Annotation model

Each stored annotation carries identity and audit metadata, the content and import
baselines used to recompute freshness, and an authored payload. Annotatable node
types are `module`, `export-symbol`, `runtime-resource`, `template`, and `domain`;
`infra:` ids are stored as module annotations. The payload requires `summary`.
Its complete field and disk-format contract is defined in [Workspace
files](docs/workspace-files.md#annotation-payload-fields).

A `risks` entry is a plain string (**local** scope) or `{ text, scope }` with
scope `local`, `consumer`, or `boundary`. Scope selects the delivery channel
([Annotation delivery](#annotation-delivery)), independent of the text. `local` is the default;
`consumer` and `boundary` are the selective exceptions that drive MCP delivery;
`boundary` additionally drives the pre-edit hook.

#### sideEffects vocabulary

`sideEffects` is a closed structured vocabulary shared by annotation validation,
architecture analysis, and delivery mechanics. It distinguishes external I/O,
local and global state, process lifecycle, concurrency, time, subscriptions,
opaque external calls, resource lifetime, and explicit purity without
keyword-matching prose.

The canonical kinds and detector contract are documented in [Workspace
files](docs/workspace-files.md#annotation-payload-fields). The runtime source of
truth is `src/annotations/side-effect-vocab.ts`.

### Persistence

Writes pass through a debounced in-process save chain and a cross-process file
lock. When the file changes externally but remains valid, disk is the merge base:
field-aware local writes overlay only their touched fields while unrelated
external fields survive.
Writes are atomic, and shutdown drains pending work. An unreadable or
conflict-marked file blocks persistence rather than being overwritten; writing
resumes only after repair and reload. The save path lives in
`src/annotations/store.ts`.

#### Semantic merge

Version-control conflicts are resolved through `merge_annotations`, never by
manually editing JSON conflict markers. Its three-way merge combines distinct
records and non-overlapping fields, recursively merges nested records, and unions
array values by canonical identity. When both sides change a scalar differently,
the merge chooses a deterministic side and records explicit merge-review markers
until an agent inspects the node and rewrites that field.

The merge workflow and marker format are documented in [Workspace
files](docs/workspace-files.md#git-merge-workflow).

### Annotation quality and trust

Annotation trust has three independent axes:

- **Freshness** recomputes a verdict from stored hashes, schema versions, import baselines, and the current graph.
- **Consistency** recomputes contradictions between filled fields and graph facts.
- **Provenance** relates annotations written in a run to inspected graph anchors or reported file and node changes.

For code modules, a write associated with a context session warns when the node was
not inspected in that session. Explicit Delivery Protocol validation rechecks the
annotations reported by that run and can enforce grounding according to the run
mode. This provenance verdict is not stored with the annotation and cannot be
reconstructed retrospectively.

The 0–10 annotation score measures field completeness only; it does not claim
correctness or trust. Freshness drives maintenance state, consistency produces
issues, and module kind selects recommended fields without changing the annotation
schema or graph facts. Payload fields and queue behavior are documented in
[Workspace files](docs/workspace-files.md#repovineannotsjson).

#### Freshness and incremental updates

Freshness has four named stale reasons. `content` means the owning artifact's hash
changed; `schema` means the stored annotation predates the current annotation
schema; `propagation` means the node is unchanged but a tracked direct dependency
changed; and `no-baseline` means the node is hashable now but the note was written
without a comparable hash. A node with no hash source is `not-comparable`, while a
note whose node disappeared is an orphan outside the freshness verdict. Runtime
resources use deterministic IaC fingerprints where available.

Freshness is intentionally conservative: a current hash proves that the annotated
artifact is unchanged, not that the prose is complete or correct.

#### Unified queue and coverage

One walk over the live annotatable surface produces both the prioritized queue and
its coverage totals. Unannotated nodes enter directly. Stale reasons `content`,
`schema`, and `no-baseline` map to the content-review class; `propagation` maps to
the upstream-review class. `not-comparable` nodes contribute to the
`unconfirmable` coverage count but create no queue row.

Coverage reports the same backlog by node type and domain, so queue and coverage
cannot disagree about what remains. Orphaned annotations and merge-review drafts
are separate maintenance states surfaced by validation and dedicated actions.
Risk-scope candidates and carrier-link gaps are advisory and never enter the
queue.

Operational queue fields and coverage views are documented in [Workspace files](docs/workspace-files.md#freshness).

## Semantic search

Semantic search is fuzzy entry into the deterministic graph, not a parallel source of truth.

The lexical token index is always available for graph node ids, labels, selected
export-contract fields, and annotation prose. Configuration and entrypoint matches
are resolved by auxiliary collectors alongside graph search rather than stored in
that index.

The optional embedding index ranks node cards deterministically projected from
current graph facts and authored annotation state. Eligible card types are
modules, runtime resources, templates, packages, and domains, but identifier-only
cards are omitted: a node receives a vector only when its card adds export names
or annotation prose beyond what lexical search already covers. Export-symbol
nodes remain directly searchable through the lexical index, and their names feed
parent module cards, but they are not embedded individually.

The embedding index is local and file-backed; it scans the graph-node vector
corpus directly rather than using a vector database. Each query pins one complete
state generation, so semantic candidates are accepted only when their stable ids
exist in that graph. Card hashes make sync incremental. If embedding fails, the
failure is reported and search continues with the current lexical index plus
whatever compatible vectors remain in the local index.

Both indexes may retain stale annotation prose for recall. When query tokens match
annotation text directly, the result exposes `annotationMatched` and, when
established, `annotationStale`. A semantic-only hit cannot identify which card
field drove the similarity, so it remains low-confidence advisory evidence and
must be verified through graph inspection.

Node cards are capped at 1000 characters before embedding tokenization, matching
the roughly 256-token MiniLM input window instead of relying on silent tokenizer
truncation. Within annotation prose the retained order is summary, invariants,
risks, flow, integration points, then verbose per-export descriptions.

`search_context` combines lexical conjunction and bounded relaxation with optional
semantic rank fusion. Its response exposes the strategy, matched tokens,
confidence, gaps, and suggested graph scopes so callers can distinguish strong
matches from fuzzy recovery. Semantic scores orient the first hop; subsequent map,
inspect, impact, flow, and configuration queries operate on graph facts.
Dimension-incompatible vectors are reported rather than disappearing as an
unexplained empty ranking.

Configuration and cache behavior are documented in [Workspace files](docs/workspace-files.md#semantic_search_embeddings).

## MCP context

**Layer 3.** MCP exposes bounded graph queries for orientation, inspection, impact, runtime flow, configuration, architecture review, annotations, build state, and context-session quality. Graph-facing handlers share scope resolution, and all MCP tools share response shaping. Delivery Protocol validation remains a CLI/harness surface.

The public tool list and usage examples are maintained in [README](README.md#mcp-tools).

### Guided envelope

All MCP tools return a common envelope used as a decision framework. The default
response mode is `concise`; the example below includes optional fields that appear
only when they carry information:

```json
{
  "scope": "auth",
  "resolvedScope": { "kind": "domain", "id": "domain:auth" },
  "summary": "What this result tells you",
  "confidence": "high",
  "attention": [{
    "nodeId": "mod:workspace/packages/auth/src/session-handler",
    "investigate": ["boundary"],
    "note": "off-limits boundary surface",
    "next": {
      "tool": "analyze_dependencies",
      "args": { "scope": "mod:workspace/packages/auth/src/session-handler", "mode": "impact" },
      "reason": "Check consumers before editing an off-limits surface."
    }
  }],
  "result": { "...": "tool-specific payload" },
  "gaps": ["Known limitations or withheld evidence"],
  "refs": { "$1o9j2uk": "mod:workspace/packages/auth/src/session-handler" },
  "navigation": {
    "deeper": [{ "tool": "inspect_node", "args": { "nodeId": "$1o9j2uk" }, "reason": "Inspect this match" }],
    "sideways": [{ "tool": "analyze_dependencies", "args": { "scope": "$1o9j2uk", "mode": "impact" }, "reason": "Check consumers before editing" }]
  }
}
```

`summary` interprets the result. `confidence` records whether the scope resolved
and the tool produced a direct result; it is not a trust or completeness score.
Known limitations, recall ceilings, and withheld evidence belong in `gaps`.
`inspect_node` may hoist edit-relevant signals into `attention` for primacy
([Annotation delivery](#annotation-delivery)), capped at 3. `navigation` is a
bounded next-step menu grouped by intent
(`deeper`/`sideways`/`up`/`crossLayer`/`validate`).

Concise shaping compacts `resolvedScope`, removes empty `gaps` and navigation
sections, and shortens navigation reasons. Eligible repeated or very long graph
ids inside `navigation.args` become short-lived, server-local `refs`; an immediate
follow-up call may pass the ref directly. Attention items retain full ids.
`responseFormat: "concise" | "debug"` overrides the configured mode per call.

### Annotation delivery

In client use, Layer 2 notes reach the agent through Layer 3 tools and a generated
pre-edit hook. At the design level, delivery splits into four **registers** — ways
the same fact is presented to the reader. Three registers pull on an MCP call;
the fourth pushes at the edit site. Registers are distinct from the implementation
channels (`pull-self`, `pull-neighbor`, `pull-carrier`, `push`, and `advisory`).

| Register | Carries | Surfaces |
|---|---|---|
| content | a full annotation or a bounded excerpt | full note in `inspect_node.result.annotation` and `map_context` domain scope; excerpts in `analyze_architecture` detail |
| pointer | presence only — "inspect this node" | `investigate` tags on refs; `investigatePointers`; `search_context` escalation gap; `trace_flow` `runtimeHandoff` `trigger:"annotation"` |
| salience | edit-relevant signals hoisted to primacy | envelope `attention` block |
| push | boundary text at the edit site | pre-edit hook over `.repovine/boundary-index.json` |

Health-and-coverage tools (`get_annotation_status`, `validate_annotations`) report
facts *about* notes — counts, staleness, quality, risk-scope candidates — under
[Unified queue and coverage](#unified-queue-and-coverage). The pointer register carries no annotation text: it
marks a node and routes the agent to `inspect_node` for the content.

#### Mechanics registry

A **delivery mechanic** pairs a detection trigger with the channels its signal
reaches. In `src/mechanics/registry.ts`, ordered `DELIVERY_MECHANICS` is the source
for mechanic ids, tag priority, detection, and channel membership;
`CHANNEL_SURFACES` maps every channel to its concrete producers and response field.
`mechanicsForChannel` makes channel membership load-bearing for generic delivery.
The delivery-totality and delivery-invariance laws check the declarations against
the surfaces that emit them.

Surface-specific rendering remains in the MCP, boundary-index, and annotation
advisory producers. Those producers own ordering, caps, pagination, and the
boundary push artifact.

| Delivery mechanic (`id`) | Reads | Direction | Delivers to |
|---|---|---|---|
| `risk` | `scope:"consumer"` risk | propagating | pointer, advisory |
| `boundary` | `scope:"boundary"` risk | self | pointer, salience, push, advisory |
| `effect` | persistent `sideEffect` | self | pointer |
| `wiring` | runtime `infra`/`binds_to` edges (topology) | self | pointer, salience |
| `co-change` | `implements` edges (topology) | propagating | pointer |
| `hub` | import in-degree (topology) | self | pointer |
| `unannotated` | annotation absent | self | reserved — declared, emitted by none |

`direction` is descriptive metadata: `self` means the signal describes the node
itself, while `propagating` means it concerns related consumers. `co-change` is
semantically symmetric, but the enum has no `symmetric` value, so it uses the
closer `propagating` description. Routing and push admission are determined by
`channels`. The generic `pull-neighbor` and `pull-carrier` paths dispatch through
`mechanicsForChannel`; `pull-self`, `push`, and `advisory` have specialized
renderers or projections. Adding a mechanic therefore also extends the public tag
vocabulary and executable laws, and specialized channels require a matching
producer. Applicability still follows the primitive rather than a language branch:
`detect` returns false when its input is absent. The `risk` mechanic emits the tag
named `risk` (API-visible in `inspect_node`).

**Current built-in primitive coverage.** A mechanic reaches a language only where
a plugin produces its primitive:

| Primitive | Produced by | Mechanic | Languages |
|---|---|---|---|
| `annotation.scope:*`, `annotation.sideEffects`, `annotation:absent` | annotation lookup; `annotation:absent` is reserved and never emits | `risk`, `boundary`, `effect`, `unannotated` | any annotatable node |
| `topology.inDegree` | source plugins that emit import facts | `hub` | languages with import facts |
| `topology.runtimeEdges` (`infra`/`binds_to`) | infra/runtime-link interpretation over plugin facts and handler resolution | `wiring` | any resolved handler module; bundled coverage includes TypeScript/JavaScript and Python |
| `topology.implementsEdges` (`implements`) | code-structure interpretation over source-plugin `implementsInterfaces`; currently emitted by bundled TypeScript/JavaScript | `co-change` | bundled TypeScript/JavaScript; bundled Python emits none |

A mechanic whose primitive no active plugin produces is **dormant**: `detect`
self-gates to false, not an error — the delivery-side view of an absent
capability-gated fact. Extending an existing mechanic to a new language therefore
means teaching that language's plugin to emit the existing primitive, with no
language conditional in delivery core. For `co-change` on Python that means
populating `implementsInterfaces` from ABC / `Protocol` conformance in
`packages/plugins/source-python/src/`.

<details>
<summary><b>Deep dive — investigate tags, attention, carriers, and pre-edit push</b></summary>

#### Investigate tags

The pointer register renders the mechanics above as `investigate` tags on a ref
(`links`, `drillDown`, or an `investigatePointers` target). Once a target is
selected, its tags come from structured risk/side-effect fields or graph topology,
not fuzzy prose classification. The carrier path separately parses explicit graph
node ids from `integrationPoints` to select deeper targets.

Tags rank highest-first `risk > boundary > effect > wiring > co-change > hub`;
`unannotated` sits reserved at rank 4 and never emits. Per-ref cap is 3 tags;
per-response cap is 12 tagged refs, reported in `truncation.investigateRefs`.
`hub`, `wiring`, and `co-change` are inline-only structural tags, capped at 2
refs each. Generated agent guidance still treats every emitted `investigate` tag
as a closure signal, but these three are not auto-promoted into `attention` or
`navigation`; `wiring` has a separate salience surface as a self-attention item on
the wired node. Implementation: `src/mcp/lib/investigate-refs.ts`.

#### Attention block

Refs carrying `risk`, `boundary`, or `effect` are deduped by node, ranked by top
tag priority, and hoisted to the envelope `attention` block above `result`, capped
at 3. Each item pairs the reason with the cheapest next call. Attention is data,
not a gate, and may also contain the inspected node's structural wiring signal.

Two signals on the **inspected** node itself yield self items that lead the
block, in order: a `scope:"boundary"` risk points at `analyze_dependencies`
impact; runtime wiring names the wired resources and points at `trace_flow`.
Landing on a frozen edit-site or a deployed handler is then as salient as
reaching one through a ref. Implementation: `src/mcp/tools/inspect-node.ts`.

#### integrationPoints carrier

A note's own `integrationPoints` names deeper dependencies by node id. Tokens are
parsed, graph-membership filtered, and kept when the inspected node transitively
depends on the target (depth-4 forward-import guard). A surviving target that
carries a tag surfaces as an `investigatePointers` entry — the facade→SSOT
carrier pair ([Annotation model](#annotation-model)). `risk`, `boundary`, and
`effect` pointers are also auto-promoted into `navigation.deeper` and are eligible
for `attention`; inline-only structural pointers remain in the result. Targets
already present as structural refs are excluded from `investigatePointers`.

The authoring counterpart runs at annotation health. A gap is
`missing-carrier-link` when a runtime 2-hop delegation omits the target from the
importer's `integrationPoints`, and `named-but-undeliverable` when a named target
sits outside the importer's dependency closure. Both are advisory.
`missing-carrier-link` candidates group by consumer-risk SSOT target in the
carrier-gaps view and may be marked reviewed-not-a-gap; `named-but-undeliverable`
is reported separately and is not suppressed by that review state. Reviewed
decisions persist in `.repovine/carrier-review.json`. Entries are keyed by target
node id and store a hash of that target's consumer risks; a changed risk set
re-surfaces the target. Implementation:
`src/annotations/carrier-links.ts`, `src/annotations/carrier-review.ts`.

#### Pre-edit push

`scope:"boundary"` risks project into `.repovine/boundary-index.json` at graph
build or refresh and after relevant annotation writes, keyed by the repo-relative
file each annotated node owns. When generated client hooks are installed, the
`boundary-notice` `PreToolUse` action reads the index standalone — no running
server, one indexed lookup per edited file — and surfaces the boundary text before
the edit lands. The notice is advisory and never blocks the client tool.

This is the deterministic backstop for the `node → boundary` lookup
`inspect_node`'s `attention` serves on the pull path; both derive from the same
`scope:"boundary"` source. Modules, exports, file-backed `infra:` nodes, and
templates map to a file. Domains and projected `resource:` nodes have no single
owning file and stay pull-only. Implementation: `src/mcp/boundary-index.ts` and
`src/cli/dispatcher/repovine-client-dispatcher.mjs`.

</details>

### Diagnostics and scope recovery

Empty or weak results are explicit states. Shared diagnostics distinguish an empty graph, unresolved scope, filtering, and pagination misses; tool-specific diagnostics explain why a valid scope has no result for that query class.

Diagnostics include bounded retry/navigation suggestions. Semantic scope suggestions may assist a free-text miss, but no scope resolves silently. The authoritative reason enum lives in `src/mcp/response/empty-diagnostics.ts`.

### Response budget

Response size is an architectural constraint. Concise shaping compacts envelope
metadata, shortens navigation reasons, and replaces eligible graph ids in
navigation arguments with server-local refs. Tool payloads page collections and
bound source bodies; the envelope caps navigation and attention. Larger bodies,
limits, or debug envelopes require explicit caller choice.

## Agent workflows and Delivery Protocol

**Layers 4–5.** repovine supplies shared graph tools and committed annotation
memory. Clients and harnesses own agent execution and coordination; explicit
Delivery Protocol runs additionally return a structured result that repovine can
validate.

### Client projections and delegation boundary

`setup` renders client-native rules, skills, hooks, and agent manifests from the
same graph, annotation, refresh, and review contracts. These projections adapt
the workflow to each supported client; the repository graph and committed
annotations remain the shared state.

Clients and harnesses own model execution, permissions, delegation, retries, and
review. repovine supplies context, synchronization barriers, durable memory, and
validation. Autonomous harnesses can obtain generated worker guidance through
`repovine delivery run-brief`. Setup behavior and managed-file ownership are
documented in [CLI and setup](docs/scripts.md); protocol projections are described
in [Delivery Protocol](docs/delivery-protocol.md#projections).

### Context Session Quality

Context Session Quality derives a deterministic report from the repovine MCP
responses recorded before handoff. Assignment policy may require a session and
configure its reporting thresholds, but the resulting verdict is currently
advisory in both client and harness modes: thresholds shape warnings and required
follow-ups, not compliance validity.

Signals, lifecycle, validation evidence, and recovery semantics are documented in
[Context Session Quality](docs/context-quality.md).

### Delivery Protocol boundary

The harness-facing contract is
`AgentAssignment → AgentRunResult → AgentComplianceReport`.

repovine validates schemas and the claims it can recompute from repository state:
graph identities and scope, annotation state, repository-grounded evidence,
declared protocol policy, and recorded context-session data. External evidence
such as test, build, runtime, security, or review results remains under harness
custody; repovine validates its declared shape and admissibility, not its
execution or truth.

The harness owns model execution, permissions, retries, behavioral checks, review,
and final acceptance. Delivery Protocol commands are exposed through the CLI and
build repository state with the same engine used by MCP; MCP remains the worker
context surface.

Protocol objects, projections, commands, lifecycle, and integration examples are documented in [Delivery Protocol](docs/delivery-protocol.md).

## Executable contracts

Architecture claims that constrain extension or delivery behavior are enforced
at their narrowest observable boundary:

| Contract | Executable guard | What a failure means |
|---|---|---|
| Graph ontology and invariants | `test/laws/` | Schema shape, producer/consumer witnesses, typed node data, honest absence, determinism, or source ownership no longer matches the design. |
| Stage 1 extraction compatibility | `test/laws/extract-output-golden.test.ts` | Extracted facts changed; the change must be reviewed together with the analysis-version and cache-compatibility decision. |
| Plugin boundary and conformance | `test/laws/plugin-*.test.ts`, `test/laws/producer-emits-semantics-only.test.ts`, and `test/unit/plugin-sdk/conformance.test.ts` | A producer crossed the semantics-only boundary or no longer satisfies the public SDK contract. |
| Annotation delivery | `test/laws/delivery-totality.test.ts`, `test/laws/delivery-invariance.test.ts`, and focused MCP/hook tests | The mechanic vocabulary, channel-to-surface mapping, pointer/salience behavior, carrier closure, or pre-edit projection changed. |
| Delivery Protocol | `test/laws/delivery-protocol-*.test.ts` and `test/integration/delivery-protocol-cli-blackbox.test.ts` | The descriptor, schemas, documented examples, command registry, assignment/result validation, compliance JSON, or exit-code behavior changed at the harness boundary. |

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
| 1 | **Fragmented reference resolution** | imports, implements, calls, template references, runtime handlers, and resource references use separate resolution paths; shared scoped helpers exist only within individual families | ambiguity, provenance, and fallback behavior diverge across edge kinds, and each new reference class repeats part of the problem | **structural** |
| 2 | **No per-fact coverage signal** (honest-empty = not-yet-extracted) | plugin capabilities do not tell a consumer whether a specific fact is truly absent or merely unsupported by that extractor | cross-language analyses silently under-deliver on weaker plugins, with no low-confidence signal | **structural** |
| 3 | **Domain overlay is a noisy heuristic** | path, cluster, and pattern inference can assign overlapping domains; `tagged` carries both membership and nesting | misleading groupings an agent trusts for scoping | mixed |
| 4 | **`semanticHints` is one versioned bag** | the whole producer→interpreter coupling rides fixed slots; passthrough slots are inert without code | the set ossifies (new facts don't fit) or bloats into a kitchen sink | **structural** |
| 5 | **Heuristic runtime-handler resolution** | source plugins interpret handler strings independently and the first result naming a known module wins; ambiguity and resolution provenance are not published | as source and IaC ecosystems diversify, plausible name collisions can produce a wrong link while unsupported handler forms leave resource islands | **maturity** |
| 6 | **Annotation drift** (the one semantic layer) | decay can outpace repair; client maintenance is advisory and hard enforcement exists only when a harness or CI policy requires it | on an active repo the semantic layer drifts from reality | **structural** |

**Why #2 and #6 are structural.** Maturing the Python plugin raises Python
*coverage*, not *structure*: the frontier (N languages × M facts) always exists,
"done" is unobservable (honest-empty is indistinguishable from not-yet), and the
fix — a per-fact coverage signal in `gaps`/`confidence` — is orthogonal to any one
extractor. Annotation freshness is behavioral: decay can outpace authored repair,
client queues remain advisory, and enforcement requires an explicit harness or CI
policy. It is the only layer with no auto-extraction.

**Subtler risks.** Name-based identity (`export:module/name`) makes a rename
delete+add, so annotations orphan on refactor-heavy repos. The closed relation
ontology makes any new relation a core and SDK contract change (a v1 trade-off).
No history-derived axis (churn or commit-level co-change) caps "what's risky to
change" questions.

These risks do not imply an automatic refactoring roadmap. Resolver, coverage,
or freshness changes should be justified by concrete query failures and treated
as behavior changes. Expanding plugin coverage and maintaining annotations are
independent maturity work.

### Known gaps in 0.1.0

The table above grades the architecture. This one records measured shortfalls in
what 0.1.0 actually emits, and the response each one already carries. They ship
as listed.

| # | Gap | Evidence | Response in 0.1.0 |
|---|---|---|---|
| 1 | Three architecture categories fail clean-code counterexamples | `duplicate-like`, `god-module`, and `authorization-policy-drift` emit on retained fixtures deliberately carrying no corresponding smell | the categories are excluded from `DEFAULT_REFACTORING_CATEGORIES` and covered by `default-categories.test.ts`; callers can still request them explicitly |
| 2 | Semantic fusion constants are fitted to one repository | cosine floor and RRF weights were chosen in-sample on one codebase; the corpus is not retained, so the fit is not a reproducible cross-repository benchmark | the four constants live in `semantic/relevance.ts` and reach the ranker by import, so recalibrating the semantic half is a one-file edit; lexical token scores stay in `mcp/lib/search-graph.ts` |
| 3 | Secret/public env classification is TypeScript-only | the Python producer fills `envVars` and framework hints; the `security` slot stays empty | a Python `os.getenv("DB_PASSWORD")` returns `kind: 'env'` and `get_config_surface({kind:'secret'})` omits it; `gaps` names only computed and aliased accesses, so the omission carries no signal |
| 4 | Two declarations with the same plugin-defined resource identity collapse to one node | graph identity is `resource:<namespace>:<localKey>`; some built-ins use a logical id or local name without a document or stack component, so sibling declarations can collide | the later payload occupies the node while `declaredIn` retains every declaration path; scoped reference resolution uses `declaredIn` / `refScope`, but the public graph still exposes one node and no collision gap |
| 5 | The CLI build-progress ETA extrapolates per package | package jobs span one module to the ~1600-module sharding threshold and the CLI weights every job equally, so early estimates on large monorepos are wrong by a similar factor | the MCP contract reports `stageEtaSec` for the current stage only, and clients wait via one `get_build_status` long-poll rather than reading an ETA; the CLI progress line is display-only and stays wrong |

Rows 1 and 2 need broader retained labelled corpora spanning several repositories
before reliability claims can extend beyond the current counterexamples and
in-sample calibration. Rows 3 to 5 are engineering, unblocked.

## Related documentation

- [README](README.md) — product overview, tools, setup, supported stacks, and examples.
- [Workspace files](docs/workspace-files.md) — configuration, domains, annotations, cache, and merge workflows.
- [Delivery Protocol](docs/delivery-protocol.md) — harness and CI integration.
- [Plugin authoring](docs/plugin-authoring.md) — source and IaC producer contracts.
- [CLI and setup](docs/scripts.md) — commands and managed assets.
- [Contributing](https://github.com/legann/repovine/blob/main/CONTRIBUTING.md) — development workflow and module ownership.
