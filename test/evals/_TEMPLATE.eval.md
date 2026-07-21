---
id: TEMPLATE-rename-me
title: One-line human title
mode: read-only                 # read-only | mutating
repo_agnostic: true
applies_when: always            # always | has_typescript | has_iac | has_web_frontend | has_annotations | is_repovine | ...
budget: { tool_calls: 12, mode: full }
rollup: worst-of
checks:
  - id: first-check
    assert:  what a PASS observes, one line
    fail_if: the observable that makes it FAIL
    na_if:   surface absent → N/A (omit if the check always applies)
    severity: fail              # fail | warn
  - id: second-check
    assert:  ...
    fail_if: ...
    severity: warn
---

<!--
Body = the prompt the agent executes. See _PREAMBLE.md — honor it; do not repeat it here. Keep
this body discovery-driven: derive every node id/scope/package from MCP responses in the TARGET
repo. Never hardcode repo names, paths, lambda names, or golden-fixture ids.
-->

You are a read-only repovine MCP eval agent. <one-sentence objective>.

Honor the shared preamble in `_PREAMBLE.md` (read-only contract, one `contextSessionId`, build
readiness, discovery-not-assumption, evidence gate, concise-first, verdict taxonomy, rollup).

## Steps

1. <discovery / setup step>
2. <observation step that maps to a `checks[]` id above>
   - PASS: ...
   - FAIL (`fail_if`): ...
   - N/A (`na_if`): ...
3. ...

## Quick mode

When time-boxed, run steps <list> only. Still discovery-driven; still report N/A for absent surfaces.

## Report format

- **Overall**: PASS / WARN / FAIL (apply `rollup: worst-of`).
- **Tested repo**: root, branch, short commit, `contextSessionId`.
- **Applicability**: which surfaces existed; which checks are N/A and why.
- **Check matrix** (one row per `checks[]` id):

  | Check id | Result | Evidence (exact id / field / `result.total` seen) |
  |----------|--------|---------------------------------------------------|
  | first-check  | PASS/WARN/FAIL/N/A | … |
  | second-check | … | … |

- **Findings** first, ordered by severity. Each: check id, Expected, Actual, Impact, and whether it
  is a repovine tooling gap, target-repo limitation, or N/A.
- **MCP calls made** (tool + key args, no secrets).
- **Context quality** summary for the shared `contextSessionId`.
- **Known-by-design behaviors** observed but not treated as failures (INFO).
