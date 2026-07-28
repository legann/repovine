---
id: context-session-quality
title: Context-session threading and quality scoring
mode: read-only
repo_agnostic: true
applies_when: always
budget: { tool_calls: 9, mode: full }   # quick subset: session-threaded, quality-report
rollup: worst-of
checks:
  - id: session-threaded
    assert:  one contextSessionId is accepted on every MCP call that documents it, across multiple tools
    fail_if: the contextSessionId argument is rejected, or silently ignored such that no session accrues
    severity: fail
  - id: quality-report
    assert:  get_context_session_quality({ sessionId, phase:"explore", mode:"client" }) returns a quality report with a score
    fail_if: the call errors, or returns no score for a session that made several MCP calls
    severity: fail
  - id: phases-and-modes
    assert:  documented phase values and mode:"client" / mode:"harness" are accepted
    fail_if: a documented phase or mode is rejected as unknown
    severity: warn
  - id: score-reflects-mcp
    assert:  the score is computed from repovine MCP responses, not agent prose; shipped weights reduce it to 1 when the session called inspect_node and 0 otherwise
    fail_if: never FAIL — note the score value, and which rejectReasons/warnings a deliberately broad, low-signal call adds
    severity: warn
  - id: gates-surfaced
    assert:  hard gates (threshold / qualityThreshold) and soft gates (warningThreshold) are reflected when supplied
    fail_if: a supplied threshold/warningThreshold argument is rejected as unknown
    na_if:   thresholds not exercised this run
    severity: warn
---

You are a read-only repovine MCP context-quality agent. Verify that a single contextSessionId
threads through all tools and that get_context_session_quality scores the session.

Honor the shared preamble in `_PREAMBLE.md`. Session id e.g. `ctx-quality-YYYY-MM-DD-<repo-slug>`.
This card deliberately exercises a small spread of tools so the session accrues signal, then reads
the quality report. The score is computed from MCP response JSON and byte volume, not your prose.

## Steps

1. **Thread a session** → `session-threaded`.
   Make a small spread of read-only calls all with the same `contextSessionId`:
   `get_build_status`, `refresh_context`, `search_context`, `map_context`, `inspect_node` on a
   discovered `mod:`. Confirm each accepts the id.

2. **Read quality** → `quality-report`, `phases-and-modes`.
   `get_context_session_quality({ sessionId: contextSessionId, phase: "explore", mode: "client" })`,
   then once with `mode: "harness"` (and another documented `phase` if applicable). Confirm both
   are accepted and a score/report is returned.

3. **Noise signals (soft)** → `score-reflects-mcp`, `gates-surfaced`.
   Issue one deliberately broad, low-signal `search_context` under the same session and re-read
   quality. Under shipped weights the score holds the value step 2 read; report the `rejectReasons`
   and warnings the broad call adds. If the tool accepts `threshold` / `warningThreshold`, supply
   them and confirm the gate is reflected.

## Quick mode

Steps 1 and 2 (`session-threaded`, `quality-report`).

## Report format

- **Overall**: PASS / WARN / FAIL (`rollup: worst-of`).
- **Tested repo**: root, branch, short commit, `contextSessionId`.
- **Quality summary**: score, any warnings, phase/mode values accepted.
- **Check matrix** (one row per `checks[]` id) with evidence.
- **Findings** by severity; **MCP calls made**; final **context quality** summary; **INFO** notes
  (e.g. harness-mode vs client-mode gating behavior observed).
