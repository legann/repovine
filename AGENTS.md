<!-- repovine:agents-md:begin -->
# repovine -- quick reference

This managed block is intentionally short for Claude Code and Codex. Detailed workflows live in the generated skills, agent files, and hooks so this always-on file does not compete with project instructions.

## Start

Before non-trivial work, call the `repovine` MCP server first. Use `search_context` when the task wording is fuzzy, `map_context` when a domain/package/module is named, then `inspect_node` after narrowing. Skip this only for trivial single-file tasks.

If the MCP call fails with a connection error, the server is not running. Ask the user to check the MCP config. Do not fall back to blind file reading -- without the graph you lack structure and dependency info.

If a tool returns `result.status:"building"`, call `get_build_status({ "waitSec": 45 })` once instead of polling. `stageEtaSec` estimates only the current stage; use `stage` and `remainingStages` to report progress. If the long-poll still returns building, continue with direct file reads only when the task can proceed without graph structure. To abandon a cold build, call `get_build_status({ "cancel": true })`; it stops Stage 1 workers and returns `cancelled` (no graph) or keeps a prior `ready` graph.

Context Session Quality scores repovine MCP responses, not agent prose. Pass `contextSessionId` on MCP calls and inspect with `get_context_session_quality`; harnesses recompute via `repovine agents compliance`. The score and its thresholds are advisory until the labelled-corpus return bar in `docs/context-quality.md` is met; evidence-backed annotation checks remain enforceable.

## Working loop

- Orient/map/inspect: `search_context`, `map_context`, `inspect_node`.
- Follow the task axis: runtime/user flow -> `get_entrypoints` + `trace_flow`; shared contracts -> `analyze_dependencies`; env/resources -> `get_config_surface`; architecture/review candidates -> `analyze_architecture`; annotation health -> `get_annotation_status`.
- After code edits, call `refresh_context({})`. After changing `repovine.config.json`, call `refresh_context({ "reloadConfig": true })` so the running MCP process re-reads config and rebuilds the graph. Changing `repovine.domains.json` is picked up by a normal refresh; using `reloadConfig: true` is harmless when both files changed.
- Never hand-edit `repovine.annots.json`. Change it through `write_annotation`, `merge_annotations`, or `refresh_context({ "cleanupOrphans": true })`; `validate_annotations` reads it and reports, and writes nothing.

## Public MCP tools

- Orient/map/inspect: `search_context`, `map_context`, `inspect_node`
- Runtime/user flow: `get_entrypoints`, `trace_flow`
- Contracts/packages: `analyze_dependencies`
- Env/secrets/resources: `get_config_surface`
- Architecture candidates: `analyze_architecture`
- Annotation health/writes: `get_annotation_status` (view `carrier-gaps` pages carrier-link candidates by SSOT target), `get_annotation_merge_status`, `merge_annotations`, `validate_annotations`, `write_annotation`
- Domains advisor: `suggest_domains_config`
- Advisory declines: `decline_advisory` (kind: `domains-config` | `carrier-link-gaps`; workspace-local state)
- Sync/status/handoff audit: `refresh_context`, `get_build_status` (pass `cancel:true` to stop an in-flight build), `get_context_session_quality`

## Detailed workflows

Use generated skills for the longer procedures:

- `repovine-workflow`: implementation flow and post-edit checks.
- `repovine-refresh`: build status, refresh, config reload, domains suggestions, orphan cleanup.
- `repovine-status`: graph and annotation status.
- `repovine-review`: code review and architecture audit.
- `repovine-annotations`: annotation onboarding, merge repair, sideEffects vocabulary, and quality/provenance rules.

Claude uses `.claude/agents/*.md` and `.claude/skills/*/SKILL.md`. Codex uses `.codex/agents/*.toml` and `.agents/skills/*/SKILL.md`. Cursor uses `.cursor/rules`, `.cursor/agents/*.md`, and `.agents/skills/*/SKILL.md`, and does not rely on this `AGENTS.md` surface.

## Artifacts

| File | Git | Purpose |
|---|---|---|
| `repovine.annots.json` | Commit | Shared annotation memory between agents/sessions (workspace root). |
| `repovine.config.json` | Commit | Graph build (`build.scan`, `build.linking`), MCP/analyzer settings (workspace root). |
| `repovine.domains.json` | Commit | Domain patterns and package grouping (workspace root). |
| `.repovine/` | Ignore | Engine cache under `.cache` (snapshot, graph dumps, build calibration); `onboarding-state.json` and `carrier-review.json` hold advisory declines a rebuild does not restore. |

Commit `repovine.annots.json`. Never store secrets in annotations; the engine records env var names, not values, and rejects obvious secret values written through `write_annotation`.

## Delivery Protocol (explicit use only)

<!-- repovine:delivery-protocol protocolVersion=1 projection=1 -->

Normal client conversations are not Delivery Protocol runs. Finish ordinary client work with the host client's normal concise summary, tests, and blockers; do not append an `AgentRunResult` JSON block as a session summary.

Only return a **Delivery Protocol v1 `AgentRunResult`** when a harness/CI provides an `AgentAssignment` or `runId`, a command asks for `validate-result` / `compliance`, or the user explicitly requests an `AgentRunResult`. For the `main` role, required fields are: `summary`, `scope`, `compliance`.

In explicit protocol mode, pass `contextSessionId` on repovine MCP calls, run `refresh_context` after file changes, and never hand-edit `repovine.annots.json`; use `write_annotation`, `merge_annotations`, and `validate_annotations` for annotation state. Schema and field reference: `repovine agents protocol --schemas`, or `docs/delivery-protocol.md` in the repovine source repository.
<!-- repovine:agents-md:end -->
