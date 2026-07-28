# repovine: CLI vs npm scripts

## One rule

**The public API is the `repovine` CLI.** npm scripts are shortcuts for **developing this package**.
Source development uses npm, pinned by `packageManager` in `package.json`; keep
`package-lock.json` in sync with dependency changes.

| Who | How to run |
|-----|------------|
| **Any project (published)** | `npx repovine <command> …` |
| **Clone / fork (local dev)** | `npm run cli -- <command> …` after `npm run build` |

After `npm run build`:

```bash
npm run cli -- setup all
# same as:
npx repovine setup all         # when published
node dist/mcp/index.js setup all
```

---

## CLI commands (canonical)

```text
repovine                         MCP server (stdio)
repovine setup [cursor|claude|codex|all] [-i|--interactive] [--force] [--replace-mcp] [--no-build] [--published]
repovine build                   Build syntax index + graph cache
repovine status                  Graph/config/annotation health snapshot
repovine doctor                  Diagnose why an agent is not using repovine correctly
repovine clear [--dry-run]
repovine agents <subcommand> …   # see repovine agents --help
repovine --help | --version
```

STDIO is the only supported MCP transport in v1. Remote/devcontainer setups should start the `repovine` subprocess in the remote checkout rather than connecting to a central server.

By default `setup <client>` also builds the graph. If the domains advisor finds
additive `repovine.domains.json` suggestions, interactive setup reviews them one
at a time before writing accepted additions; non-interactive setup leaves
suggestions pending in `.repovine/onboarding-state.json` for an agent to review
through `suggest_domains_config`. `--no-build` skips this advisor pass until the
first build/refresh.

`repovine agents` contains the CLI-only Agent Protocol commands used by
harnesses and CI. Their syntax and integration semantics are defined in
[agent-protocol.md — Protocol CLI surface](agent-protocol.md#protocol-cli-surface).
Worker MCP exposes context tools only; protocol validation is not on `tools/list`.

The same command group also contains one non-protocol utility:

```text
repovine agents orient --query "<task text>" [--scope <pkg>]
```

`orient` runs deterministic context orientation without an LLM.

**Client projections** (MCP config, rules, managed agents, `AGENTS.md`): `repovine
setup` — not `repovine agents`. **Drift checks:** `repovine doctor` (interactive) or
`repovine doctor --json` (CI). Details:
[agent-protocol.md — Projections](agent-protocol.md#projections).

### Plugin marketplace bundles

The `repovine-client-plugins` repo is a projection of engine SSoT, rendered into the
sibling `../repovine-client-plugins`. Maintainer scripts — not part of `repovine agents`.

| Script | Meaning |
|--------|---------|
| `render-client-plugins` | Build, then render every client bundle + marketplace manifests |
| `render-client-plugins:check` | Diff the plugin repo against a fresh render; report drift, write nothing |
| `render-client-plugins:validate` | Static checks on a rendered repo: manifests, MCP pins, hook layout |

Bundles pin the MCP to `npx -y repovine@<version>` (the engine `package.json` version at
render time). Release order is **`npm publish` the engine, then render**: render refuses
while that version is unresolvable on npm, because an installed bundle pinning it would
fail to start the MCP. Pass `--allow-unpublished`
(`npm run render-client-plugins -- --allow-unpublished`) for a local/offline dry run.

`--client <cursor|claude|codex>` renders one bundle and leaves the other bundles and
their marketplace manifests in place. A full render wipes the repo first, so files
dropped from the projection disappear with it; `assets/`, `.git`, and `.gitignore`
survive both.

CI renders to a temp root and validates the projection on every PR. Drift between the
engine and the committed plugin repo is checked locally:
`npm run render-client-plugins:check` (exit 1 lists missing/stale files).

**Preferred form (docs, CI, copy-paste):**

```bash
npx repovine setup all
```

Colons in npm script names (e.g. `repovine:init:all:build` in a **consumer** repo) are optional shortcuts — not CLI syntax. This package does not ship them; add your own in the root `package.json` if you want.

---

## npm scripts in `package.json`

Kept minimal on purpose. Use **`npx repovine`** in downstream projects or **`npm run cli --`** when working from a clone.

### Package maintenance

| Script | Meaning |
|--------|---------|
| `build` | Compile TypeScript → `dist/` (`tsc`) |
| `clean` | Remove `dist/` |
| `typecheck` | Build plugin-sdk (`tsc -p packages/plugin-sdk/tsconfig.json`, emits `packages/plugin-sdk/dist`), then no-emit check of src + tests (`tsc -p tsconfig.test.json`) |
| `test` | Jest unit tests |
| `smoke:pack-install` | Pack both packages, install into a throwaway repo, drive the MCP over stdio |
| `profile` | Memory profiler (dev) |

`smoke:pack-install` runs the path `npx -y repovine@<version>` takes. A build inside the
engine checkout resolves `devDependencies` that a published install does not ship, so
`node dist/mcp/index.js --help` passing here proves nothing about the tarball. CI runs
this on every PR.

`npm run build` **≠** `repovine build`. The first compiles the engine; the second builds the **syntax index and graph cache** for the resolved workspace root: `REPOVINE_ROOT` when set, otherwise the nearest ancestor holding `.git`. An unconfigured root re-roots to a configured ancestor — see [workspace-files.md](workspace-files.md).

### CLI entry (local dev)

| Script | Meaning |
|--------|---------|
| `cli` | Passthrough to the public CLI: `npm run cli -- <subcommand> [args]` |

Examples:

```bash
npm run cli -- build
npm run cli -- status
npm run cli -- doctor
npm run cli -- clear --dry-run
npm run cli -- setup all
```

There are no per-command npm aliases in this package — use `cli --` or `npx repovine`.

---

## `npm run` vs `npx`

| | `npm run cli -- …` | `npx repovine …` |
|--|-------------------|------------------|
| **Needs** | Clone + `npm ci` + `npm run build` | Network (or cache); no clone |
| **Runs** | Local `dist/` via the `cli` script | Published bin from npm |
| **CWD** | Any directory; the root is `REPOVINE_ROOT`, else the nearest ancestor holding `.git` | Same |
| **For agents** | Local MCP config can point at `node …/dist/mcp/index.js` | **Typical** — MCP config uses `npx -y repovine` |

MCP hosts (Cursor, Claude, Codex) usually invoke **`npx repovine`**. When you run
`setup` from a clone using your own built engine (`npm run cli -- setup …` or
`node dist/mcp/index.js setup …`), the generated MCP config is wired at that local
`dist/mcp/index.js` **automatically** — so the MCP runs **your** build, not the
published package. This is detected from how `setup` was launched (engine inside
the repo and not under `node_modules/`); pass `--published` to force the `npx`
launcher anyway (e.g. release validation). `setup` does not overwrite an existing
`repovine` MCP entry, so to switch an old `npx` entry over to your local build,
re-run after `repovine clear`. (`--replace-mcp` rewrites only invalid-JSON or
empty MCP configs; it is a no-op when a `repovine` entry already exists.)

---

## Output modes

- **MCP stdio**: stdout = JSON-RPC only; build progress on stderr or silent.
- **Interactive commands** (`status`, `doctor`, `setup`, `clear`, `build` summary): readable text on stdout.
- **JSON flags** (`doctor --json`, `status --json`): machine output on stdout. `doctor --help` lists `--json`; `status --json` is accepted but omitted from `status --help` so the default remains concise prose.
- **Harness / CI commands** (`repovine agents validate-*`, `repovine agents compliance`, `repovine agents protocol`, `repovine agents session-quality`): JSON on stdout for file-in/file-out; progress on stderr.

ANSI colors follow TTY / `NO_COLOR` / `FORCE_COLOR`; pipes and CI get plain text.
