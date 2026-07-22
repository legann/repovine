# ADR 0001: macOS attach mount-topology proof

## Status

Proposed. Acceptance is a human review gate. The conditional implementation does not start before acceptance. Until that implementation ships and its real-host test matrix passes, attach on macOS refuses at the platform gate before any Docker call.

## Context

Attach mode bind-mounts a pre-created git worktree into a hardened container. The launcher must prove four properties before the first Docker invocation:

| Property | Threat it excludes |
|---|---|
| No mount strictly below the worktree or state dir | A nested mount shadows or leaks through the container bind |
| No bind source aliases another bind source | One mount grants writes into a sibling trust domain |
| The source repo's common git dir is unreachable from any bind | The agent rewrites source history or refs |
| No multiply-referenced regular file inside the worktree | A hardlink shares content with a path outside the mount |

Linux proves these via `/proc/self/mountinfo` with a tri-state contract: enumerated-clean, enumerated-offending, cannot-enumerate. Cannot-enumerate refuses before Docker (`scripts/attach-host-adapter.mjs`, `readHostMountTable`). A complete `lstat` walk rejects regular files with `nlink > 1`. macOS has no `/proc`, and Node ships no mount-table API. Attach on macOS is therefore refused before any Docker call. This document designs the proof that could lift the refusal.

## Trust boundary on Docker Desktop for Mac

The container never sees the host mount table. It sees the Linux VM's projection of a host directory through Docker Desktop's file-sharing layer (virtiofs on current releases, gRPC-FUSE on legacy ones).

```
host APFS volume
  └─ file-sharing export (virtiofs / gRPC-FUSE)
       └─ Linux VM mount
            └─ container bind (/workspace)
```

Host-side topology proof is necessary and, alone, insufficient: the projection re-interprets identity and traversal. The proof must model four traversal channels of the sharing layer:

| Channel | Question the proof must answer |
|---|---|
| Symlinks under shared roots | Are links resolved host-side or guest-side, and can a link escape the export root |
| Firmlinks (APFS volume-group splice) | Does a bind path cross a system/data splice invisible to `lstat` |
| Nested volumes under a shared path | Does the export traverse into a volume mounted below the bind source |
| Projection identity semantics | Are inodes stable across Desktop restarts; is `nlink` reported faithfully for host hardlinks |

Each channel needs a verified answer on a real host; none is assumed. The bind sources must also lie inside Docker Desktop's configured file-sharing roots, or the launch refuses.

## APFS specifics

APFS adds two mechanisms with no Linux counterpart; both interact with the existing guards.

| Mechanism | Behavior | Effect on current guards |
|---|---|---|
| Firmlink | Directory-level splice between the system and data volumes | Presents as a plain directory to `lstat`; the crossing is visible only as a `st_dev` change |
| `clonefile(2)` / `cp -c` | Copy-on-write clone sharing extents until first write | Reports `nlink = 1`; the `nlink > 1` hardlink guard never fires |

A clone is a distinct inode; extent sharing is invisible to `stat`. Two claims must be proven on a real host and are not assumed here:

1. Clone independence after write: a write through the container's projection triggers copy-on-write and never mutates the origin file's extents.
2. Clone reach: a clone placed inside the worktree cannot alias live contents of the source repo's common git dir — reads see a launch-time snapshot, writes never propagate.

If either claim fails on hardware, the fail-closed decision stands and macOS attach keeps refusing.

## Candidate enumeration APIs

The mount-table source must be machine-parseable, complete (every mount type, including network and FUSE), and versioned by the OS.

| Candidate | Format | Complete | Verdict |
|---|---|---|---|
| (a) `getmntinfo(3)` via a small native helper | `statfs` structs | yes | **Accepted** — complete structured enumeration; native-code cost bounded below |
| (b) `/sbin/mount` output | human text, `dev on path (type, opts)` | yes | Rejected — paths containing ` on ` or ` (` parse ambiguously; no stable contract |
| (c) `mount -p` | fstab columns | yes | Rejected — whitespace in mount points is not escaped; column split is unsound |
| (d) `diskutil list -plist` + `diskutil info -plist <dev>` | plist | no | Rejected — enumerates disk-backed volumes only; NFS/SMB/FUSE mounts are absent |
| (e) per-path `statfs(2)` / `getattrlist` via Node FFI | structs | no | Rejected — per-path queries only. `getfsstat(2)` (the syscall behind (a)) does enumerate and is callable from an addon; that route is (a) with the same native-code cost |

Native-code cost of (a): the helper is a single-file C program (~80 lines) calling `getmntinfo(3)` and printing JSON. It ships as a prebuilt universal binary (arm64 + x86_64) with a recorded checksum; any load, exec, exit-code, or checksum failure maps to cannot-enumerate.

## Primary source contract

The helper is the single mount-table source; its contract mirrors `readHostMountTable`.

| Aspect | Value |
|---|---|
| Invocation | helper binary, no arguments, stdout only |
| Output | one JSON object: `{ "mounts": [{ "mountPoint", "fsTypeName", "mountedFrom", "fsid", "local": bool }] }` |
| Encoding | UTF-8; mount points are exact byte strings from `statfs.f_mntonname` |
| macOS floor | macOS 13 (Ventura); older hosts refuse at the platform gate |
| Success | exit 0 and JSON parses and `mounts.length > 0` |
| Failure semantics | non-zero exit, signal death, invalid JSON, missing field, or empty `mounts` — each is cannot-enumerate, which refuses before Docker |

## Proof algorithm

The macOS proof mirrors the Linux tri-state contract: every step ends enumerated-clean, enumerated-offending, or cannot-enumerate, and only enumerated-clean proceeds.

1. Enumerate mounts through the helper (contract above). Any failure is cannot-enumerate.
2. Canonicalize every compared path to its on-disk form (`F_GETPATH` on an opened descriptor) before any containment or prefix check. Default APFS is case-insensitive and normalization-insensitive, so byte-exact comparison of raw input strings is unsound. Canonicalization failure is cannot-enumerate.
3. Map each canonical bind source (worktree, state dir, agents dir) to its containing mount by longest mount-point prefix, matching `mountForPath`. No containing mount is cannot-enumerate.
4. Enforce an fs-type allowlist: only `apfs` with `local: true` passes. Every other type — `smbfs`, `nfs`, `autofs`, `macfuse`, `lifs`, unknown — is enumerated-offending, mirroring `assertProvableFsType`.
5. Enumerate Docker Desktop's configured file-sharing roots from the Desktop settings store (`settings-store.json` in the Docker group container; exact path fixed per supported Desktop version at implementation time). Unreadable or unparseable settings are cannot-enumerate. A bind source outside every configured root is enumerated-offending.
6. Reject mounts strictly below any bind source (nested-volume check, same rule as Linux `mountsBelow`).
7. Detect firmlink crossings: `lstat` every path component of each bind source; a `st_dev` change with no enumerated mount at that component is an unexplained splice — enumerated-offending.
8. Detect aliases by `(st_dev, st_ino)` identity: bind sources against each other and against the source repo's per-worktree and common git dirs. Canonical paths make string comparison meaningful; identity comparison stays authoritative. Identity match outside the one legitimate containment is enumerated-offending.
9. Walk the worktree with `lstat`: reject special files and regular files with `nlink > 1`, unchanged from Linux.
10. Clone awareness: no public API marks a file as a clone. `SF_*` stat flags do not mark clones. `fcntl(F_LOG2PHYS)` extent comparison witnesses sharing only between two files already in hand; it cannot see sharing with files outside the walk, so it cannot prove tree-wide absence. The walk therefore keeps `nlink > 1` as its only per-file rejection. Clone risk is carried by the two real-host proofs in "APFS specifics". Until those proofs pass, macOS attach stays refused.

## Failure semantics

Every unprovable state refuses before Docker. No best-effort branch exists.

| Condition | Verdict |
|---|---|
| Helper missing, non-zero exit, or checksum mismatch | cannot-enumerate — refuse |
| Helper output fails to parse, field missing, empty mount list | cannot-enumerate — refuse |
| Bind source outside every enumerated mount | cannot-enumerate — refuse |
| Path canonicalization (`F_GETPATH`) fails for any compared path | cannot-enumerate — refuse |
| Bind source on a non-`apfs` or non-local filesystem | refuse (`fs-type`) |
| Unknown fs type | refuse (`fs-type`) |
| Desktop settings store unreadable or unparseable | cannot-enumerate — refuse |
| Bind source outside every configured file-sharing root | refuse (`mount-table`) |
| Mount strictly below a bind source | refuse (`mount-table`) |
| Unexplained `st_dev` change along a bind-source path | refuse (`mount-table`) |
| `(dev, ino)` alias between bind sources or with git dirs | refuse (`path-overlap`) |
| Regular file with `nlink > 1` in the worktree | refuse (`worktree-walk`) |
| File-sharing backend absent from the proven allowlist | refuse (`platform`) |
| macOS release below the floor | refuse (`platform`) |

## Decision

Primary source: `getmntinfo(3)` through the prebuilt native helper, JSON output, macOS 13 floor, parse-failure-refuses semantics as fixed above.

The conditional implementation builds a darwin adapter with the same tri-state contract as `scripts/attach-host-adapter.mjs` on Linux: `readHostMountTable` returning `{ mounts }` with cannot-enumerate as a thrown `PreflightError('mount-table', …)`, `mountForPath` longest-prefix resolution, and `assertProvableFsType` enforcing the `apfs`-only allowlist via `PreflightError('fs-type', …)`. The `PreflightError` shape — class name, `.check`, `attach <check>: ` message prefix — is unchanged. Docker Desktop's file-sharing configuration and the version floor are validated in the same preflight, before any Docker call.

### Real-host test matrix

Promotion of the macOS attach surface requires every row green on physical hardware (Apple silicon and Intel), per file-sharing backend. A backend with any non-green row stays off the allowlist; the adapter refuses when the detected backend is not allowlisted. Legacy gRPC-FUSE is not grandfathered — it earns its rows or stays refused.

| Case | Expected result |
|---|---|
| Symlink inside the worktree pointing outside the export root | Traversal stays confined or the launch refuses |
| Bind-source path crossing a firmlink | Refused by the `st_dev` component check |
| `clonefile` of a tracked file into the worktree; write through the container | Origin file bytes unchanged (clone-independence proof) |
| Clone of a file from the source common git dir placed in the worktree | Source git data unreachable for writes (clone-reach proof) |
| Volume mounted strictly below the worktree | Refused by the nested-mount check |
| Host hardlink pair inside the worktree | Refused by the `nlink > 1` walk, host-side and through the projection |
| Inode identity across a Docker Desktop restart | Stable, or the projection is documented unstable and identity checks re-run per launch |
| `nlink` reporting through virtiofs for host hardlinks | Faithful, or the walk is repeated container-side before first agent step |
| Worktree on a case-insensitive APFS volume with case-variant alias paths | Alias caught by `(dev, ino)` identity |

## Non-goals

- No code changes accompany this document.
- No timeline commitments.
- The refuse-before-Docker default keeps full strength while this design is unimplemented.
- Native Windows attach stays out of scope; WSL2 is the Windows route.
