# Platform support

Support is a per-surface contract. Every claim names a surface, an OS, and its CI evidence. A bare "Windows supported" or "macOS supported" is never a valid claim.

## Tiers

| Tier | Meaning |
|---|---|
| Tier 1 | Documented prerequisites, mandatory CI/release gate, reproducible clean-install smoke, regressions fixed |
| Tier 2 | Code keeps the platform working where feasible; releases are not gated on it |

Architecture policy: macOS arm64 and Windows x64 are the Tier 1 targets; macOS x64 and Windows arm64 are Tier 2 until a native gate is green.

## Support matrix

Target tiers. A row is promoted only after its gate in [CI](../.github/workflows/ci.yml) is green and required.

| Surface | Linux | macOS | Windows native | Windows WSL2 |
|---|---|---|---|---|
| npm install / package bin | Tier 1 | Tier 1 | Tier 1 | Tier 1 |
| CLI, stdio MCP, graph/cache/annotations | Tier 1 | Tier 1 | Tier 1 | Tier 1 |
| `setup` / `doctor` / `clear` | Tier 1 | Tier 1 | Tier 1 | Tier 1 |
| Cursor / Claude / Codex projections and hooks | Tier 1 after per-client behavioral smoke | Tier 1 after per-client behavioral smoke | Tier 1 after per-client behavioral smoke | Tier 1 |
| Optional local embedder | Tier 1 | Tier 1 arm64 | Tier 1 x64 | Tier 1 x64 |
| Agent-harness demo (sandbox / attach / host mode) | per-mode | per-mode | per-mode | per-mode |

Harness demo modes carry separate contracts; see [usage.md, "Platform support"](../examples/agent-harness-demo/docs/usage.md).

Embedder floor on macOS: `@huggingface/transformers` 4.x. The 3.8.1 floor bundles onnxruntime 1.21, whose exit teardown aborts on darwin — inference completes, the exit code is corrupt. The embedder matrix records this as a documented exclusion.

## Current status (2026-07-22, post native-green)

| Evidence | State |
|---|---|
| Linux x64 (`ubuntu-latest`) | Required merge gate (CI): audit, typecheck, lint, tests, build, pack-install smoke, projection validation |
| Windows x64 (`windows-latest`) | Required merge gate (`core-windows`): build, full tests, pack-install smoke |
| macOS arm64 (`macos-15`) | Required merge gate (`core-macos-arm`): same |
| Embedder (real ONNX inference) | Required: Linux/Windows for the full peer range; macOS for transformers 4.x (3.8.1 excluded — documented ort 1.21 exit defect) |
| Harness demo (Linux + Docker) | Required merge gate (`harness-linux`): demo unit+render suite, actual-container egress smoke (allow-list, default-deny rule order, IPv6 drop, worker hardening probes) |

Core (package, CLI, stdio MCP, graph/cache/annotations) runs its full suite natively on all three Tier 1 platforms. Client-projection runtime claims stay `pending verification` until per-client behavioral smoke lands. An advisory leg renders a red X in the PR check list; the workflow conclusion stays green.

## Prerequisites

| Component | Requirement | Used by |
|---|---|---|
| Node | `>= 22` | everything |
| Git | any recent | Agent Protocol roles at a revision, annotation merge repair, harness attach/worktrees. Graph builds locate the repo root via the `.git` entry and run without the git executable |
| Python 3 | optional | Python source plugin (skipped when absent) |
| Docker + Compose | optional | agent-harness demo only |

With `core.autocrlf=true`, a role-brief read from the working tree yields CRLF bytes while `--at <rev>` yields the LF blob, so `ProjectRole.hash` differs between the two modes; a root `.gitattributes` pinning LF removes the divergence.

## Promotion rules

| Claim | Required evidence |
|---|---|
| Core Tier 1 on an OS | Green, required native CI job on that OS |
| Client integration Tier 1 | Run under the client's real shell/cwd/env semantics; GUI-launch minimal-PATH proof recorded as manual evidence |
| Docker Desktop support | Actual-container smoke on a real macOS / WSL2 machine (hosted runners have no Docker there). Record a release-evidence entry per harness-affecting release: {date, host OS + arch, Docker Desktop version, engine/compose versions from `docker compose version`, repo commit SHA, egress-smoke result, IPv6 leg: exercised or named-skip, render-matrix result incl. the drive-letter cell}. macOS is sandbox mode only — attach is Unsupported there, so the entry never implies attach coverage; the attach design is [ADR 0001](../examples/agent-harness-demo/docs/adr/0001-macos-attach-mount-topology.md) (Proposed). Windows evidence notes the checkout on WSL2 ext4 and is where the drive-letter cell gets its real-mount verification |
| Any surface on any OS | An unsupported path fails early with a stable, actionable error |
