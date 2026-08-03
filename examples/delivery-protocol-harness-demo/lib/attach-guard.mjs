// Attach-mode Git pointer: the fixed `gitdir:` pointer the host
// launcher writes under `$HARNESS_ATTACH_STATE_DIR/control/git-guard` and
// Compose mounts read-only at `/workspace/.git`. It targets the launch-scoped
// DISPOSABLE repository (`$STATE/runtime/git`, mounted at `/state/git`): the
// container gets full Git over the baseline + its own commits, while the source
// repository's per-worktree pointer and common dir never enter the container.
// The read-only mount keeps the agent from repointing it.
//
// The exact bytes are a spec constant shared by the host launcher (writes the
// pointer) and the in-container attach validation (byte-compares
// `/workspace/.git` against it). Change it only with both sides in
// sync.
export const ATTACH_GIT_POINTER_CONTENT = 'gitdir: /state/git\n';

/** Container path of the disposable repo the pointer targets. */
export const ATTACH_STATE_GIT_DIR = '/state/git';

/** Tag the launcher pins on the baseline commit; reset-to-baseline resolves it. */
export const ATTACH_BASELINE_REF = 'attach-baseline';
