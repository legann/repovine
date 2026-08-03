# Platform support

Support is stated per surface and OS, and each state names the CI job that proves it.

## States

| State | Meaning |
|---|---|
| Supported | CI-gated on this OS; regressions block release |
| Best-effort | Kept working where feasible; releases not gated on it |
| Unsupported | The entrypoint refuses, or `doctor` warns with the remedy |

Primary architectures: Linux x64, macOS arm64, Windows x64. Second architectures
(macOS x64, Windows arm64) are Best-effort until a native gate is green.

## Support matrix

| Surface | Linux | macOS | Windows | WSL2 |
|---|---|---|---|---|
| npm install, package bin | Supported | Supported | Supported | Supported |
| CLI, stdio MCP, graph / cache / annotations | Supported | Supported | Supported | Supported |
| `setup` / `doctor` / `clear` | Supported | Supported | Supported | Supported |
| Client projections (Cursor, Claude, Codex) | Supported | Supported | Supported | Supported |
| Client hook runtime under each client | Manual¹ | Manual¹ | Manual¹ | Supported |
| Local embedder | Supported | Supported² | Supported | Supported |
| Delivery Protocol harness demo | per mode³ | per mode³ | per mode³ | per mode³ |

¹ Projections build and validate in CI; per-client hook runtime is verified by a manual GUI-launch minimal-PATH proof.
² macOS requires `@huggingface/transformers` 4.x. 3.8.1 bundles onnxruntime 1.21, whose exit teardown aborts on darwin; `doctor` warns.
³ Modes carry separate contracts; macOS is sandbox-only (attach Unsupported). See [usage.md](https://github.com/legann/repovine/blob/main/examples/delivery-protocol-harness-demo/docs/usage.md).

## CI gates

Required merge gates: `core-linux`, `core-windows`, `core-macos-arm`, `harness-linux`.

| Job | OS | Covers |
|---|---|---|
| `core-linux` | Linux x64 | audit, typecheck, lint, build, test, pack-install smoke, projection validation |
| `core-windows` | Windows x64 | build, test, pack-install smoke, plugin canaries |
| `core-macos-arm` | macOS arm64 | build, test, pack-install smoke, plugin canaries |
| `harness-linux` | Linux + Docker | demo suite, container egress smoke (allow-list, default-deny, IPv6 drop, worker hardening) |
| `embedder-matrix` | Linux, macOS, Windows | real ONNX inference across the peer range (macOS excludes 3.8.1); runs on embedder changes and weekly |

## Prerequisites

| Component | Requirement | Used by |
|---|---|---|
| Node | `>= 22` | everything |
| Git | any recent | roles at a revision, annotation merge, harness attach / worktrees. Graph builds locate the root via `.git` and run without the git executable |
| Python 3 | optional | Python source plugin (skipped when absent) |
| Docker + Compose | optional | Delivery Protocol harness demo only |

Windows paths over 260 characters need the `LongPathsEnabled` registry value; `doctor --json` reports it as `platform.longPaths`.

Windows with `core.autocrlf=true`: a working-tree role brief yields CRLF bytes while `--at <rev>` yields the LF blob, so `ProjectRole.hash` diverges between the two modes. A root `.gitattributes` pinning LF removes it.
