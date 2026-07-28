---
name: repovine-refresh
description: Refresh the repovine graph and syntax index after code changes
---

# repovine-refresh

Refresh the repovine syntax index after code changes, or build it the first time for this repository.

The syntax index covers files, modules, imports, exports, entrypoints, config names, and resource surfaces.

## Instructions

First, confirm the MCP graph is ready:

~~~json
get_build_status({})
~~~

If `result.status` is `"building"` or `"pending"`, do not call `refresh_context` — the graph is already being built. Call `get_build_status({ "waitSec": 45 })` once to long-poll. If it still returns building, report `stage`, `remainingStages`, `pct`, `donePackages`/`totalPackages`, and `stageEtaSec` (current stage only), then stop. Do not infer time until ready from the stage ETA or use ETA thresholds to decide whether to wait.

If `status:"ready"`, call `refresh_context`:

~~~json
refresh_context({})
~~~

If you changed `repovine.config.json`, reload the MCP runtime config while refreshing:

~~~json
refresh_context({ "reloadConfig": true })
~~~

Changing `repovine.domains.json` is picked up by a normal refresh; using `reloadConfig: true` is harmless when both files changed.

Report:
- nodes/edges before and after
- `searchTokens` (token + annotation index size), and `semanticSearch.status`, which reports `disabled` while `semantic_search_embeddings` is off
- whether config was reloaded, when requested
- `domainsSuggestions.count` (and `declinedHidden`) — follow up per Domains suggestions below
- whether orphaned annotations were detected
- if orphans exist, offer cleanup with `refresh_context({ "cleanupOrphans": true })` (scope with `orphanNodeType`, default all)

## Domains suggestions

When `refresh_context` returns `domainsSuggestions.count > 0`, the domains advisor found resources or packages worth a domain/exclude decision. Never auto-apply:

1. Call `suggest_domains_config({})` (read-only): it returns the additions, a `mergedConfig` preview (accept = exclude), and a `keepConfig` preview when keepable (keep = committed `infra.keep` marker).
2. Show the diff to the user and get approval.
3. On approval, write the chosen preview to `repovine.domains.json`, then `refresh_context({})` to pick it up.
4. To dismiss instead, call `decline_advisory({ "kind": "domains-config", "ids": ["suggestion-id"] })` (or `"all": true`); declined ids persist in `.repovine/onboarding-state.json` and stop resurfacing.

## When to use

- After `repovine setup --no-build`, or a setup that ran without building
- After creating, deleting, or moving files
- After changing `repovine.config.json` or `repovine.domains.json`
- After significant refactoring
- When MCP results seem stale
- Before handing work to another agent

## Large repositories

If the first MCP call on a large repo returns `result.status:"building"`, wait with one long-poll call — `get_build_status({ "waitSec": 45 })` returns the moment the build settles — instead of polling. If it still returns building, report the current stage and remaining stage count; `stageEtaSec` covers only the current stage. Tell the user they can pre-build the graph synchronously with the CLI: `repovine build`, or just re-run `repovine setup` (it builds by default). This warms the snapshot cache so MCP startup is near-instant on subsequent sessions.

To abandon a cold build, call `get_build_status({ "cancel": true })`. On the pooled Stage 1 path every worker thread is asked to shut down and force-terminated after a few seconds' grace; the inline path has no worker threads and observes the abort at its next package or shard boundary. The partial Stage 1 result is not served. With no prior graph the server ends in `result.status:"cancelled"` (bare tree) and tools report it as an error with a recovery action; a later `refresh_context` starts a fresh build. With a prior `ready` graph, cancel keeps serving it.
