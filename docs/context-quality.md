# repovine Context Session Quality

Context Session Quality is a deterministic score for the repovine MCP context an
agent collected before handoff. It scores repovine tool responses, not the
agent's prose.

## Workflow

1. The main agent or harness creates a stable id, for example
   `sess-run-2026-06-01-a`.
2. Pass that id on repovine MCP calls as `contextSessionId`:

   ```json
   search_context({
     "query": "audit trail route authz",
     "types": ["package", "module"],
     "limit": 10,
     "contextSessionId": "sess-run-2026-06-01-a"
   })
   ```

   Normal context tools accept **only** `contextSessionId` (no `sessionId`
   alias); `get_context_session_quality` uses `sessionId` for lookup. A harness
   can also set the `REPOVINE_CONTEXT_SESSION_ID` environment variable on the
   MCP server process to apply one session id to every call — it takes
   precedence over per-call `contextSessionId` arguments.

3. repovine records a compact session roll-up plus bounded request echoes to
   `.repovine/.cache/sessions/<sessionId>.json`. Full per-call events are not
   persisted unless debug persistence is enabled.

   **Client MCP** (default): each MCP process start purges all persisted session
   files automatically (`purgeSessionsOnMcpStart`, default when
   `enforcement.mode=client`) — no tool call required.

4. Inspect the report:

   ```json
   get_context_session_quality({
     "sessionId": "sess-run-2026-06-01-a",
     "phase": "explore",
     "consume": false
   })
   ```

5. For Agent Protocol gating, add `assignment.contextSession.required=true` and
   return `result.contextSessionId`. `repovine agents compliance` recomputes the
   report from the stored session and **consumes** it after a passing decision —
   a report with compliance errors retains the session for retry (harness path).
   Interactive IDE sessions rely on MCP-start purge plus optional manual
   `get_context_session_quality({ consume: true })` when debugging.

   Keep a session for debug by setting `assignment.contextSession.retain=true`
   or global `contextQuality.retainSessions=true` (also skips MCP-start purge).

## Session lifecycle

Persisted files: `.repovine/.cache/sessions/<sessionId>.json`. There is no TTL.

| Trigger | Who | When |
|---|---|---|
| **MCP process start (client default)** | MCP server on boot | `purgeSessionsOnMcpStart=true` (default when `enforcement.mode=client`) deletes all session files before serving tools — automatic, not an MCP tool call. |
| **Harness compliance** | `repovine agents compliance` | Consumes the session after a passing compliance report (no errors) when `result.contextSessionId` is present (unless retain flags); a hard-failed report keeps the session so a retry can re-score it. Default for `enforcement.mode=harness`: no startup purge. |
| **Manual** | Agent or harness | `get_context_session_quality({ consume: true })` or `repovine agents session-quality … --consume`. |

Config knobs: `contextQuality.purgeSessionsOnMcpStart`, `contextQuality.retainSessions`,
`assignment.contextSession.retain`.

## Hard vs soft thresholds

Two thresholds serve different purposes:

| Config field | Role |
|---|---|
| `threshold` / `qualityThreshold` | Hard minimum for `acceptHandoff` |
| `warningThreshold` | Soft bar: below it triggers warnings + `requiredFollowups`; may still accept when above the hard threshold |

The full default configuration appears under [What Is Scored](#what-is-scored).
The report includes `belowWarningThreshold`, `warnings`, and `requiredFollowups`.

## Enforcement modes

repovine hard-gates harnesses and advises developers:

| Mode | Where set | Behavior when session is weak or missing |
|---|---|---|
| `harness` | `assignment.contextSession.mode` or `contextQuality.enforcement.mode` | `required=true` + missing `contextSessionId` or a recorded session scoring `acceptHandoff=false` => compliance **errors**. A declared-but-unrecorded session id warns in all modes (`Context session not found`). |
| `client` (default) | repo default | low score / missing session => **warnings** + `requiredFollowups`, compliance may still be `valid: true` |

Context enforcement applies only when the repo has prior annotated context not
written by the current run; a greenfield first pass downgrades all context errors
to warnings.

Assignment policy overrides repo defaults:

```json
{
  "contextSession": {
    "required": true,
    "mode": "harness",
    "phase": "implement",
    "qualityThreshold": 0.55,
    "warningThreshold": 0.7,
    "minAnchors": 1,
    "byteBudget": 120000,
    "maxRecoveryAttempts": 2,
    "retain": false
  }
}
```

When context is weak and annotations in touched scope are stale or missing,
compliance adds follow-ups recommending targeted review, `write_annotation`, and
re-running the context funnel.

`maxRecoveryAttempts` is intentionally harness-owned: repovine validates and
echoes the value in quality reports, while the main agent/harness counts
attempts across assignments and decides when to stop retrying.

## What Is Scored

Noise signals include relaxed OR searches, export-symbol-heavy search hits, large
result volume, low confidence, unresolved scopes, test/fixture anchors, byte
budget overflow, and ending on search without map/inspect recovery.

Structure signals include high-confidence `map_context` / `inspect_node`
anchors, dependency impact on a module/export-symbol, recovery after an initially
noisy search, and ending on a scoped inspect/impact call.

Defaults are general-purpose and configurable in `repovine.config.json`:

```json
{
  "contextQuality": {
    "enforcement": { "mode": "client" },
    "purgeSessionsOnMcpStart": true,
    "thresholds": {
      "explore": { "threshold": 0.4, "warningThreshold": 0.55, "minAnchors": 1, "byteBudget": 80000 },
      "implement": { "threshold": 0.55, "warningThreshold": 0.7, "minAnchors": 1, "byteBudget": 120000 },
      "annotate": { "threshold": 0.35, "warningThreshold": 0.5, "minAnchors": 0, "byteBudget": 100000 }
    },
    "exportSymbolFloodRatio": 0.7,
    "archResponseOversizeBytes": 100000,
    "retainSessions": false,
    "persistEvents": false,
    "maxRequestEchoes": 20
  }
}
```

The report includes bounded `requestEchoes` for audit/debug. Echoes are kept out
of normal tool responses so routine context collection does not inflate the
model window.

## Stable anchors → annotation provenance

`aggregates.stableAnchors` is the set of node ids the agent resolved in the
session via **high-confidence `map_context`, `inspect_node`, or
`analyze_dependencies`** calls whose scope landed on a package, module,
export-symbol, runtime-resource, template, or infra node. Other tools deliberately do not create
anchors — a scoped `get_config_surface` or `get_entrypoints` hit proves you saw
one facet of the node, not that you read it. Beyond scoring structure, this set
is the **provenance** evidence for
annotation grounding (see `repovine/docs/agent-protocol.md`): during compliance,
each code module in the run's `annotationsWritten` is "grounded" when it was

- edited in this run (`filesChanged` maps to the module), or
- explicitly declared in `graphNodesTouched`, or
- present in `stableAnchors` — either the module id itself, or an `export:` anchor
  whose owning module is that module.

Coarse `pkg:` / `domain:` anchors are deliberately excluded: inspecting a whole
package must not "ground" every module in it. Because the join is over the
current run's writes only, enabling the harness gate never retroactively fails a
repo's pre-existing (un-provenanced) annotations. Threading the same
`contextSessionId` through your `inspect_node` calls and into the
`AgentRunResult` is therefore what lets a pure annotation phase (which changes no
files) prove it read what it annotated.
