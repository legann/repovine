# Correctness — A URL Normalizer Change Strands the Sync Identity (`archestra-ai`)

The web crawler connector derives each document's identity from its normalized URL. That identity is persisted as `kb_documents.source_id` and is the key incremental sync matches on. A task that strengthens URL normalization changes the identity computed for already-crawled pages; connector-sync re-ingests them under new `source_id`s while the old rows persist (there is no prune), so search returns duplicates.

- Repository: `archestra-ai`. Pinned `f34dc474913a85700bebd29f5065800bb79accb3`.
- Model: `opus-4.8` (primary), `sonnet-5`, `fable-5` — N=10 per arm, all three models. Effort **max** on every run. Memory-isolated per run (`autoMemoryEnabled: false`).
- Scoring: correctness gate over the final diff — URL normalization (C1) and reconciliation of existing stored identities (G1).
- Terms (arm, gate, DQ, C1, G1, Frozen): [METHODOLOGY.md](../../METHODOLOGY.md#terms)
- Baseline native context: the repo's own `platform/CLAUDE.md` and the eight `.claude/skills/archestra-dev-*` skills — byte-identical in both arms. Only repovine is withheld; the root `AGENTS.md`/`CLAUDE.md` at the pin are repovine's own bootstrap (archestra has no root ones of its own — repovine created them) and are absent from the baseline arm by design. No native skill documents the connector-sync identity coupling.

This case covers a derived identity stored as `source_id` and read by incremental sync. The URL-normalizer edit site contains no reference to the stored identity or next-sync lookup.

## Evidence from the pinned repository

The pinned source establishes the normalization, identity, storage, sync, search, and reconciliation paths.

| Signal | Evidence |
|---|---|
| The normalized URL becomes the document identity | `web-crawler-connector.ts` — `normalizeCrawlUrl` output flows to `buildDocument`, whose `ConnectorDocument.id` is a sha256 of the canonical URL |
| That identity is persisted as the sync key | `database/schemas/kb-document.ts:19` `source_id`; `:44` the unique index on (connectorId, source_id) |
| Incremental sync matches on it | `knowledge-base/connector-sync.ts` — `KbDocumentModel.findBySourceId` (by connectorId + doc id), compares `contentHash`, upserts |
| The rows are read live by search | `models/kb-chunk.ts:181` — the full-text search predicate on `search_vector`; a document present twice is returned twice |
| Incremental sync does not prune | `connector-sync.ts` has no delete-not-seen pass; `connectors/perforce/perforce-connector.ts:36` — "File deletions are not propagated on incremental syncs" |
| `source_id` reconciliation is a real operation | `migrations/0169_hot_flatman.sql` — deduplicates `kb_documents` by `source_id` |
| URL-normalization changes are a repo pattern | #5402 (trailing slash in base URLs), #2905 (double-slash / trailing slash), #99 (host trailing slash) |

The sync framework (`connector-sync`, `kb-document`) and search path (`kb-chunk`) contain the persistence and read relationships. The `normalizeCrawlUrl` edit site contains the URL transformation. Both arms can reach every path in the pinned source.

## The seam

```
edit site   normalizeCrawlUrl          web-crawler-connector.ts   the URL normalizer the task strengthens
identity    doc.id via buildDocument    web-crawler-connector.ts (buildDocument)   sha256 of the normalized URL
store       kb_documents.source_id     schemas/kb-document.ts:19,44   persisted, unique per connector
match       findBySourceId (by connectorId + source_id)  connector-sync.ts   incremental upsert key; no prune
read        search_vector @@ tsquery   models/kb-chunk.ts:181   a doc under two source_ids is returned twice
exemplar    dedup kb_documents by source_id  migrations/0169_hot_flatman.sql   prior source_id reconciliation
```

`normalizeCrawlUrl` is the single normalization chokepoint (start URL, discovered links, and the `<link rel="canonical">` path all route through it). Its output is the document's stable identity, persisted as `source_id`. Strengthening the normalizer — stripping tracking params, canonicalizing hosts — changes that identity for pages already crawled under the old scheme. On the next sync `findBySourceId` misses, the page is ingested as a new `kb_documents` row, its chunks are indexed, and the original row is left in place because incremental sync never prunes. Search (`search_vector @@ tsquery`) then returns both. The edit site is a URL utility; that its output is the persisted sync identity lives in `connector-sync`.

## Surfaces

| Surface | Type | Rule |
|---|---|---|
| `normalizeCrawlUrl` URL normalization | Target (C1) | the normalization change belongs here |
| reconcile existing `kb_documents.source_id` | Scoring gate (G1) | re-normalize stored `source_id`s, or otherwise stop the next sync from re-ingesting already-crawled pages |
| `connector-sync` identity/upsert, `kb-document` schema, `kb-chunk` search | Frozen / read owners | the sync-identity contract and the live reader; queried, not edited |
| trailing-slash normalization (blocked by the frozen tests / scope heuristic) | Out of scope | the crawler tests pin trailing slashes; changing them breaks tests and crawl scope |
| retrieval routes, embeddings, connector auth | Out of scope | not the normalization task |

The score is the identity-reconciliation gate above, counted from the diff. C1 records whether the URL normalization is strengthened; G1 records whether the run reconciles the stored `source_id` identity for already-ingested rows.

## Task prompt (identical for both arms)

```text
Implementation task. Modify files as needed.

Task:
Improve the web crawler knowledge connector's URL normalization. Today the
crawler's URL normalization is minimal, so trivially-different URLs that point
at the same page are treated as different pages. Strengthen the normalization in
platform/backend/src/knowledge-base/connectors/web-crawler/web-crawler-connector.ts
so that such URLs canonicalize to one:
- strip common tracking query parameters (e.g. utm_source, utm_medium,
  utm_campaign, utm_term, utm_content, gclid, fbclid),
- remove a trailing slash on non-root paths,
- lowercase the host,
- (keep the existing default-port stripping).

Every document already indexed by this connector must continue to be served
correctly after this change.

Constraints:
- Change implementation only; do not add or modify tests.
- Follow the repo's existing conventions.

Deliverables:
1. Implement the patch.
2. Report which files you changed and why. Note any related code paths you
   deliberately left unchanged, each with the specific source (file:line) that
   proves it is out of scope.
3. Concise summary of the changed behavior, files touched at a high level, and
   any residual risk.
```

The prompt specifies URL normalization and continued service for already indexed documents. It omits `source_id`, sync identity, `kb_documents`, duplication, migration, and backward reconciliation details. "Canonicalize to one" establishes forward deduplication for new crawls.

## Annotation (Repovine arm)

Committed with this case: [`repovine.annots.json`](repovine.annots.json) — the delivered edit-site annotation, verbatim.

An additive note on the `web-crawler-connector` module is delivered at the edit-site node. It states the identity, persistence, and no-prune contract, frames the duplication as present from the first sync rather than a deferred exposure, and cites the in-repo precedent for this class of re-key. The risk uses `scope:"consumer"`, which routes the obligation through the correctness pull channel and `inspect_node` attention. The migration/backfill vehicle and `source_id` recipe for this task remain unspecified.

```json
{
  "mod:@backend/src/knowledge-base/connectors/web-crawler/web-crawler-connector": {
    "summary": "Web crawler knowledge connector. normalizeCrawlUrl is the single chokepoint that canonicalizes each crawled/discovered/canonical URL; the normalized URL is what buildDocument turns into the document's identity and sourceUrl.",
    "invariants": [
      "The normalized crawl URL is the crawler document's stable identity: buildDocument derives the document id from it, and connector-sync persists that value as kb_documents.source_id (unique per connector).",
      "Incremental sync matches an existing document by (connectorId, source_id) via KbDocumentModel.findBySourceId; a document whose source_id is not found is ingested as a new row, and its chunks — which carry the live search_vector the retrieval path queries — are indexed.",
      "connector-sync has no prune step: a document previously stored under a source_id that is no longer produced is not removed (the perforce connector notes 'deletions are not propagated on incremental syncs'). A source_id that changes value leaves the old row in place while a new row is created.",
      "kb search reads the chunks of every kb_documents row (search_vector @@ tsquery); a page present under two source_ids is returned twice.",
      "kb_documents.source_id is written once at ingest and is never re-derived afterward — no migration or background job re-normalizes it when the derivation changes, so a changed normalizer and the stored identities diverge permanently until they are re-keyed.",
      "This repository has reconciled this exact class of mismatch before: migration 0131_fix_agent_tool_trailing_underscores re-keyed stored tool names in code after a slugify change diverged from the persisted values — a SQL/TS normalization mismatch of the same shape as this one. Bringing the stored source_ids into line runs along that same established in-repo data-migration path."
    ],
    "risks": [
      {
        "text": "normalizeCrawlUrl and the stored identities it has already produced are one contract: kb_documents.source_id is the persisted form of this normalization, written once and never re-derived, and connector-sync has no prune. A change to the normalization is therefore incomplete until the existing source_ids are brought into line. This is not a deferred exposure: with no prune, the first sync after the change already inserts the duplicate and search already returns both the new and the stale row — the stored identities are out of line with the normalizer from that first sync onward, not at some later maintenance point.",
        "scope": "consumer"
      }
    ],
    "sideEffects": [{ "kind": "io-read", "subtype": "network", "description": "Crawls external web pages and yields documents for the knowledge-base sync pipeline." }]
  }
}
```

Leak-guard audit: the annotation states the coupling and reconciliation obligation as system facts, and cites `0131_fix_agent_tool_trailing_underscores` as the in-repo precedent for this class of normalization/stored-key mismatch — institutional history a maintainer carries, not a recipe for this task. The web-crawler implementation — which migration or backfill, its shape, the re-normalization SQL — is omitted; the run derives it. That the annotation carries no recipe is shown by the passing diffs, not asserted: the reconciling runs use divergent, self-derived vehicles — boot-time `seed.ts` backfills and SQL migrations across seven distinct names and forms (CTE, PL/pgSQL, temp-table) — and `opus-4.8` reconciles through `seed.ts` in four of its seven passes rather than the data migration the precedent names. No single recipe produces that spread. The invariants identify the seam by file and symbol.

### Bench prep (Repovine arm only)

Initialize Repovine in the pinned checkout and build the repository graph. Place the case's attached [`repovine.annots.json`](repovine.annots.json) in the workspace root, then refresh Repovine to load the annotations.

## Gate

A correctness case separates C1 (the required change both arms implement) from G1 (the discriminating gate).

| Label | Predicate | DQ |
|---|---|---|
| C1 | the run strengthens `normalizeCrawlUrl` (at minimum, strips the tracking params — the change that alters existing identities) | normalization not changed |
| G1 | the run also reconciles the stored `kb_documents.source_id` for already-ingested crawler rows (a migration / backfill re-normalizing existing `source_id`s, or an equivalent that prevents the next sync from re-ingesting them) | the normalizer changes without any `source_id` reconciliation → next sync duplicates and orphans existing rows |

**G1 is scored from the diff.** Gate evidence is a `kb_documents.source_id` reconciliation for existing rows alongside the normalizer edit: a migration `UPDATE`, backfill, or guarded transition. A normalizer-only change causes the next sync to ingest affected pages under new identities while the old rows remain searchable.

## Per-run facts

The URL-normalization change (C1) is expected in every run, both arms. G1 passes when the run reconciles the stored `source_id` identity for already-ingested rows.

| Model | Baseline C1 | Baseline G1 | Repovine C1 | Repovine G1 |
|---|---:|---:|---:|---:|
| `sonnet-5` | 10/10 | 0/10 | 8/10 | 7/10 |
| `opus-4.8` | 8/10 | 0/10 | 9/10 | 7/10 |
| `fable-5` | 10/10 | 0/10 | 10/10 | 10/10 |

The tables below record the scored facts and implementation path for each run. Statistical comparisons appear in [Result](#result).

### Baseline arm — opus-4.8, N=10

Memory-isolated, each run in its own worktree (`archestra-wc-nomcp-opus-1…10`); scored from each worktree's real `git diff`, tracked and untracked files.

| Run | normalization (C1) | source_id reconciled (G1) | gate | path (from the diff) |
|---|---|---|---|---|
| 1, 2, 3, 5, 6, 7, 9, 10 | ✓ (×8) | ✗ (×8) | DQ (×8) | one changed file, `web-crawler-connector.ts` — strips utm_*/gclid/fbclid and lowercases the host. No run's diff adds a migration, a `standalone-scripts` backfill, or any `kb_documents` / `source_id` write |
| 4, 8 | ✗ (×2) | — | DQ (×2) | **C1 absent**: `normalizeCrawlUrl` left untouched ("I did *not* rewrite `normalizeCrawlUrl`'s output" / "I deliberately did NOT rewrite the URL the crawler requests and stores"); tracking-param strip moved to a new `buildRequestDedupeKey`/`canonicalizeCrawlUrl`, wired only into Crawlee's in-crawl `uniqueKey` |

### Baseline arm — sonnet-5, N=10

Memory-isolated, each run in its own worktree (`archestra-wc-nomcp-sonnet-1…10`); scored from each worktree's real `git diff`.

| Run | normalization (C1) | source_id reconciled (G1) | gate | path (from the diff) |
|---|---|---|---|---|
| 1–10 | ✓ (×10) | ✗ (×10) | DQ (×10) | one changed file, `web-crawler-connector.ts` — strips utm_*/gclid/fbclid, lowercases host, most add trailing-slash handling. No run's diff touches `kb_documents`, `source_id`, a migration, or a `standalone-scripts` backfill |

### Baseline arm — fable-5, N=10

Memory-isolated, each run in its own worktree (`archestra-wc-nomcp-fable-1…10`); scored from each worktree's real `git diff`, tracked and untracked files.

| Run | normalization (C1) | source_id reconciled (G1) | gate | path (from the diff) |
|---|---|---|---|---|
| 1–10 | ✓ (×10) | ✗ (×10) | DQ (×10) | one changed file, `web-crawler-connector.ts` (+41…+66 lines) — strips utm_*/gclid/fbclid, lowercases the host, trims the trailing slash. No run's diff adds a migration, a backfill, or any `kb_documents` / `source_id` write |

### Repovine arm — sonnet-5, N=10

Memory-isolated, each run in its own worktree (`archestra-wc-mcp-sonnet-1…10`); scored from each worktree's real `git diff`.

| Run | C1 | G1 | path (from the diff) |
|---|---|---|---|
| 1 | ✓ | ✗ DQ | normalizer only; reconciliation of existing rows recorded as a follow-up |
| 2 | ✗ | ✗ DQ | C1 absent: the tracking-param strip is placed in a crawl dedup key; `normalizeCrawlUrl` and the stored identity are unchanged, so no reconciliation is due |
| 3 | ✓ | ✓ **PASS** | `0313_recanonicalize_web_crawler_source_ids.sql` (150 L) — CTE re-key of existing `source_id`/`source_url`; collision survivor by `updated_at` |
| 4 | ✓ | ✓ **PASS** | `0313_rekey_web_crawler_source_ids.sql` (117 L) — CTE re-key of `source_id`/`source_url`, duplicates dropped |
| 5 | ✓ | ✓ **PASS** | `0313_rekey_web_crawler_source_ids.sql` (121 L) — CTE re-key; touches only rows still holding the original derivation |
| 6 | ✗ | ✗ DQ | C1 absent: strip added to a crawl dedup key only; `normalizeCrawlUrl` byte-identical, stored identity untouched |
| 7 | ✓ | ✓ **PASS** | `0313_rekey_web_crawler_source_ids.sql` (85 L) — CTE re-key of `source_id` |
| 8 | ✓ | ✓ **PASS** | `0313_fix_web_crawler_source_id_normalization.sql` (162 L) — re-keys existing `source_id` for `web_crawler` rows through the new normalization |
| 9 | ✓ | ✓ **PASS** | `0313_rekey_web_crawler_source_ids.sql` (108 L) — CTE re-key of `source_id`/`source_url` |
| 10 | ✓ | ✓ **PASS** | `0313_rekey_web_crawler_source_ids.sql` (123 L) — CTE re-key; collision survivor by `updated_at` |

### Repovine arm — opus-4.8, N=10

Memory-isolated, each run in its own worktree (`archestra-wc-mcp-opus-1…10`); scored from each worktree's real `git diff`, tracked and untracked files.

| Run | C1 | G1 | reconciliation artifact (from the diff) |
|---|---|---|---|
| 1 | ✓ | ✓ **PASS** | `seed.ts` boot-time backfill — re-derives `source_id`/`source_url` for existing `web_crawler` rows through the normalizer, deduping collisions to the freshest row (scored from the transcript; worktree not retained) |
| 2 | ✗ | ✗ DQ | C1 absent: the tracking-param strip is placed in a crawl dedup key; `normalizeCrawlUrl` and the stored identity are unchanged |
| 3 | ✓ | ✓ **PASS** | `seed.ts` + `kb-document` model backfill re-keying existing `source_id` rows (scored from the transcript; worktree not retained) |
| 4 | ✓ | ✓ **PASS** | `seed.ts` boot-time backfill (+107) — scans all `web_crawler` documents, re-keys and dedups in one transaction |
| 5 | ✓ | ✗ DQ | normalizer only; existing rows left to reconcile on a follow-up |
| 6 | ✓ | ✓ **PASS** | `0313_recanonicalize_web_crawler_source_ids.sql` (101 L) — CTE re-key of existing `source_id`/`source_url` |
| 7 | ✓ | ✗ DQ | normalizer only; reconciliation deferred |
| 8 | ✓ | ✓ **PASS** | `seed.ts` boot-time backfill (+118) — re-keys existing `web_crawler` rows through the normalizer, chunks cascade |
| 9 | ✓ | ✓ **PASS** | `0313_recanonicalize_web_crawler_source_ids.sql` (113 L) — CTE re-key of `source_id`/`source_url` |
| 10 | ✓ | ✓ **PASS** | `0313_normalize_web_crawler_tracking_params.sql` (109 L) — re-keys existing `source_id` for affected rows |

### Repovine arm — fable-5, N=10

Memory-isolated, each run in its own worktree (`archestra-wc-mcp-fable-1…10`); scored from each worktree's real `git diff`, tracked and untracked files.

| Run | C1 | G1 | reconciliation artifact (from the diff) |
|---|---|---|---|
| 1 | ✓ | ✓ **PASS** | `0313_renormalize_web_crawler_source_ids.sql` (133 L) — CTE re-key of existing `source_id`/`source_url` |
| 2 | ✓ | ✓ **PASS** | `0313_rekey_web_crawler_source_ids.sql` (96 L) — CTE re-key; duplicates dropped |
| 3 | ✓ | ✓ **PASS** | `0313_rekey_web_crawler_document_source_ids.sql` (127 L) — CTE re-key of existing `kb_documents.source_id` |
| 4 | ✓ | ✓ **PASS** | `0313_rekey_web_crawler_source_ids.sql` (167 L) — PL/pgSQL block; deletes duplicates then re-keys so a row moving onto a vacated key cannot trip the `(connector_id, source_id)` unique index mid-statement |
| 5 | ✓ | ✓ **PASS** | `0313_web_crawler_url_normalization.sql` (133 L) — CTE re-key over `connector_type = 'web_crawler'` rows |
| 6 | ✓ | ✓ **PASS** | `0313_rekey_web_crawler_source_ids.sql` (121 L) — CTE re-key; collision survivor by `updated_at` |
| 7 | ✓ | ✓ **PASS** | `0313_web_crawler_url_normalization.sql` (122 L) — `UPDATE kb_documents` for `web_crawler` rows; deletes stale duplicates, keeps the freshest |
| 8 | ✓ | ✓ **PASS** | `0313_renormalize_web_crawler_source_ids.sql` (140 L) — CTE re-key of `source_id`/`source_url` |
| 9 | ✓ | ✓ **PASS** | `0313_rekey_web_crawler_document_source_ids.sql` (152 L) — CTE re-key; dedupes collapsing identities |
| 10 | ✓ | ✓ **PASS** | `0313_rekey_web_crawler_source_ids.sql` (144 L) — CTE re-key; keeps the most-recently-updated row, chunks cascade |

## Observed outcome patterns

Each category is grounded in the final diff. Transcript-derived rationale is labeled explicitly.

| Outcome | Runs | Gate | Evidence |
|---|---|---|---|
| Baseline normalizer-only change | Baseline `opus-4.8`: [1](logs-opus4.8/baseline-run-1.txt) [2](logs-opus4.8/baseline-run-2.txt) [3](logs-opus4.8/baseline-run-3.txt) [5](logs-opus4.8/baseline-run-5.txt) [6](logs-opus4.8/baseline-run-6.txt) [7](logs-opus4.8/baseline-run-7.txt) [9](logs-opus4.8/baseline-run-9.txt) [10](logs-opus4.8/baseline-run-10.txt)<br>Baseline `sonnet-5`: [1](logs-sonnet5/baseline-run-1.txt) [2](logs-sonnet5/baseline-run-2.txt) [3](logs-sonnet5/baseline-run-3.txt) [4](logs-sonnet5/baseline-run-4.txt) [5](logs-sonnet5/baseline-run-5.txt) [6](logs-sonnet5/baseline-run-6.txt) [7](logs-sonnet5/baseline-run-7.txt) [8](logs-sonnet5/baseline-run-8.txt) [9](logs-sonnet5/baseline-run-9.txt) [10](logs-sonnet5/baseline-run-10.txt)<br>Baseline `fable-5`: [1](logs-fable5/baseline-run-1.txt) [2](logs-fable5/baseline-run-2.txt) [3](logs-fable5/baseline-run-3.txt) [4](logs-fable5/baseline-run-4.txt) [5](logs-fable5/baseline-run-5.txt) [6](logs-fable5/baseline-run-6.txt) [7](logs-fable5/baseline-run-7.txt) [8](logs-fable5/baseline-run-8.txt) [9](logs-fable5/baseline-run-9.txt) [10](logs-fable5/baseline-run-10.txt) | DQ | C1 changes the persisted identity derivation; the diff contains no reconciliation for existing `source_id` values |
| C1 absent; crawl-frontier dedup only | Baseline `opus-4.8`: [4](logs-opus4.8/baseline-run-4.txt) [8](logs-opus4.8/baseline-run-8.txt)<br>Repovine `opus-4.8`: [2](logs-opus4.8/repovine-run-2.txt)<br>Repovine `sonnet-5`: [2](logs-sonnet5/repovine-run-2.txt) [6](logs-sonnet5/repovine-run-6.txt) | DQ | The persisted-identity normalizer stays unchanged; tracking parameters are handled only in the in-crawl dedup key |
| SQL migration re-key | Repovine `opus-4.8`: [6](logs-opus4.8/repovine-run-6.txt) [9](logs-opus4.8/repovine-run-9.txt) [10](logs-opus4.8/repovine-run-10.txt)<br>Repovine `sonnet-5`: [3](logs-sonnet5/repovine-run-3.txt) [4](logs-sonnet5/repovine-run-4.txt) [5](logs-sonnet5/repovine-run-5.txt) [7](logs-sonnet5/repovine-run-7.txt) [8](logs-sonnet5/repovine-run-8.txt) [9](logs-sonnet5/repovine-run-9.txt) [10](logs-sonnet5/repovine-run-10.txt)<br>Repovine `fable-5`: [1](logs-fable5/repovine-run-1.txt) [2](logs-fable5/repovine-run-2.txt) [3](logs-fable5/repovine-run-3.txt) [4](logs-fable5/repovine-run-4.txt) [5](logs-fable5/repovine-run-5.txt) [6](logs-fable5/repovine-run-6.txt) [7](logs-fable5/repovine-run-7.txt) [8](logs-fable5/repovine-run-8.txt) [9](logs-fable5/repovine-run-9.txt) [10](logs-fable5/repovine-run-10.txt) | PASS | The migration re-keys existing `source_id` values and resolves collisions |
| Boot-time backfill through the live normalizer | Repovine `opus-4.8`: [1](logs-opus4.8/repovine-run-1.txt) [3](logs-opus4.8/repovine-run-3.txt) [4](logs-opus4.8/repovine-run-4.txt) [8](logs-opus4.8/repovine-run-8.txt) | PASS | A `seed.ts` boot pass re-derives stored identities through the exported normalizer and dedups collisions |
| Reconciliation deferred | Repovine `opus-4.8`: [5](logs-opus4.8/repovine-run-5.txt) [7](logs-opus4.8/repovine-run-7.txt)<br>Repovine `sonnet-5`: [1](logs-sonnet5/repovine-run-1.txt) | DQ | Final diff: normalizer only; existing rows left to reconcile on a follow-up |


## Result

The table reports the gate results for each model and arm.

| Arm / model | source_id reconciled (G1) | normalization (C1) | Fisher p (one-sided) |
|---|---|---|---|
| Baseline, `opus-4.8` | 0/10 | 8/10 | |
| Repovine, `opus-4.8` | **7/10** | 9/10 | **p=1.55e-3** |
| Baseline, `sonnet-5` | 0/10 | 10/10 | |
| Repovine, `sonnet-5` | **7/10** | 8/10 | **p=1.55e-3** |
| Baseline, `fable-5` | 0/10 | 10/10 | |
| Repovine, `fable-5` | **10/10** | 10/10 | **p=5.41e-6** |



## Logs

Redacted run transcripts — agent reasoning, tool calls, and repovine outputs kept; repository source removed.

- Baseline, `sonnet-5`: [1](logs-sonnet5/baseline-run-1.txt) [2](logs-sonnet5/baseline-run-2.txt) [3](logs-sonnet5/baseline-run-3.txt) [4](logs-sonnet5/baseline-run-4.txt) [5](logs-sonnet5/baseline-run-5.txt) [6](logs-sonnet5/baseline-run-6.txt) [7](logs-sonnet5/baseline-run-7.txt) [8](logs-sonnet5/baseline-run-8.txt) [9](logs-sonnet5/baseline-run-9.txt) [10](logs-sonnet5/baseline-run-10.txt) — passes: none
- Repovine, `sonnet-5`: [1](logs-sonnet5/repovine-run-1.txt) [2](logs-sonnet5/repovine-run-2.txt) [3](logs-sonnet5/repovine-run-3.txt) [4](logs-sonnet5/repovine-run-4.txt) [5](logs-sonnet5/repovine-run-5.txt) [6](logs-sonnet5/repovine-run-6.txt) [7](logs-sonnet5/repovine-run-7.txt) [8](logs-sonnet5/repovine-run-8.txt) [9](logs-sonnet5/repovine-run-9.txt) [10](logs-sonnet5/repovine-run-10.txt) — passes: [3](logs-sonnet5/repovine-run-3.txt) [4](logs-sonnet5/repovine-run-4.txt) [5](logs-sonnet5/repovine-run-5.txt) [7](logs-sonnet5/repovine-run-7.txt) [8](logs-sonnet5/repovine-run-8.txt) [9](logs-sonnet5/repovine-run-9.txt) [10](logs-sonnet5/repovine-run-10.txt)
- Baseline, `opus-4.8`: [1](logs-opus4.8/baseline-run-1.txt) [2](logs-opus4.8/baseline-run-2.txt) [3](logs-opus4.8/baseline-run-3.txt) [4](logs-opus4.8/baseline-run-4.txt) [5](logs-opus4.8/baseline-run-5.txt) [6](logs-opus4.8/baseline-run-6.txt) [7](logs-opus4.8/baseline-run-7.txt) [8](logs-opus4.8/baseline-run-8.txt) [9](logs-opus4.8/baseline-run-9.txt) [10](logs-opus4.8/baseline-run-10.txt) — passes: none
- Repovine, `opus-4.8`: [1](logs-opus4.8/repovine-run-1.txt) [2](logs-opus4.8/repovine-run-2.txt) [3](logs-opus4.8/repovine-run-3.txt) [4](logs-opus4.8/repovine-run-4.txt) [5](logs-opus4.8/repovine-run-5.txt) [6](logs-opus4.8/repovine-run-6.txt) [7](logs-opus4.8/repovine-run-7.txt) [8](logs-opus4.8/repovine-run-8.txt) [9](logs-opus4.8/repovine-run-9.txt) [10](logs-opus4.8/repovine-run-10.txt) — passes: [1](logs-opus4.8/repovine-run-1.txt) [3](logs-opus4.8/repovine-run-3.txt) [4](logs-opus4.8/repovine-run-4.txt) [6](logs-opus4.8/repovine-run-6.txt) [8](logs-opus4.8/repovine-run-8.txt) [9](logs-opus4.8/repovine-run-9.txt) [10](logs-opus4.8/repovine-run-10.txt)
- Baseline, `fable-5`: [1](logs-fable5/baseline-run-1.txt) [2](logs-fable5/baseline-run-2.txt) [3](logs-fable5/baseline-run-3.txt) [4](logs-fable5/baseline-run-4.txt) [5](logs-fable5/baseline-run-5.txt) [6](logs-fable5/baseline-run-6.txt) [7](logs-fable5/baseline-run-7.txt) [8](logs-fable5/baseline-run-8.txt) [9](logs-fable5/baseline-run-9.txt) [10](logs-fable5/baseline-run-10.txt) — passes: none
- Repovine, `fable-5`: [1](logs-fable5/repovine-run-1.txt) [2](logs-fable5/repovine-run-2.txt) [3](logs-fable5/repovine-run-3.txt) [4](logs-fable5/repovine-run-4.txt) [5](logs-fable5/repovine-run-5.txt) [6](logs-fable5/repovine-run-6.txt) [7](logs-fable5/repovine-run-7.txt) [8](logs-fable5/repovine-run-8.txt) [9](logs-fable5/repovine-run-9.txt) [10](logs-fable5/repovine-run-10.txt) — passes: all

## Validity

| Aspect | Control or limit |
|---|---|
| experimental control | both arms use the same prompt, pin, model, effort, fresh context, disabled cross-run memory, and native Archestra instructions and skills. The baseline contains no Repovine artifacts; the Repovine setup is the controlled treatment |
| source validity | both arms can derive the full change from the pinned source: `normalizeCrawlUrl` feeds the stored `source_id`, incremental sync matches that identity without pruning stale rows, search reads every stored row, and repository migrations and backfill scripts provide reconciliation precedents. The DB rule permits authoring a migration and requires approval before running data-modifying SQL |
| correctness construct | changing the normalizer changes the identity produced for future syncs. Existing rows retain the previous identity, so a normalizer-only change creates a second searchable row on the next sync. The annotation states this coupling and cites the in-repo re-key precedent, while omitting the reconciliation vehicle and recipe for this task |
| scoring | the final diff must contain C1 and reconcile existing `kb_documents.source_id` values through a migration, backfill, guarded transition, or equivalent. Model narration and the selected vehicle do not determine the verdict |
| annotation leak-guard | the annotation delivers three facts — the identity/no-prune coupling, the first-sync timing of the duplication, and the `0131` re-key precedent — and names no vehicle, migration, SQL, or collision strategy for this task. Confirmation is empirical, not asserted: the reconciling runs derive divergent, self-authored vehicles (`seed.ts` backfills and SQL migrations across seven names and three SQL forms), and `opus-4.8` reconciles through `seed.ts` in four of its seven passes rather than the data migration the precedent names — a spread no single recipe produces |
| scope and limits | the case measures one web-crawler sync-identity seam. G1 covers `source_id` reconciliation; it does not score normalization drift between TypeScript and SQL or follow-up consistency of `source_url` and `metadata.url`. The redacted logs omit the injected system prompt, so instruction-file loading is observable only indirectly through agent behavior |
