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

If `status:"building"` or `"pending"`, do not call `refresh_context` — the graph is already being built. Report the current stage / ETA from the response and ask the user to wait.

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
- `searchTokens` (token + annotation index size), and `semanticSearch.status` when embeddings are enabled
- whether config was reloaded, when requested
- `domainsSuggestions.count` (and `declinedHidden`) — follow up per Domains suggestions below
- whether orphaned annotations were detected
- if orphans exist, offer cleanup with `refresh_context({ "cleanupOrphans": true })` (scope with `orphanNodeType`, default all)

## Domains suggestions

When `refresh_context` returns `domainsSuggestions.count > 0`, the domains advisor found resources or packages worth a domain/exclude decision. Never auto-apply:

1. Call `suggest_domains_config({})` (read-only): it returns the additions, a `mergedConfig` preview (accept = exclude), and a `keepConfig` preview when keepable (keep = committed `infra.keep` marker).
2. Show the diff to the user and get approval.
3. On approval, write the chosen preview to `repovine.domains.json`, then `refresh_context({})` to pick it up.
4. To dismiss instead, call `decline_advisory({ "kind": "domains-config", "ids": [...] })` (or `"all": true`); declined ids persist in `.repovine/onboarding-state.json` and stop resurfacing.

## When to use

- After `repovine setup --no-build`, or a setup that ran without building
- After creating, deleting, or moving files
- After changing `repovine.config.json` or `repovine.domains.json`
- After significant refactoring
- When MCP results seem stale
- Before handing work to another agent

## Large repositories

If the first MCP call on a large repo returns `status:"building"`, wait with one long-poll call — `get_build_status({ "waitSec": 45 })` returns the moment the build settles — instead of polling. On a large ETA, tell the user they can pre-build the graph synchronously with the CLI: `repovine build`, or just re-run `repovine setup` (it builds by default). This warms the snapshot cache so MCP startup is near-instant on subsequent sessions.

To abandon a cold build, call `get_build_status({ "cancel": true })`. It terminates Stage 1 worker threads at the next package boundary. With no prior graph the server ends in `status:"cancelled"` (bare tree) and tools return a cancelled payload; a later `refresh_context` starts a fresh build. With a prior `ready` graph, cancel keeps serving it.
