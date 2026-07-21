---
id: naming-regression
title: Naming / rename contract regression (parameterized)
mode: read-only
repo_agnostic: true
applies_when: always
budget: { tool_calls: 16, mode: full }   # quick subset: graph-ready, stable-public-names, context-session-accepted (rename checks N/A while params empty in v1)
rollup: worst-of

# ─────────────────────────────────────────────────────────────────────────────
# EDIT THIS BLOCK — the rename contract under test. Everything below is generic
# machinery over these strings; plug in ANY migration's old→new pairs.
# Leave a category empty ([]) to skip its checks (they become N/A).
#
# v1 ships EMPTY. This is the first version: no migration has happened, so there is
# nothing to regress against. The card is a SCAFFOLD — when a future rename pass lands,
# fill the categories below with its old→new pairs and the per-pair checks activate
# automatically. Until then every rename check is N/A; only graph-ready,
# stable-public-names, and context-session-accepted do real work.
# ─────────────────────────────────────────────────────────────────────────────
params:
  # Graph id prefix renames — entry shape { old, new, discover_query? }.
  # The `new` prefix must resolve; the `old` prefix must NOT resolve as canonical.
  id_prefix_renames: []

  # Node type/kind renames — entry shape { old, new, pairs_with_prefix? }.
  # inspect_node on a `new`-prefixed node reports `new`; no live node reports `old`.
  node_type_renames: []

  # Facts/field renames inside module/snapshot facts — entry shape { old, new }.
  field_renames: []

  # Internal symbol/role/type renames in the tool's OWN graph, gated by applies_when_repo.
  # Pair shape { old, new }.
  symbol_renames:
    applies_when_repo: "is_repovine"          # gate (e.g. pkg:repovine substring); "" = always check
    pairs: []

  # Deferred renames: names mid-migration where the OLD form may still leak (still visible = INFO,
  # never FAIL). v1 has NO pending renames — the analyze_architecture category slugs, the
  # get_entrypoints `layer` filter, the trace_flow/get_config_surface `services`/`resources`
  # projection keys, and the source/iac plugin contract names are all CURRENT canonical names, not
  # legacy. Keep empty unless a real migration is in flight.
  deferred_renames: []

  # Names that MUST NOT change — breakage here is FAIL. Free-text + tool list.
  stable_public_names:
    tools: ["search_context","map_context","inspect_node","get_entrypoints","trace_flow","analyze_dependencies","get_config_surface","analyze_architecture","refresh_context","get_build_status","get_context_session_quality","get_annotation_status"]
    args:  ["contextSessionId"]

checks:
  - id: graph-ready
    assert:  get_build_status settles to ready and refresh_context returns without error
    fail_if: build never settles, or refresh_context errors / returns a schema error
    severity: fail
  - id: new-prefix-resolves
    assert:  for each params.id_prefix_renames entry, a discovered node whose id starts with `new` resolves via inspect_node
    fail_if: a `new`-prefix node fails to resolve where that surface demonstrably exists
    na_if:   no node carrying that `new` prefix exists in the repo (per entry)
    severity: fail
  - id: old-prefix-rejected
    assert:  for each params.id_prefix_renames entry, the `old` prefix (same suffix) does NOT resolve as a canonical node
    fail_if: an `old`-prefix id resolves cleanly as a first-class graph node
    na_if:   no `new`-prefix anchor was found to derive an `old` form from (per entry)
    severity: fail
  - id: new-node-type
    assert:  for each params.node_type_renames entry, inspect_node on the paired `new`-prefix node reports type `new`
    fail_if: the node reports the `old` type as its canonical kind
    na_if:   no node of that surface exists (per entry)
    severity: fail
  - id: old-node-type-absent
    assert:  no live node presents an `old` node type from params.node_type_renames as its canonical kind
    fail_if: a live node's canonical type equals an `old` type string
    na_if:   params.node_type_renames is empty
    severity: fail
  - id: new-field-name
    assert:  for each params.field_renames entry, module/snapshot facts expose the field as `new`
    fail_if: the live facts field is named `old`
    na_if:   no inspected node exposes that facts field (per entry)
    severity: fail
  - id: new-scope-accepted
    assert:  analyze_dependencies accepts a `new`-prefix scope (e.g. export:) and impact ids use `new` prefixes, not `old`
    fail_if: a `new`-prefix scope is rejected, or impact ids carry an `old` prefix
    na_if:   no `new`-prefix anchor suitable for dependency scope exists
    severity: fail
  - id: symbol-renames
    assert:  for each params.symbol_renames.pairs entry, graph/search shows `new` and not `old` as a live canonical symbol
    fail_if: an `old` internal symbol/role/type appears as a live canonical symbol
    na_if:   params.symbol_renames.applies_when_repo does not match this repo, or the list is empty
    severity: fail
  - id: stable-public-names
    assert:  every name in params.stable_public_names (tools + args) is still callable/accepted
    fail_if: a listed public tool name is missing/renamed, or a listed argument is rejected, on a valid call
    severity: fail
  - id: context-session-accepted
    assert:  the contextSessionId argument is accepted and get_context_session_quality returns a report
    fail_if: contextSessionId is rejected, or get_context_session_quality errors
    severity: fail
  - id: deferred-renames-info
    assert:  any params.deferred_renames still visible are reported as INFO, not failures
    fail_if: never FAIL — deferred renames are informational only
    na_if:   params.deferred_renames is empty (v1 default — nothing is mid-migration)
    severity: warn
---

You are a read-only repovine MCP naming-regression agent. Verify that MCP tool responses in the
target repository honor the **rename contract declared in the `params` block above** — generically.

Honor the shared preamble in `_PREAMBLE.md` (read-only — `cleanupOrphans` forbidden; one
`contextSessionId` like `naming-regression-YYYY-MM-DD-<repo-slug>`; build readiness; discovery;
evidence gate; concise-first). Derive every node id/scope/package from MCP responses in the target
repo — never hardcode repo names, paths, or golden ids.

## How to read `params`

`params` is the **only** thing that changes between migrations. Treat each category generically:

- `id_prefix_renames[]` → `{ old, new, discover_query? }`: a node id should start with `new`; the
  `old` prefix (same suffix) must not resolve.
- `node_type_renames[]` → `{ old, new, pairs_with_prefix? }`: inspect_node on a `new`-prefix node
  reports type `new`; no live node reports `old` as its canonical type.
- `field_renames[]` → `{ old, new }`: facts field is `new`, not `old`.
- `symbol_renames.pairs[]` → `{ old, new }`, gated by `symbol_renames.applies_when_repo`: internal
  graph symbols/roles/types are `new`, not `old`. **N/A unless the repo matches the gate.**
- `deferred_renames[]` (free-text): names mid-migration; still visible = **INFO**, never FAIL.
  **Empty in v1** — current names (category slugs, `layer`, `services`/`resources`) are not legacy.
- `stable_public_names.{tools,args}`: must keep working — breakage is FAIL.

If a category is empty, its checks are N/A. Do not invent renames not listed in `params`.

## Steps

1. **Graph readiness** → `graph-ready`.
   `get_build_status({ waitSec: 45, contextSessionId })`, then `refresh_context({ contextSessionId })`.

2. **Discover anchors per `id_prefix_renames`** → `new-prefix-resolves`.
   For each entry, search with its `discover_query` (or a generic
   `search_context({ query: "package module export runtime resource infra", limit: 15, contextSessionId })`
   plus `map_context({ scope: "all", view: "summary", limit: 20, contextSessionId })`). Record the
   first real node id starting with `new`. If none exists, that entry's positive checks are N/A.

3. **Canonical types & fields** → `new-node-type`, `old-node-type-absent`, `new-field-name`.
   `inspect_node` (no body) on each discovered `new`-prefix anchor. Confirm: type equals the paired
   `new` (per `node_type_renames`); no canonical type equals any `old`; facts fields use each
   `field_renames.new`, not `old`.

4. **Removed-prefix rejection (negative)** → `old-prefix-rejected`.
   For each `id_prefix_renames` entry with a discovered `new` anchor, derive the `old` form by
   swapping the prefix on the same suffix and `inspect_node` it; also
   `search_context({ query: "<old1> <old2> ...", limit: 10, contextSessionId })`. PASS if `old` ids
   are unresolved / errored / flagged via emptyDiagnostic — FAIL if any resolves as canonical.

5. **Dependency scope** → `new-scope-accepted`.
   `analyze_dependencies({ scope: "<discovered new-prefix node>", mode: "impact", depth: 2, contextSessionId })`
   (use a `mod:` if no other `new` scope fits). PASS if accepted and impact ids carry `new`
   prefixes, never `old`.

6. **Public surface + session** → `stable-public-names`, `context-session-accepted`.
   The tools in `params.stable_public_names.tools` were exercised across steps 1–5 and must all be
   callable; each accepted `params.stable_public_names.args`. End with
   `get_context_session_quality({ sessionId: contextSessionId, phase: "explore", mode: "client" })`.

7. **Internal symbols (gated)** → `symbol-renames`.
   Only if `params.symbol_renames.applies_when_repo` matches this repo (e.g. a `pkg:repovine` node
   exists, or the gate is ""): `search_context({ query: "<new1> <new2> ...", limit: 10, contextSessionId })`
   and a scoped `map_context`. PASS if each `new` symbol/role/type is live and no `old` one is a
   live canonical symbol. **N/A for repos that do not match the gate.**

8. **Deferred renames** → `deferred-renames-info`.
   N/A in v1 — `params.deferred_renames` is empty (nothing mid-migration). If a future migration
   populates it, note any still-visible old form as INFO — never fail on them.

## Quick mode

Steps 1 and 6 (`graph-ready`, `stable-public-names`, `context-session-accepted`) — the only checks
with data while `params` is empty in v1. When a future migration populates `params`, also run steps
2–4 (`new-prefix-resolves`, `old-prefix-rejected`, …). Still discovery-driven; still N/A for absent surfaces.

## Report format

- **Overall**: PASS / WARN / FAIL for the rename contract (apply `rollup: worst-of`).
- **Tested repo**: root, branch, short commit, `contextSessionId`.
- **Rename map under test**: echo the `params` old→new pairs actually exercised, and which were N/A.
- **Check matrix** — one row per `checks[]` id, with a per-pair sub-line where the check ranges over
  a populated `params` list (a single **N/A** row when the category is empty, as in v1):

  | Check id | Pair (old → new) | Result | Evidence (exact id / type / field seen) |
  |----------|------------------|--------|-----------------------------------------|
  | graph-ready | — | PASS/FAIL | … |
  | new-prefix-resolves | — (params empty in v1) | N/A | … |
  | old-prefix-rejected | — (params empty in v1) | N/A | … |
  | new-node-type | — (params empty in v1) | N/A | … |
  | new-field-name | — (params empty in v1) | N/A | … |
  | new-scope-accepted | — | N/A | … |
  | symbol-renames | — (params empty in v1) | N/A | … |
  | stable-public-names | — | PASS/FAIL | … |
  | context-session-accepted | — | PASS/FAIL | … |

- **Findings** first, ordered by severity (check id, pair, Expected, Actual, Impact).
- **MCP calls made** (tool + key args, no secrets).
- **Context quality** summary for the shared `contextSessionId`.
- **Deferred renames** observed (INFO) — listed, not failed (N/A in v1: none in flight).
