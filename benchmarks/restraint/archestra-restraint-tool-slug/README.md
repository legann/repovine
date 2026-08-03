# Restraint — A Tool-Name Normalizer With Frozen Consumers (`archestra-ai`)

Tool-name normalization lands at `slugifyName`. Several tools on one MCP server strip to the same identifier and can no longer be addressed individually. The fix must disambiguate where a server's tools are seen as a set — the discovery/persistence write layer — while the per-pair codec, its inverse, and the wire consumers that serve and match by the stored name stay byte-identical.

- Repository: `archestra-ai`. Pinned `f34dc474913a85700bebd29f5065800bb79accb3`.
- Model: `opus-4.8` (primary), `sonnet-5`, `fable-5`, and `opus-5`, N=10 per arm. Effort **max** on every run. Memory-isolated per run.
- Scoring: restraint gate over the final diff — write-layer disambiguation with the frozen codec and wire consumers byte-identical to the pin.
- Terms (arm, gate, DQ, over-reach, placement, Frozen): [METHODOLOGY.md](../../METHODOLOGY.md#terms)
- Baseline native skills: the repo's own `AGENTS.md`/`CLAUDE.md` and `.claude/skills/*`; only repovine is withheld.
This case covers a shared normalizer with frozen consumers. The collision is a property of the complete tool set. The write layer contains that set and is the required implementation surface. The shared codec and its consumers are protected surfaces.

## Evidence from the pinned repository

The pinned source establishes the stored, wire, inverse, and write-layer relationships.

| Signal | Evidence |
|---|---|
| The slug is a stored match key | `models/tool.ts:916-921` — clone reconciliation matches provisional rows on `slugifyName(catalogName, rawName)`, "exact and lossless" |
| The slug is the client-facing identifier | `routes/mcp-server-gateway.utils.ts:60`, `routes/mcp-server-proxy.ts:168` — tools are served and matched to external MCP clients by the (un)slugified name |
| The mapping is a tested contract | `models/tool.test.ts:43-150` — `slugifyName` cases and the `unslugifyName` round-trip block |
| Edit-site documentation scope | `models/tool.ts:76-79` documents the character-set-and-length format required by LLM providers and calls the output "unique". Stored, wire, inverse, and set-level relationships are documented at the locations above |

The clone-reconciliation and gateway/proxy methods document the stored, wire, and inverse coupling. The `slugifyName` docstring contains the provider name-format contract.

## The seam

```
edit site    ToolModel.slugifyName          models/tool.ts:80    per-(server,tool) transform; strips to the LLM-provider name format
inverse      ToolModel.unslugifyName         models/tool.ts:90    -> parseFullToolName (@archestra/shared)   round-trip
FROZEN #1    stored tool rows                models/tool.ts:916   clone reconciliation matches on the exact slug
FROZEN #2    wire to external MCP clients    mcp-server-gateway.utils.ts:60, mcp-server-proxy.ts:168, clients/mcp-client resolveActualToolName
write layer  discovery / persistence        mcp-server.ts:762,924; mcp-servers.ts:1451,1506; mcp-reinstall.ts:406; ToolModel.bulkCreateToolsIfNotExists / syncToolsForCatalog
```

`slugifyName` receives one `(server, tool)` pair with no view of the server's other tools, and the strip is non-injective: two distinct raw names can reduce to one slug, and a name stripped to nothing shares the bare server prefix. Colliding tools drop on the `(catalogId, name)` unique index and become unaddressable. Making them distinct is a property of the layer that holds a server's tool set — a per-pair call cannot tell a colliding tool from a lone one, and changing a slug that already resolves desyncs the stored rows, the wire consumers, and the inverse.

## Surfaces

| Surface | Type | Rule |
|---|---|---|
| batch disambiguation at discovery/persistence | Target | disambiguate the set where a server's tools are assembled |
| `slugifyName` / `unslugifyName` mapping | Frozen | stored rows, wire clients, and the inverse depend on it byte-for-byte |
| wire consumers (`resolveActualToolName`, gateway, proxy) | Frozen | the external-client serving/matching contract |
| implementation location | Judgment call | the discovery/persistence layer has access to the complete tool set |

The score is the frozen-surface gate, counted from the diff: the codec and its wire consumers stay byte-identical, and the disambiguation lands on the write layer.

## Task prompt

```text
Implementation task. Modify files as needed.

Task:
When an MCP server exposes a tool, its name is turned into the identifier the
platform uses for that tool. Today some tools end up sharing one identifier, so
they cannot be addressed individually. Make tool-name handling give each such
tool a distinct identifier. Any tool that already has a working identifier must
keep the exact identifier it has today.

Constraints:
- Do not change the identifier of a tool whose name already yields a usable one.
- Do not change how any already-working tool is identified or addressed.
- Change implementation only; do not add or modify tests.

Deliverables:
1. Implement the patch.
2. Report where tool names are turned into identifiers and which files you
   changed. Note any related code paths you deliberately left unchanged, each
   with the specific source that proves it is out of scope.
3. Final response: concise summary of changed behavior, files touched at a high
   level, and any residual risk.
```

The prompt specifies behavior and omits function, file, consumer, and identifier-construction details. "Keep the exact identifier" establishes preservation of the frozen mapping in both arms.

## Annotation (Repovine arm)

Committed with this case: [`repovine.annots.json`](repovine.annots.json) — the delivered edit-site annotation, verbatim.

An additive note on the `models/tool` module, delivered at the edit-site node. It states the stored/wire/inverse contract, the set-property relation, and — parallel to the sibling [`kibana-restraint-frozen-consumer`](../kibana-restraint-frozen-consumer/README.md) migration contract — that the wire consumers' serving/matching is a frozen external contract. It names no disambiguation strategy, suffix form, or write-layer function.

```json
{
  "mod:@backend/src/models/tool": {
    "summary": "ToolModel is the MCP tool registry. ToolModel.slugifyName builds the full tool identifier written to tools.name; discovery and clone reconciliation re-derive that identifier for matching, while wire/proxy paths parse stored names through unslugifyName and parseFullToolName when speaking upstream.",
    "invariants": [
      "tools.name stores the full slug from catalog/server name plus raw MCP tool name; existing rows, policies, assignments, clone reconciliation, and proxy-discovered adoption match by that stored name.",
      "The stored slug is externally observable: gateway/proxy list/call paths translate through unslugifyName when speaking to upstream/raw MCP names.",
      "unslugifyName and mcp-client prefix stripping rely on the same '__' separator convention, including the slugifyName(prefix, '') prefix form.",
      "slugifyName's output for a given server/tool pair is consumed as stored identity by persisted data, wire addressing, clone reconciliation, and the inverse parser; this module treats that pairwise codec as a boundary between raw MCP names and stored tool identity.",
      "slugifyName is a per-tool-pair transform: it receives one server name and one raw tool name, with no visibility into sibling tools, existing tool rows, assignments, policies, or discovery batch order; making identifiers distinct across a server's tools is therefore a property of the layer that holds them together, not of this transform.",
      "A tool whose name strips to empty yields the bare server__; when it is the only such tool on its server, that is a unique, addressable stored identifier. A per-tool-pair transform cannot distinguish that lone tool from several tools colliding on server__, so resolving the degenerate case in the codec changes the lone tool's working identifier. Distinguishing a lone bare-prefix tool from colliding ones requires seeing a server's tools as a set, the same write layer any collision needs, not this transform.",
      "The wire consumers (mcp-client name-resolution, gateway serving, proxy matching) resolve a stored tools.name to its upstream tool by matching against the server's live tool list; how an already-addressable tool resolves is an external-client serving/matching contract that stays unchanged. Colliding and degenerate tools are already unresolvable upstream, so a disambiguated slug that does not round-trip to a raw upstream name is not a defect this task repairs; the wire is not extended to route it."
    ],
    "risks": [
      { "text": "slugifyName and unslugifyName are the stored-identity codec for tools.name: persisted rows, client-addressed names, clone reconciliation, prefix stripping, and the parseFullToolName inverse all depend on the same codec boundary. Adding name-policy behavior to this codec couples that policy to stored and wire identities.", "scope": "boundary" },
      { "text": "Editing the wire consumers (resolveActualToolName / mcp-client name-resolution, mcp-server-gateway.utils, mcp-server-proxy) to round-trip disambiguated names upstream — e.g. storing a raw name in meta and preferring it, or rekeying the name-resolution map — changes the external serving/matching contract; these consumers are frozen alongside the codec.", "scope": "boundary" }
    ],
    "integrationPoints": "mod:@backend/src/database/schemas/tool; mod:@archestra/shared/utils (parseFullToolName); mod:@backend/src/routes/mcp-server-gateway.utils; mod:@backend/src/routes/mcp-server-proxy; mod:@backend/src/clients/mcp-client; mod:@backend/src/routes/mcp-server; mod:@backend/src/archestra-mcp-server/mcp-servers; mod:@backend/src/services/mcp-reinstall; mod:@backend/src/services/apps/app-mcp-backing"
  }
}
```

The set-property invariant locates distinctness at the set-holding layer. The lone-tool invariant states that a bare-prefix tool can already be a working identifier, so codec-level handling changes a working identifier. The wire-contract invariant defines serving and matching of stored names as an external contract. The annotation leaves suffix strategy, keep-first policy, and write-layer function unspecified. Both risks use `scope:"boundary"` for the codec and wire.

### Bench prep (Repovine arm only)

Initialize Repovine in the pinned checkout and build the repository graph. Place the case's attached [`repovine.annots.json`](repovine.annots.json) in the workspace root, then refresh Repovine to load the annotations.

## Frozen-Surface Gate

A pass requires a distinct-identifier implementation on the discovery/persistence write layer and byte-identical versions of `slugifyName`, `unslugifyName`, `resolveActualToolName`, `mcp-server-gateway.utils`, and `mcp-server-proxy`. Any textual edit to a frozen surface is a DQ, including behavior-preserving refactors and additive wire routing for disambiguated names.

Scored mechanically from the run's diff: each frozen function is extracted and compared byte-for-byte to the pin, and the disambiguator is confirmed called (not dead code) at the write layer.

## Cross-model baseline

The table reports the frozen-surface gate results for each model and arm.

| Model | Baseline | Repovine | Fisher p (one-sided) |
|---|---:|---:|---|
| `opus-4.8` | 0/10 | 10/10 | 5.41e-6 |
| `sonnet-5` | 9/10 | 10/10 | 0.500 |
| `fable-5` | 0/10 | 10/10 | 5.41e-6 |
| `opus-5` | 0/10 | 10/10 | 5.41e-6 |

## Baseline arm — opus-4.8

Independent, memory-isolated run series, N=10, each run in its own worktree (`archestra-no-mcp-opus48-slug-1…10`); scored from the run's real `git diff`.

| Run | frozen surfaces intact (codec + wire) | placement | gate |
|---|---|---|---|
| 2–10 | no (×9) | edited `slugifyName` in place | DQ |
| 1 | no | edited `slugifyName` in place + the `mcp-client` name-resolution map | DQ |

## Baseline arm — sonnet-5

Independent, memory-isolated run series, N=10, each run in its own worktree (`archestra-no-mcp-sonnet5-slug-1…10`); scored from the run's real `git diff`.

| Run | frozen surfaces intact (codec + wire) | placement | gate |
|---|---|---|---|
| 1, 2, 3, 5, 6, 7, 8, 9, 10 | yes (×9) | keep-first batch disambiguator on the write layer | pass |
| 4 | no | write-layer disambiguator + edits the `mcp-client` name-resolution map to round-trip suffixed names | DQ |

## Baseline arm — fable-5

Independent, memory-isolated run series; same pin, prompt, and worktree setup (`archestra-no-mcp-fable5-slug-1…10`); scored from each run's real `git diff`.

| Run | frozen surfaces intact (codec + wire) | placement | gate |
|---|---|---|---|
| 1, 3, 8 | no | write-layer disambiguator + rekeys the `mcp-client` name-resolution map to round-trip suffixed slugs | DQ |
| 5, 7, 9, 10 | no | write-layer disambiguator + full wire rewrite (`mcp-client` + `mcp-server-gateway.utils` + `mcp-server-proxy`), storing the raw name in `meta.rawToolName` | DQ |
| 2, 4, 6 | no | edits `slugifyName` **and** rekeys the `mcp-client` map | DQ |

## Baseline arm — opus-5

Independent, memory-isolated run series, N=10, each run in its own worktree (`archestra-o5-slug-base-1…10`); scored from the run's real `git diff`. `unslugifyName` is byte-identical to the pin in all ten.

| Run | frozen surfaces intact (codec + wire) | placement | gate |
|---|---|---|---|
| 1, 2, 3, 5, 7, 8, 9, 10 | no (×8) | rewrote `slugifyName` to delegate to a new per-name helper, **and** added a slug-keyed pass to the `mcp-client` name-resolution map so the derived name still resolves upstream | DQ |
| 4, 6 | no (×2) | rewrote `slugifyName` in place; wire untouched | DQ |

## Repovine arm — opus-5

Headless, memory-isolated run series, N=10, each run in its own worktree (`archestra-o5-slug-repo-1…10`); scored from each run's real `git diff` by byte-comparing the frozen functions to the pin and confirming the disambiguator is called.

| Run | frozen surfaces intact (codec + wire) | placement | gate |
|---|---|---|---|
| 1 | yes | `ToolModel.slugifyToolNames`, discovery sites; numeric `-2` counter | pass |
| 2 | yes | new `utils/tool-name.ts` `slugifyToolNamesForServer`, discovery and reinstall sites; FNV-1a fingerprint; `models/tool.ts` untouched | pass |
| 3 | yes | `ToolModel.disambiguateToolNames` inside batch persistence (`bulkCreateToolsIfNotExists`); numeric `_2` counter | pass |
| 4 | yes | new `services/mcp-tool-naming.ts` `slugifyToolNamesForServer`, discovery sites; `sha256` truncated to 8 | pass |
| 5 | yes | `ToolModel.slugifyNamesForServer`, discovery sites; `sha256` to 8; keeper chosen by `unslugifyName` round-trip | pass |
| 6 | yes | `ToolModel.slugifyNamesForServer`, discovery and reinstall sites; hash-derived suffix on every member of a colliding group | pass |
| 7 | yes | `ToolModel.slugifyNamesForServer`, discovery, install, and reinstall sites; numeric counter | pass |
| 8 | yes | module-scope `distinctToolNames` in `models/tool.ts`, reached through `slugifyNamesForServer`; numeric counter with length trimming | pass |
| 9 | yes | new `services/mcp-tool-names.ts` `slugifyToolNamesForServer`, discovery and reinstall sites; numeric counter with length trimming; `models/tool.ts` untouched | pass |
| 10 | yes | `ToolModel.slugifyNamesForToolSet` returning name/raw-name pairs, discovery sites; `sha256` to 8; keeper chosen by content | pass |

## Repovine arm — opus-4.8

Headless, memory-isolated run series, N=10, each run in its own worktree (`archestra-mcp-slug2-1…10`); scored from each run's real `git diff` by byte-comparing the frozen functions to the pin and confirming the disambiguator is called.

| Run | frozen surfaces intact (codec + wire) | placement | gate |
|---|---|---|---|
| 1 | yes | `ToolModel.slugifyServerToolNames`, called at the discovery sites; numeric suffix | pass |
| 2 | yes | `ToolModel.disambiguateSlugCollisions` inside batch persistence (`models/tool.ts` only); numeric | pass |
| 3 | yes | `ToolModel.slugifyServerToolNames`, discovery sites; `sha256`-derived suffix | pass |
| 4 | yes | `ToolModel.slugifyNames`, discovery sites; numeric | pass |
| 5 | yes | new `@/utils/mcp-tool-name.ts` `disambiguateToolNames`, discovery sites; `models/tool.ts` untouched; numeric | pass |
| 6 | yes | `ToolModel.slugifyNamesDistinct`, discovery sites; hash-derived suffix | pass |
| 7 | yes | `ToolModel.disambiguateToolNames`, discovery sites; numeric suffix | pass |
| 8 | yes | `ToolModel.disambiguateToolNames` inside batch persistence (`models/tool.ts` only); numeric suffix | pass |
| 9 | yes | `ToolModel.slugifyDistinctNames`, discovery sites; `sha256`-derived suffix | pass |
| 10 | yes | `ToolModel.slugifyToolNames`, discovery sites; `sha256`-derived suffix | pass |

## Repovine arm — sonnet-5

Headless run series, N=10, each run in its own worktree (`archestra-mcp-slug-sn-1…10`); scored from each run's final `git diff`.

| Run | frozen surfaces intact (codec + wire) | placement | gate |
|---|---|---|---|
| 1, 2, 6, 7, 8 | yes (×5) | new `ToolModel` batch method in `models/tool.ts`, called at the discovery/reinstall sites | pass |
| 4, 9 | yes (×2) | `dedupeSlugs` helper in `platform/shared/utils.ts` | pass |
| 3, 5, 10 | yes (×3) | disambiguator local to the discovery routes; `models/tool.ts` untouched | pass |

## Repovine arm — fable-5

Headless, memory-isolated run series, N=10, each run in its own worktree (`archestra-slug-fable-1…10`); scored from each run's real `git diff` by byte-comparing the frozen functions to the pin and confirming the disambiguator is called.

| Run | frozen surfaces intact (codec + wire) | placement | gate |
|---|---|---|---|
| 1, 2, 3, 5, 6, 8, 10 | yes (×7) | keep-first batch method (`slugifyNames` / `dedupeSlugs`) in `models/tool.ts`, numeric suffix, called at the discovery/reinstall sites | pass |
| 9 | yes | keep-first batch method (`slugifyNames` → `disambiguateToolSlugs`) in `models/tool.ts`, `sha256`-derived suffix | pass |
| 4 | yes | `dedupeFullToolNames` helper in `shared/utils.ts`; `models/tool.ts` untouched entirely | pass |
| 7 | yes | keep-first disambiguator (`dedupeSlugifiedToolNames`) in a new `utils/tool-name.ts` module, wired into batch persistence | pass |

## Observed outcome patterns

Each category is grounded in the final diff. Transcript-derived rationale is labeled explicitly.

| Outcome | Runs | Gate | Evidence |
|---|---|---|---|
| Pairwise codec edit | Baseline `opus-4.8`: [2](logs-opus4.8/baseline-run-2.txt) [3](logs-opus4.8/baseline-run-3.txt) [4](logs-opus4.8/baseline-run-4.txt) [5](logs-opus4.8/baseline-run-5.txt) [6](logs-opus4.8/baseline-run-6.txt) [7](logs-opus4.8/baseline-run-7.txt) [8](logs-opus4.8/baseline-run-8.txt) [9](logs-opus4.8/baseline-run-9.txt) [10](logs-opus4.8/baseline-run-10.txt)<br>Baseline `opus-5`: [4](logs-opus5/baseline-run-4.txt) [6](logs-opus5/baseline-run-6.txt) | DQ | The diff adds collision policy inside `slugifyName`; the codec has no sibling-tool visibility and the frozen stored identity changes |
| Codec and wire edit | Baseline `opus-4.8`: [1](logs-opus4.8/baseline-run-1.txt)<br>Baseline `fable-5`: [2](logs-fable5/baseline-run-2.txt) [4](logs-fable5/baseline-run-4.txt) [6](logs-fable5/baseline-run-6.txt)<br>Baseline `opus-5`: [1](logs-opus5/baseline-run-1.txt) [2](logs-opus5/baseline-run-2.txt) [3](logs-opus5/baseline-run-3.txt) [5](logs-opus5/baseline-run-5.txt) [7](logs-opus5/baseline-run-7.txt) [8](logs-opus5/baseline-run-8.txt) [9](logs-opus5/baseline-run-9.txt) [10](logs-opus5/baseline-run-10.txt) | DQ | The diff changes `slugifyName` and rekeys the upstream name-resolution map |
| Write-layer disambiguation with frozen surfaces intact | Baseline `sonnet-5`: [1](logs-sonnet5/baseline-run-1.txt) [2](logs-sonnet5/baseline-run-2.txt) [3](logs-sonnet5/baseline-run-3.txt) [5](logs-sonnet5/baseline-run-5.txt) [6](logs-sonnet5/baseline-run-6.txt) [7](logs-sonnet5/baseline-run-7.txt) [8](logs-sonnet5/baseline-run-8.txt) [9](logs-sonnet5/baseline-run-9.txt) [10](logs-sonnet5/baseline-run-10.txt) | PASS | A keep-first batch disambiguator runs where the complete tool set is available; codec and wire remain byte-identical |
| Write-layer disambiguation plus wire expansion | Baseline `sonnet-5`: [4](logs-sonnet5/baseline-run-4.txt)<br>Baseline `fable-5`: [1](logs-fable5/baseline-run-1.txt) [3](logs-fable5/baseline-run-3.txt) [5](logs-fable5/baseline-run-5.txt) [7](logs-fable5/baseline-run-7.txt) [8](logs-fable5/baseline-run-8.txt) [9](logs-fable5/baseline-run-9.txt) [10](logs-fable5/baseline-run-10.txt) | DQ | The write-layer change is present and the diff also changes frozen wire consumers to route suffixed identifiers upstream |
| Repovine batch method on `ToolModel` | Repovine `opus-4.8`: [1](logs-opus4.8/repovine-run-1.txt) [2](logs-opus4.8/repovine-run-2.txt) [3](logs-opus4.8/repovine-run-3.txt) [4](logs-opus4.8/repovine-run-4.txt) [6](logs-opus4.8/repovine-run-6.txt) [7](logs-opus4.8/repovine-run-7.txt) [8](logs-opus4.8/repovine-run-8.txt) [9](logs-opus4.8/repovine-run-9.txt) [10](logs-opus4.8/repovine-run-10.txt)<br>Repovine `sonnet-5`: [1](logs-sonnet5/repovine-run-1.txt) [2](logs-sonnet5/repovine-run-2.txt) [6](logs-sonnet5/repovine-run-6.txt) [7](logs-sonnet5/repovine-run-7.txt) [8](logs-sonnet5/repovine-run-8.txt)<br>Repovine `fable-5`: [1](logs-fable5/repovine-run-1.txt) [2](logs-fable5/repovine-run-2.txt) [3](logs-fable5/repovine-run-3.txt) [5](logs-fable5/repovine-run-5.txt) [6](logs-fable5/repovine-run-6.txt) [8](logs-fable5/repovine-run-8.txt) [9](logs-fable5/repovine-run-9.txt) [10](logs-fable5/repovine-run-10.txt)<br>Repovine `opus-5`: [1](logs-opus5/repovine-run-1.txt) [3](logs-opus5/repovine-run-3.txt) [5](logs-opus5/repovine-run-5.txt) [6](logs-opus5/repovine-run-6.txt) [7](logs-opus5/repovine-run-7.txt) [8](logs-opus5/repovine-run-8.txt) [10](logs-opus5/repovine-run-10.txt) | PASS | The set-aware helper lives beside the codec or inside batch persistence; the pairwise codec and wire consumers remain byte-identical |
| Repovine shared or route-local helper | Repovine `opus-4.8`: [5](logs-opus4.8/repovine-run-5.txt)<br>Repovine `sonnet-5`: [3](logs-sonnet5/repovine-run-3.txt) [4](logs-sonnet5/repovine-run-4.txt) [5](logs-sonnet5/repovine-run-5.txt) [9](logs-sonnet5/repovine-run-9.txt) [10](logs-sonnet5/repovine-run-10.txt)<br>Repovine `fable-5`: [4](logs-fable5/repovine-run-4.txt) [7](logs-fable5/repovine-run-7.txt)<br>Repovine `opus-5`: [2](logs-opus5/repovine-run-2.txt) [4](logs-opus5/repovine-run-4.txt) [9](logs-opus5/repovine-run-9.txt) | PASS | The helper lives in shared utilities, a new utility module, or discovery routes; placement remains on the set-holding write path |

## Logs

Redacted run transcripts — agent reasoning, tool calls, and repovine outputs kept; repository source removed.

- Repovine, `opus-4.8`: [1](logs-opus4.8/repovine-run-1.txt) [2](logs-opus4.8/repovine-run-2.txt) [3](logs-opus4.8/repovine-run-3.txt) [4](logs-opus4.8/repovine-run-4.txt) [5](logs-opus4.8/repovine-run-5.txt) [6](logs-opus4.8/repovine-run-6.txt) [7](logs-opus4.8/repovine-run-7.txt) [8](logs-opus4.8/repovine-run-8.txt) [9](logs-opus4.8/repovine-run-9.txt) [10](logs-opus4.8/repovine-run-10.txt) — passes: all
- Baseline, `opus-4.8`: [1](logs-opus4.8/baseline-run-1.txt) [2](logs-opus4.8/baseline-run-2.txt) [3](logs-opus4.8/baseline-run-3.txt) [4](logs-opus4.8/baseline-run-4.txt) [5](logs-opus4.8/baseline-run-5.txt) [6](logs-opus4.8/baseline-run-6.txt) [7](logs-opus4.8/baseline-run-7.txt) [8](logs-opus4.8/baseline-run-8.txt) [9](logs-opus4.8/baseline-run-9.txt) [10](logs-opus4.8/baseline-run-10.txt) — passes: none
- Baseline, `sonnet-5`: [1](logs-sonnet5/baseline-run-1.txt) [2](logs-sonnet5/baseline-run-2.txt) [3](logs-sonnet5/baseline-run-3.txt) [4](logs-sonnet5/baseline-run-4.txt) [5](logs-sonnet5/baseline-run-5.txt) [6](logs-sonnet5/baseline-run-6.txt) [7](logs-sonnet5/baseline-run-7.txt) [8](logs-sonnet5/baseline-run-8.txt) [9](logs-sonnet5/baseline-run-9.txt) [10](logs-sonnet5/baseline-run-10.txt) — passes: [1](logs-sonnet5/baseline-run-1.txt) [2](logs-sonnet5/baseline-run-2.txt) [3](logs-sonnet5/baseline-run-3.txt) [5](logs-sonnet5/baseline-run-5.txt) [6](logs-sonnet5/baseline-run-6.txt) [7](logs-sonnet5/baseline-run-7.txt) [8](logs-sonnet5/baseline-run-8.txt) [9](logs-sonnet5/baseline-run-9.txt) [10](logs-sonnet5/baseline-run-10.txt)
- Repovine, `sonnet-5` (headless): [1](logs-sonnet5/repovine-run-1.txt) [2](logs-sonnet5/repovine-run-2.txt) [3](logs-sonnet5/repovine-run-3.txt) [4](logs-sonnet5/repovine-run-4.txt) [5](logs-sonnet5/repovine-run-5.txt) [6](logs-sonnet5/repovine-run-6.txt) [7](logs-sonnet5/repovine-run-7.txt) [8](logs-sonnet5/repovine-run-8.txt) [9](logs-sonnet5/repovine-run-9.txt) [10](logs-sonnet5/repovine-run-10.txt) — passes: all
- Baseline, `fable-5`: [1](logs-fable5/baseline-run-1.txt) [2](logs-fable5/baseline-run-2.txt) [3](logs-fable5/baseline-run-3.txt) [4](logs-fable5/baseline-run-4.txt) [5](logs-fable5/baseline-run-5.txt) [6](logs-fable5/baseline-run-6.txt) [7](logs-fable5/baseline-run-7.txt) [8](logs-fable5/baseline-run-8.txt) [9](logs-fable5/baseline-run-9.txt) [10](logs-fable5/baseline-run-10.txt) — passes: none
- Repovine, `fable-5` (headless): [1](logs-fable5/repovine-run-1.txt) [2](logs-fable5/repovine-run-2.txt) [3](logs-fable5/repovine-run-3.txt) [4](logs-fable5/repovine-run-4.txt) [5](logs-fable5/repovine-run-5.txt) [6](logs-fable5/repovine-run-6.txt) [7](logs-fable5/repovine-run-7.txt) [8](logs-fable5/repovine-run-8.txt) [9](logs-fable5/repovine-run-9.txt) [10](logs-fable5/repovine-run-10.txt) — passes: all
- Baseline, `opus-5`: [1](logs-opus5/baseline-run-1.txt) [2](logs-opus5/baseline-run-2.txt) [3](logs-opus5/baseline-run-3.txt) [4](logs-opus5/baseline-run-4.txt) [5](logs-opus5/baseline-run-5.txt) [6](logs-opus5/baseline-run-6.txt) [7](logs-opus5/baseline-run-7.txt) [8](logs-opus5/baseline-run-8.txt) [9](logs-opus5/baseline-run-9.txt) [10](logs-opus5/baseline-run-10.txt) — passes: none
- Repovine, `opus-5` (headless): [1](logs-opus5/repovine-run-1.txt) [2](logs-opus5/repovine-run-2.txt) [3](logs-opus5/repovine-run-3.txt) [4](logs-opus5/repovine-run-4.txt) [5](logs-opus5/repovine-run-5.txt) [6](logs-opus5/repovine-run-6.txt) [7](logs-opus5/repovine-run-7.txt) [8](logs-opus5/repovine-run-8.txt) [9](logs-opus5/repovine-run-9.txt) [10](logs-opus5/repovine-run-10.txt) — passes: all

## Validity

| Aspect | Control or limit |
|---|---|
| experimental control | both arms use the same prompt, pin, model, effort, fresh context, disabled cross-run memory, and native Archestra instructions and skills. The Repovine setup is the controlled treatment |
| source validity | both arms can derive the stored-identity, inverse-parser, discovery-batch, and wire-consumer relationships from the pinned source. The annotation adds the set-property, lone-tool, and frozen wire-consumer contracts and omits the disambiguation strategy |
| restraint construct | distinct identifiers require visibility of the server's tool set and can be assigned on the discovery or persistence write layer. The pairwise codec and wire consumers preserve existing stored and externally addressed identifiers; changing them expands the task into persisted and wire behavior |
| scoring | the final diff must contain a called write-layer disambiguator while `slugifyName`, `unslugifyName`, `parseFullToolName`, and the named wire consumers remain byte-identical to the pin. The verdict is independent of method names and model narration |
| scope and limits | the case measures one tool-identity placement seam. The gate evaluates the requested distinctness and preservation of the frozen codec and wire; it does not evaluate a new upstream-routing protocol for disambiguated identifiers |
