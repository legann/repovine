#!/bin/sh
# One-shot init before harness services start.
#
# The harness image runs as uid 1000 (`node`). scripts/compose.mjs pre-creates the
# workspace host dir as the invoking user, so on Linux it usually already matches
# and the chowns below are a fast no-op. When a prior run or a manual root-owned dir
# leaves it owned by another uid, fix ownership so ensureSandbox() can create
# .harness-home and sandbox/ at startup. On Docker Desktop shares that emulate
# ownership (macOS/Windows) the chown is a no-op or rejected; the non-root branch
# warns and continues, and the in-container writability check is the real gate.
set -eu

# Sandbox-only. Attach services never depend on this service; the guard is
# defense in depth — a mis-wired attach invocation must not chown an operator
# worktree.
if [ "${HARNESS_TARGET_MODE:-sandbox}" = "attach" ]; then
  echo "init-workspace: refusing to run in attach mode (sandbox profiles only)" >&2
  exit 1
fi

HARNESS_UID="${HARNESS_UID:-1000}"
HARNESS_GID="${HARNESS_GID:-1000}"

mkdir -p /workspace

ws_uid=$(stat -c '%u' /workspace)
if [ "$ws_uid" = "0" ]; then
  # A root-owned dir (manual mkdir, or a Docker auto-create from an older setup).
  # Recursive chown is safe here because root can traverse the whole tree. This
  # branch is Linux-real; keep it strict.
  chown -R "${HARNESS_UID}:${HARNESS_GID}" /workspace
elif [ "$ws_uid" != "${HARNESS_UID}" ]; then
  # A third uid (e.g. an operator chowned the dir). On a share that rejects chown
  # (Docker Desktop emulation), warn and continue: the container's own writability
  # probe (lib/target-repo.mjs) is the real correctness gate and names the path.
  chown "${HARNESS_UID}:${HARNESS_GID}" /workspace \
    || echo "init-workspace: chown not supported on this mount; relying on runtime writability check" >&2
  # BusyBox find uses -user, not -uid.
  find /workspace -xdev -user root -exec chown -h "${HARNESS_UID}:${HARNESS_GID}" {} + 2>/dev/null || true
fi
# When the mount is already uid ${HARNESS_UID} (normal after a prior run), skip
# `chown -R`: it fails under cap_drop:[ALL]+CHOWN on mode-700 subtrees such as
# `.harness-home/.claude` that the harness created as uid 1000.
