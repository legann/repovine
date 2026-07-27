---
name: repovine-status
description: Show repovine graph, syntax index, and annotation status
---

# repovine-status

Display repovine status across the graph lifecycle, syntax index, and annotations.

## Instructions

1. First, check whether the graph itself is ready:

~~~json
get_build_status({})
~~~

If `result.status` is `"building"` or `"pending"`, the graph is still being built. Call `get_build_status({ "waitSec": 45 })` once to long-poll. If it still returns building, report the current `stage`, `remainingStages`, `pct`, `donePackages`/`totalPackages`, and `stageEtaSec` (current stage only), then stop — the calls below need a ready graph and will themselves return a not-ready payload (`result.status` `"building"` or `"pending"`). Do not infer time until ready from the stage ETA or use ETA thresholds to decide whether to wait. Recommend the user wait, or pre-build with `repovine build` next time. To abandon the build, call `get_build_status({ "cancel": true })`: it stops Stage 1 workers and returns `cancelled` (no graph) or keeps a prior `ready` graph.

`result.status:"cancelled"` means a cancel left no graph. A settled build is not something to wait for, so tools report it as an error carrying the action that recovers: trigger a rebuild with `refresh_context`, or run `repovine build` and restart the server. Only `"building"` and `"pending"` come back unflagged.

If the response is `status:"failed"`, report `errorMessage` and recommend a clean rebuild (e.g. clear `.repovine/.cache` and restart the MCP server).

If the response is `status:"ready"`, continue with annotation health:

~~~json
get_annotation_merge_status({})
validate_annotations({})
get_annotation_status({ "view": "coverage" })
~~~

2. Present:
- graph build state (pending / building / ready / failed / cancelled) with stage and progress when not ready
- whether repovine.annots.json has conflict markers or parse/validation problems
- overall coverage, and `unconfirmable` when a bucket reports it
- fresh vs stale annotations
- lowest-coverage domains
- queue `needsWork`, staleKind counts, and orphan hints from the response

Coverage and the queue count one backlog: `allNodeTypes.needsWork` equals the queue's `needsWork`.
A coverage shortfall with `needsWork: 0` is `unconfirmable` nodes — no freshness question is asked
about them, and no annotation closes them.

3. Suggested next steps:
- graph still building: tell the user to wait; for next time recommend `repovine build` (CLI) before enabling MCP
- stale or missing syntax index: ask to use the `repovine-refresh` skill
- low coverage with `needsWork` above 0: ask to use the `repovine-annotations` skill with init/onboard
- non-empty annotation queue: ask to use the `repovine-annotations` skill with continue until `needsWork: 0` in scope
- orphaned annotations: offer `refresh_context({ "cleanupOrphans": true })`
