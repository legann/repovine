---
id: annotation-health
title: Annotation coverage, queue, merge, and validate health
mode: read-only
repo_agnostic: true
applies_when: always
budget: { tool_calls: 9, mode: full }   # quick subset: coverage-callable, read-only-guard, validate-runs
rollup: worst-of
checks:
  - id: coverage-callable
    assert:  get_annotation_status({ view:"coverage" }) returns coverage.allNodeTypes (total/fresh/needsWork) and the per-bucket counts
    fail_if: the call errors or omits coverage figures
    severity: fail
  - id: queue-unified
    assert:  view:"queue" returns ONE unified backlog with needsWork/totalRemaining spanning modules + services + infra + domain roll-ups; propagation-stale is stale+staleKind propagation inside needsWork
    fail_if: the queue errors, needsWork/totalRemaining is presented as modules-only, or propagation-stale is split into a separate mandatory advisory channel without staleKind
    severity: warn
  - id: orphans-listed
    assert:  view:"orphans" lists annotation orphans (reporting only)
    fail_if: orphans are cleaned (refresh_context cleanupOrphans) instead of just listed
    na_if:   no annotations exist
    severity: fail
  - id: merge-status
    assert:  get_annotation_merge_status returns a clean or conflicted state, and conflict markers (if any) are detected
    fail_if: the call errors, or conflict markers in repovine.annots.json are not surfaced
    severity: warn
  - id: validate-runs
    assert:  validate_annotations runs and reports consistency issues without modifying the file
    fail_if: validate_annotations errors or mutates repovine.annots.json
    severity: warn
  - id: read-only-guard
    assert:  no annotation mutation occurs — no write_annotation, merge_annotations, or cleanupOrphans
    fail_if: any annotation-writing or cleanup call is made during the audit
    severity: fail
---

You are a read-only repovine MCP annotation-health agent. Verify annotation coverage/queue/merge/
validate surfaces report correctly — without writing, merging, or cleaning anything.

Honor the shared preamble in `_PREAMBLE.md`. Session id e.g. `annot-health-YYYY-MM-DD-<repo-slug>`.
This card is strictly observational: `read-only-guard` fails the whole card if any write/merge/
cleanup call is issued.

## Steps

1. **Coverage + queue** → `coverage-callable`, `queue-unified`.
   `get_annotation_status({ view: "coverage", contextSessionId })`, then
   `get_annotation_status({ view: "queue", limit: 20, contextSessionId })`. Confirm `needsWork` /
   `totalRemaining` reflects needsWork across modules + services + infra + domain, not
   just the modules bucket; propagation-stale is stale+staleKind propagation inside needsWork.

2. **Orphans** → `orphans-listed`.
   `get_annotation_status({ view: "orphans", contextSessionId })`. List only — do NOT clean.

3. **Merge + validate** → `merge-status`, `validate-runs`, `read-only-guard`.
   `get_annotation_merge_status({ contextSessionId })` and `validate_annotations({ contextSessionId })`.
   If conflict markers exist, confirm they are surfaced (and report them) — do not run
   `merge_annotations`. Confirm the file was not modified.

## Quick mode

Steps 1 (coverage) and 3 (`coverage-callable`, `validate-runs`, `read-only-guard`).

## Report format

- **Overall**: PASS / WARN / FAIL (`rollup: worst-of`).
- **Tested repo**: root, branch, short commit, `contextSessionId`.
- **Annotation summary**: allNodeTypes total/fresh/needsWork, queue needsWork/totalRemaining (+ bucket breakdown),
  staleContent/stalePropagation counts, orphan count, merge state, validate issues.
- **Check matrix** (one row per `checks[]` id) with evidence.
- **Read-only statement**: explicit confirmation no write/merge/cleanup call was made.
- **Findings** by severity; **MCP calls made**; **context quality**; **INFO** notes.
