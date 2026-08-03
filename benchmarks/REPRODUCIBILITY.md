# Reproduction Envelope

This document records the execution envelope and manual rerun procedure for the published 320-run corpus.

The machine-readable corpus inventory is [`manifest.json`](manifest.json).

## Recorded runtime

| Dimension | Published corpus |
|---|---|
| Repovine | `0.1.0` |
| Agent client | Claude Code CLI `2.1.*`; the exact per-run build was not retained |
| Models | `claude-sonnet-5`, `claude-opus-4-8`, `claude-fable-5`, `claude-opus-5` |
| Effort | Claude Code `--effort max` |
| Sessions | one fresh session per run; `autoMemoryEnabled: false` |
| Runs | N=10 per model–case–arm cell |
| Repository pins | recorded in each case README and `manifest.json` |

## Manual rerun checklist

1. Clone the upstream repository and check out the pin recorded for the case.
2. Create clean baseline and Repovine worktrees from the same pin.
3. Use the repository's native instructions, documentation, skills, and agent tools in both arms.
4. Run the Repovine arm with Repovine `0.1.0` and the Repovine setup published for the case.
5. Start a fresh Claude Code session with memory disabled and the highest effort setting. Submit the exact task prompt published in the case README.
6. Allow one autonomous prompt-to-diff session. Exclude evaluator feedback and post-run diff repair.
7. Preserve the complete final local diff, including untracked files, and score it against the case's published predicate.
8. Record the actual Claude Code build, model identifier, timestamps, tool configuration, timeout status, and the scorer output for the new run.

## Run command

Both arms invoke Claude Code headless with the published task prompt. The baseline arm adds `--strict-mcp-config`, which restricts MCP to the (empty) command-line config, so no Repovine context reaches the agent. The Repovine arm warms the graph, then runs with the case's MCP config, annotations, and bootstrap files resident in the worktree.

Baseline arm:

```bash
claude -p "<task prompt>" \
  --model <claude-opus-4-8 | claude-sonnet-5 | claude-fable-5 | claude-opus-5> \
  --effort max \
  --strict-mcp-config \
  --dangerously-skip-permissions \
  --settings '{"autoMemoryEnabled": false}' \
  --session-id <fresh-per-run-id> \
  --output-format json
```

Repovine arm — the worktree holds `.mcp.json`, `.claude/`, `repovine.annots.json`, and the `.repovine` graph cache:

```bash
REPOVINE_ROOT="<worktree>" node <repovine>/dist/mcp/index.js status   # warm the graph
sleep 45
claude -p "<task prompt>" \
  --model <claude-opus-4-8 | claude-sonnet-5 | claude-fable-5 | claude-opus-5> \
  --effort max \
  --dangerously-skip-permissions \
  --settings '{"autoMemoryEnabled": false}' \
  --session-id <fresh-per-run-id> \
  --output-format json
```

`<task prompt>` is the exact case prompt from the README. `<fresh-per-run-id>` is a new session id per run; a session id reused from an errored run is rejected as already in use. The two commands differ only by `--strict-mcp-config`.

## Published evidence and reruns

The published package contains redacted transcripts, prompts, pins, annotations, structural predicates, per-run facts, and transcript gate metadata. The transcripts omit upstream source and submitted code under the [redaction rules](METHODOLOGY.md#redaction); licensing details are in [README.md#license](README.md#license).

The checklist above defines the current manual rerun procedure.
