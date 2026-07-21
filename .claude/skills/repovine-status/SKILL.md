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

If the response is `status:"building"` or `status:"pending"`, the graph is still being built. Report the current stage, `pct`, `donePackages`/`totalPackages`, and `etaSec`, then stop — the calls below need a ready graph and will themselves return a not-ready payload (`status:"building"` or `"pending"`). Recommend the user wait, or pre-build with `repovine build` next time. To abandon the build, call `get_build_status({ "cancel": true })`: it stops Stage 1 workers and returns `cancelled` (no graph) or keeps a prior `ready` graph.

`status:"cancelled"` means a cancel left no graph; tools return a cancelled payload, not an error. Trigger a rebuild with `refresh_context`, or run `repovine build` and restart the server.

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
- overall coverage
- fresh vs stale annotations
- lowest-coverage domains
- queue `needsWork`, staleKind counts, and orphan hints from the response

3. Suggested next steps:
- graph still building: tell the user to wait; for next time recommend `repovine build` (CLI) before enabling MCP
- stale or missing syntax index: ask to use the `repovine-refresh` skill
- low coverage: ask to use the `repovine-annotations` skill with init/onboard
- non-empty annotation queue: ask to use the `repovine-annotations` skill with continue until `needsWork: 0` in scope
- orphaned annotations: offer `refresh_context({ "cleanupOrphans": true })`
