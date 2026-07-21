#!/bin/sh
# One-shot init before harness services start.
#
# Docker creates missing bind-mount host directories as root (uid 0), even when
# `docker compose` is launched by an unprivileged user. The harness image runs
# as uid 1000 (`node`). Fix ownership on the workspace mount so ensureSandbox()
# can create .harness-home and sandbox/ at startup.
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
  # Docker auto-creates missing bind-mount host dirs as root. Recursive chown is
  # safe here because root can traverse the whole tree.
  chown -R "${HARNESS_UID}:${HARNESS_GID}" /workspace
elif [ "$ws_uid" != "${HARNESS_UID}" ]; then
  chown "${HARNESS_UID}:${HARNESS_GID}" /workspace
  # BusyBox find uses -user, not -uid.
  find /workspace -xdev -user root -exec chown -h "${HARNESS_UID}:${HARNESS_GID}" {} + 2>/dev/null || true
fi
# When the mount is already uid ${HARNESS_UID} (normal after a prior run), skip
# `chown -R`: it fails under cap_drop:[ALL]+CHOWN on mode-700 subtrees such as
# `.harness-home/.claude` that the harness created as uid 1000.
