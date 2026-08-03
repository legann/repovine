# repovine workspace files

repovine keeps **committed tuning and memory** at the repository root, and **local engine cache plus advisory decline state** under `.repovine/`. Together they let agents share structure, domain layout, and annotations across sessions without checking machine-specific build artifacts into Git.

| Path | Git | Role |
|---|---|---|
| `repovine.config.json` | Commit | Graph build (`build.scan` / `build.linking`), MCP output, architecture detectors, workspace paths |
| `repovine.domains.json` | Commit | Domain inference, aliases, package grouping, infra noise filters |
| `repovine.annots.json` | Commit | Shared semantic memory (default path; override via `workspace.annotationsFile`) |
| `annotations.backup.*.json` | Untracked | Safety backups written beside `repovine.annots.json` before large annotation-file shrink writes; rotated locally. The managed `.gitignore` does not cover them — see [Local backups](#local-backups). |
| `.repovine/` | Ignore | Engine cache under `.cache` (graph/search caches, build calibration, session roll-ups, optional dumps), generated boundary index; `onboarding-state.json` and `carrier-review.json` hold advisory declines a rebuild does not restore |

`npx repovine setup` and the first MCP server startup both bootstrap missing workspace files: all three project-owned JSON files (`repovine.config.json`, `repovine.domains.json`, and an empty `repovine.annots.json`), `.repovine/`, and the managed `.gitignore` cache entry. Later `setup` and `clear` **preserve** all three project-owned JSON files. Both config files are optional: omit a field to keep the engine default.

Precedence for `repovine.config.json`: **defaults → file → environment → CLI**.

Environment overrides:

| Variable | Effect |
|---|---|
| `REPOVINE_ROOT` | Workspace root (instead of walking up to `.git`) |
| `REPOVINE_ANNOTATIONS_FILE` | Overrides `workspace.annotationsFile` (repo-root-relative path) |
| `REPOVINE_VERBOSE=1` | Enables MCP verbose logging |
| `REPOVINE_MCP_RESPONSE=concise\|debug` | Overrides `mcp.response.mode` |
| `REPOVINE_MCP_MAX_CHARS` | Overrides `mcp.response.maxChars` (minimum `1000`) |
| `REPOVINE_MAX_PACKAGE_WORKERS` | Sets `build.scan.maxPackageWorkers` for Stage 1 graph builds when the config file leaves it unset (a config-file value wins) |
| `REPOVINE_CONTEXT_SESSION_ID` | Default `contextSessionId` for every MCP call in this process (harness sandboxes); takes precedence over per-call ids |

---

## Workspace root

repovine analyzes **one workspace root**. Everything it indexes lives under that root.

The root is `REPOVINE_ROOT` when set, otherwise the nearest ancestor holding `.git`. A resolved root carrying no `repovine.config.json` re-roots to a configured ancestor inside the same repository, reported on stderr.

Every path that reaches the graph is resolved through symlinks and re-tested against the root. Config-supplied paths follow the same rule: `build.scan` globs, `build.linking` handler roots and bundle scripts, and paths reached through `tsconfig.json`.

`workspace.annotationsFile` is checked lexically: absolute paths and `..` escapes are refused, symlinks stay unresolved. A directory symlink on that path places the annotations file outside the root.

| Path leaves the root by | Example | Result |
|---|---|---|
| naming a parent | `"../shared/**"` in `build.scan.include` | No match |
| a file symlink | `src/leak.ts -> /etc/passwd` | Refused |
| a directory symlink | `src/linked -> ../../other-repo` | Everything beneath it refused |
| a tsconfig reference | `"include": ["../lib"]` | Refused |

Refused files are absent from the graph, including from import resolution. A refused candidate is counted in the build log, in `repovine status`, and under `outsideRepo` in `refresh_context` / `get_build_status`. Discovery by directory walk skips symlink entries before they become candidates, so those stay out of the count.

`build.scan` patterns are tested against repo-relative paths from walks rooted at the workspace root. A pattern naming a parent matches nothing, so it produces neither a candidate nor a refusal. To index a sibling tree, root repovine at the directory containing both.

---

## `repovine.config.json`

Controls graph **build** tuning (`build.scan` + `build.linking`), external plugin specs,
MCP response shape, optional `semantic_search_embeddings` for NL fuzzy entry, and
`analyze_architecture` detector strictness.

### Minimal example

Omit any block to keep engine defaults. When this file is missing,
`npx repovine setup` writes a default scaffold with empty `build` arrays.

```json
{
  "workspace": {
    "annotationsFile": "repovine.annots.json"
  },
  "build": {
    "scan": { "include": [], "exclude": [] },
    "linking": {
      "handlers": { "searchRoots": [] },
      "bundles": { "scripts": [], "autoDetect": true }
    }
  },
  "mcp": {
    "response": { "mode": "concise", "pretty": false }
  }
}
```

### Full shape (all optional top-level keys)

```json
{
  "workspace": {
    "annotationsFile": "repovine.annots.json"
  },
  "plugins": {
    "defaults": true,
    "add": [],
    "disable": []
  },
  "build": {
    "scan": {
      "include": ["packages/shared/src/types/globals.d.ts"],
      "exclude": ["packages/legacy/**"],
      "maxPackageWorkers": 4
    },
    "linking": {
      "handlers": { "searchRoots": ["services/api/src"] },
      "bundles": { "scripts": ["services/api/scripts/bundle.mjs"], "autoDetect": true }
    }
  },
  "mcp": {
    "verbose": false,
    "response": { "mode": "concise", "pretty": false, "maxChars": 40000 }
  },
  "annotations": {
    "propagation": {}
  },
  "semantic_search_embeddings": true,
  "analyze_architecture": {
    "strictness": "normal",
    "thresholds": {}
  },
  "contextQuality": {
    "enforcement": { "mode": "client" }
  },
  "agents": {
    "roles": {
      "api-owner": { "brief": "docs/roles/api-owner.md", "scope": ["services/api"] }
    }
  }
}
```

`agents.roles` is read by the Delivery Protocol role loader, outside the config schema: each entry names
a repository-relative brief and an optional scope. Field reference:
[delivery-protocol.md](delivery-protocol.md).

### Field reference

#### `workspace`

| Field | Default | Meaning |
|---|---|---|
| `annotationsFile` | `repovine.annots.json` | Repo-root-relative path to shared annotation memory. Commit this file. Override with `REPOVINE_ANNOTATIONS_FILE` for CI/harness runs. Must stay inside the repository (no absolute paths, no `..` escapes). Do not place it under `.repovine/` or paths matched by `build.scan.exclude`. |

**Example — keep annotations next to client config:**

```json
"workspace": {
  "annotationsFile": ".cursor/repovine.annots.json"
}
```

After moving an existing file, update `workspace.annotationsFile`, move the JSON on disk, then validate annotations through the MCP `validate_annotations` tool (or `repovine status`).

#### `build`

Repovine **graph build** pipeline (not app `npm build` / Docker). Two sub-blocks:

- **`build.scan`** — Stage 1: what files become modules and infra in the snapshot.
- **`build.linking`** — Stage 2 hints for resolving code handlers through source paths and bundle maps.

#### `build.scan`

Repo-root-relative **globs** (`*`, `**`, `?`). **`include` wins over `exclude`.** The engine prunes `.repovine/` and common build/test trees ahead of `build.scan`; scan globs cannot re-include them.

| Field | Default | Meaning |
|---|---|---|
| `include` | `[]` | Paths to scan. Overrides `exclude` for matching files. Required for `.d.ts` modules unless otherwise discovered. |
| `exclude` | `[]` | Paths to skip (see [pattern scope](#buildscan-pattern-scope) below). |
| `maxPackageWorkers` | auto | Hard cap on Stage 1 worker pool (`0`/`1` = inline; `>1` = N workers). Unset → calibration advises from prior RSS + current CPU/RAM. When unset here, `REPOVINE_MAX_PACKAGE_WORKERS` applies. |

##### `build.scan` pattern scope

Each `include` / `exclude` entry is either:

- a **string** — repo-root-relative glob; scope defaults to **`all`** (source + infra), or
- an **object** — `{ "path": "<glob>", "scope": "<all|source|infra>" }`.

| `scope` | Applies to | Stage 1 pass |
|---|---|---|
| `all` (default) | Source modules **and** infra files | Both |
| `source` | Source modules only, from every source plugin | Source plugins |
| `infra` | IaC files only (SAM, K8s, Helm, Terraform, Compose, Dockerfile, …) | Infra scan |

**Precedence:** `include` wins over `exclude` for the same path. Ahead of `build.scan`, the engine prunes
`.repovine/`, `.git`, and common build-output and test trees; scan globs cannot re-include them. Base names
(`build`, `out`, `target`, `coverage`, `test`, `tests`, `e2e`, …) prune unconditionally; each source plugin adds
its own (`node_modules`, `dist`, `.venv`, `.aws-sam`, `__tests__`, `cypress`, …) while that plugin is enabled.
Discovery prunes at the directory, so a package manifest inside one of those trees mints no package node either.

**Example — exclude a folder but keep one file; infra-only skip:**

```json
"build": {
  "scan": {
    "exclude": [
      "packages/generated/**",
      { "path": "infra/sam/root-template.yaml", "scope": "infra" }
    ],
    "include": [
      "packages/generated/hand-picked.ts",
      "packages/shared/src/types/ambient-globals.d.ts"
    ]
  }
}
```

**Example — source-only exclude (infra YAML under the path is still indexed):**

```json
"build": {
  "scan": {
    "exclude": [
      { "path": "tools/scratch/**", "scope": "source" }
    ]
  }
}
```

#### `build.linking`

Optional hints for Stage 2 handler resolution. These settings add source search roots and bundle-output maps; they do **not** change what Stage 1 indexes as modules or configure plugin projectors such as image → Dockerfile linking. Leave the blocks empty when workspace paths and conventional bundle-script discovery suffice.

| Block | Field | Default | Meaning |
|---|---|---|---|
| `handlers` | `searchRoots` | `[]` | Extra roots used when resolving deployment handler paths to source modules. |
| `bundles` | `scripts` | `[]` | esbuild/webpack entry scripts whose static handler→source map is parsed. |
| `bundles` | `autoDetect` | `true` | Also scan conventional `scripts/bundle.{js,ts}` and `scripts/build.{js,ts}` locations. |

**Example — fallback linking in a large monorepo:**

```json
"build": {
  "linking": {
    "handlers": { "searchRoots": ["services/api/src"] },
    "bundles": { "scripts": ["services/api/scripts/bundle.mjs"], "autoDetect": true }
  }
}
```

**Full `build` block (scan + linking):**

```json
"build": {
  "scan": {
    "include": ["packages/shared/src/types/globals.d.ts"],
    "exclude": [
      "repovine/examples/**",
      { "path": "infrastructure/sam/template.yaml", "scope": "infra" }
    ]
  },
  "linking": {
    "handlers": { "searchRoots": [] },
    "bundles": { "scripts": [], "autoDetect": true }
  }
}
```

Linking rationale: [DESIGN.md — Graph build linking](../DESIGN.md#graph-build-linking).

#### `mcp`

| Field | Default | Meaning |
|---|---|---|
| `verbose` | `false` | Extra MCP logging (`REPOVINE_VERBOSE=1` forces on). |
| `response.mode` | `concise` | Default tool envelope: `concise` compacts navigation and omits empty sections; `debug` keeps the full payload. Per-call override: `responseFormat: "debug"`. |
| `response.pretty` | `false` in concise, `true` in debug unless set | Pretty-print JSON responses. |
| `response.maxChars` | `40000` | Hard ceiling for serialized `content[0].text`; minimum `1000`. `REPOVINE_MCP_MAX_CHARS` overrides it. |

**Example — local debugging:**

```json
"mcp": {
  "verbose": true,
  "response": { "mode": "debug", "pretty": true, "maxChars": 40000 }
}
```

#### `semantic_search_embeddings`

Top-level boolean. Enables local Hugging Face embeddings for fuzzy NL entry in
`search_context` and for advisory retry suggestions appended to any tool's scope
miss (`scope_unresolved`, or an empty result on a free-text `query:` scope). The
token index (graph nodes + annotation text) is always on.
Design rationale (node cards, fusion, response fields):
[DESIGN.md — Semantic search](../DESIGN.md#semantic-search).

| Field | Default | Meaning |
|---|---|---|
| `semantic_search_embeddings` | peer presence | Unset: follows whether `@huggingface/transformers` resolves. `true` = in-process MiniLM via that peer; `false` = token-only search. |

Left unset, the engine reports `semanticSearch.status: "disabled"` when the peer is absent and
enables embeddings when it is present. Set it explicitly to pin the behaviour:

```json
"semantic_search_embeddings": true
```

Forcing `true` without the peer installed makes the missing dependency an actionable error rather
than a silent fallback to token-only search.

Disable semantic search entirely:

```json
"semantic_search_embeddings": false
```

`@huggingface/transformers` is an **opt-in peer dependency**: installing repovine
does not pull it, because its ONNX runtime weighs ~700 MB. Install it in the
workspace to turn embeddings on:

```bash
npm install @huggingface/transformers
```

The workspace is where repovine looks it up, so this works when the MCP starts through
`npx -y repovine@<version>` (how the client plugins launch it) and repovine itself runs
from the npx cache. Installing it next to repovine works too.

With the flag left at `true` and the package absent, the build warns with the install
command and search runs on the token index. `refresh_context` reports the same state in
`semanticSearch.error`.

The model (`Xenova/all-MiniLM-L6-v2`, full-precision `fp32`, about 91 MB in the
model cache) is fixed — not configurable. It is downloaded to the transformers.js
cache on first use and works offline afterwards. CPU is enough.

Vectors persist in `.repovine/.cache/semantic-index.json`. Every state build —
including `refresh_context` — re-syncs the semantic search index, re-embedding
only cards whose text hash changed and pruning nodes that left the graph. The
cache identity includes the model, resolved `@huggingface/transformers` version,
and inference dtype, so a peer-dependency upgrade cannot silently reuse vectors
from a different runtime. Node cards are truncated deterministically to 1000
characters before tokenization; behavioural annotation fields precede verbose
per-export prose inside that budget. During
`repovine build`, `repovine setup` (builds by default), and MCP cold start, Stage 3 prints an in-place
semantic search embed progress bar on TTY stderr
(`[done/total] semantic search embeddings ████░░ …`) and `get_build_status`
exposes `doneSemanticCards`, `totalSemanticCards`, and `pct` while search
embeddings run.

#### `annotations.propagation`

Controls how upstream code changes propagate into the annotation queue (`staleKind: content` vs `propagation`, domain roll-ups).

Product defaults live in `DEFAULT_PROPAGATION_CONFIG` (`repovine/src/config.ts`). Omit this block in `repovine.config.json` unless a repo needs overrides. Contract hubs are discovered at runtime via `discoverContractHubs()` (graph fan-in, `keyExports`, importance, path heuristics); use `hubModulesExtra` / `hubModulesDeny` only for exceptions.

| Field | Default | Meaning |
|---|---|---|
| `domainStalePolicy` | `path-only` | A domain roll-up hashes the members the author placed there: everything except members an import cluster or a package name pulled in. `all-tags` hashes every member. |
| `packageDomainHardQueue` | `false` | Package domains (e.g. `client-ui`) carry no freshness question with path-only: outside the queue, counted as `unconfirmable` in coverage. |
| `consumerReachMaxDepth` | `32` | Max BFS depth importer → entrypoint. |
| `hubModulesExtra` | `[]` | Force-include hub candidates missed by auto-discovery. |
| `hubModulesDeny` | `[]` | Suppress false-positive auto-detected hubs. |

Propagation-stale is always **entrypoint-bounded**: only on-path importers up to
interpreter entrypoints enter the queue. There is no separate advisory derived channel.

**Entrypoint roots:** propagation seeds `depCone` and `reachesEntrypoint` from interpreter entrypoints using both `moduleId` (routes, pages, file-based frontend) and `handlerModule` (SAM / runtime triggers: `api`, `queue-consumer`, `schedule`, etc.). Backend-only import chains are invisible if `handlerModule` is missing — check `get_entrypoints({ layer: "backend" })` and slice `entrypointRoots.handlerRoots`.

**MCP blast preview:** `get_annotation_status({ view: "propagation-preview", from, includeDomains: true })` returns `{ hard, derived, domains, entrypoints, entrypointRoots?, warnings? }` without writing annotations. `write_annotation` accepts optional `propagationSlice` for audit trails after propagation review.

**Example — optional override only (omit block for defaults):**

```json
"annotations": {
  "propagation": {
    "hubModulesDeny": ["mod:some-noisy-util"]
  }
}
```

#### `analyze_architecture`

Configures read-only architecture **candidate** detectors behind the `analyze_architecture` MCP tool. The engine reports findings; it does not refactor code.

| Field | Default | Meaning |
|---|---|---|
| `strictness` | `normal` | `loose` → more findings; `normal` → calibrated defaults; `strict` → fewer, higher-confidence signals (suppresses weak public-config/authz/storage hints). |
| `thresholds` | merged from strictness | Per-detector numeric overrides merged on top of the strictness profile. |

`minConfidence` on an MCP call is a **post-filter** (0–1), not a config knob.

**Example — stricter security review:**

```json
"analyze_architecture": {
  "strictness": "strict",
  "thresholds": {
    "annotationRisk": {
      "minQualityScore": 6,
      "minQualityScoreByKind": { "api-handler": 7, "service-mgr": 7 }
    },
    "secretConfigBoundary": { "flagGenericPublicAuthEnv": false }
  }
}
```

Supported `thresholds` categories (each has its own knobs — add only what you need):

`duplicateLike`, `godModule`, `godDomain`, `lowCohesion`, `flowConvergence`, `effectSpaghetti`, `propDrillingOrchestration`, `serviceWrapperExplosion`, `uiDomainCoupling`, `routeConvergence`, `annotationRisk`, `unclearArchitecture`, `secretConfigBoundary`, `authorizationPolicyDrift`, `trustBoundaryValidation`, `privilegedClientSideEffect`, `sensitiveBrowserStorage`, `serverClientBoundary`, `sourceDisclosureSurface`, `annotationSecretHygiene`.

`annotationRisk.minQualityScoreByKind` keys: `types`, `ui`, `api-handler`, `adapter`, `service-mgr`, `infra`, `service`, `domain`, `generic`.

#### `contextQuality`

Deterministic reporting of repovine MCP context sessions (Context Session Quality). Common knobs: `enforcement.mode` (`client` | `harness`), per-phase `thresholds` (`explore`/`implement`/`annotate`, each with `threshold`, `warningThreshold`, `minAnchors`, `byteBudget`), `purgeSessionsOnMcpStart`, `retainSessions`, `persistEvents`, `maxRequestEchoes`, `exportSymbolFloodRatio`, `archResponseOversizeBytes`. Advanced tuning (`weights`, `recoveryWindow`, `recoveryDiscount`, `lowConfidenceRejectRatio`, `testPackageRegex`) follows the schema in `src/config.ts`; non-default weights are experimental and context-quality remains advisory until its documented validation bar is met. `REPOVINE_CONTEXT_SESSION_ID` sets a process-wide default `contextSessionId` for every MCP call and takes precedence over per-call ids — a harness sandbox sets it once so all tool responses score under one session. Defaults, scoring model, and lifecycle: [context-quality.md](context-quality.md).

---

## `repovine.domains.json`

Controls how repovine **names and groups** code into domains for `map_context`, scoped queues, and architecture review. Without this file the engine uses built-in path/basename heuristics only.

The top level of the schema is strict. Invalid JSON and unknown top-level keys are
reported on stderr, and the file is ignored for that build. An unknown key inside a
block is dropped, and the rest of the file applies.

### Example (typical monorepo with infra)

```json
{
  "domains": {
    "infra-terraform": { "paths": ["^infra/terraform"] },
    "infra-k8s": {
      "paths": ["^infra/k8s"],
      "aliases": ["infra-kubernetes", "k8s", "kubernetes"]
    },
    "infra-helm": { "paths": ["^infra/helm"] }
  },
  "infra": {
    "excludeSuffixes": ["Alarm", "LogGroup", "MetricFilter", "Dashboard", "Permission"],
    "excludePatterns": []
  },
  "basename": {
    "pascalCase": "reject",
    "files": { "include": [], "exclude": [] }
  },
  "packages": {
    "enabled": true,
    "exclude": ["eslint-config"],
    "rename": { "web-app": "frontend" },
    "merge": { "backend": ["api", "workers"] }
  },
  "structuralDirs": []
}
```

### Field reference

#### `domains`

Canonical domain registry. `paths` are regex strings over repo-relative paths; domains declared here are treated as **protected/heavy** so they stay visible even with few members. `aliases` are alternate query names.

```json
"domains": {
  "billing": { "paths": ["^packages/billing/"], "aliases": ["payments"] }
}
```

`search_context({ "query": "kubernetes" })` resolves to `infra-k8s` when that alias is present under `domains.infra-k8s.aliases`.

#### `infra`

Control inert IaC resources in the graph. Exclusions prevent matching resources
from becoming runtime-resource nodes; committed keep markers preserve reviewed
resources and stop the advisor from proposing them again.

| Field | Default | Meaning |
|---|---|---|
| `excludeSuffixes` | `[]` | Exclude when the resource label ends with the suffix. |
| `excludePatterns` | `[]` | Exclude when the full resource label matches a regex. |
| `keep.suffixes` | `[]` | Keep matching suffixes materialized and suppress matching advisor suggestions. |
| `keep.patterns` | `[]` | Keep matching regexes materialized and suppress matching advisor suggestions. |
| `pruneInert` | `false` | Remove runtime-resource nodes with no load-bearing edge witness; `keep` overrides pruning for matching resources. |

```json
"infra": {
  "excludeSuffixes": ["Alarm", "LogGroup"],
  "excludePatterns": ["^Lambda.*Sg$", ".*Permission$"],
  "keep": {
    "suffixes": ["AuditLogGroup"],
    "patterns": []
  },
  "pruneInert": false
}
```

#### `basename.files`

Override basename-as-domain heuristics. Globs are repo-root-relative; `*` / `**` supported (no brace expansion).

| Field | Effect |
|---|---|
| `include` | These files **always** get a basename domain (overrides PascalCase / promotion checks). |
| `exclude` | These files **never** get a basename domain. |

Examples:

```json
"basename": {
  "files": {
    "include": ["packages/functions/src/*.ts"],
    "exclude": ["**/*"]
  }
}
```

The second form disables basename domains entirely (useful for UI-heavy React repos).

#### `basename.pascalCase`

| Value | Behavior |
|---|---|
| `lightweight` (default) | `AuthButton.tsx` → lightweight domain `authbutton` |
| `reject` | Drop PascalCase basename candidates unless promoted by handler role or import fan-in |

#### `structuralDirs`

Extra directory names treated like built-in structural segments (`src`, `components`, `features`, …) — skipped when inferring path-based domains.

```json
"structuralDirs": ["concerns", "widgets"]
```

#### `packages`

One domain per package (`@scope/foo-bar` → `foo-bar`).

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn package-domain generation off when `false`. |
| `exclude` | `[]` | Package short names to skip. |
| `rename` | `{}` | `{ "old-short-name": "new-label" }` |
| `merge` | `{}` | `{ "canonical": ["pkg-a", "pkg-b"] }` — group packages under one domain |

Heavy vs lightweight: 3+ modules → heavy (visible in search); 1–2 → lightweight (hidden by default).

### Domains advisor

After a graph build, repovine can propose additive changes for this file:

| Source signal | Possible suggestion |
|---|---|
| Repeated infra resource suffixes such as `Alarm`, `LogGroup`, `RolePolicy` | append `infra.excludeSuffixes`; matching runtime-resource nodes are hidden from graph/search/flow |
| Many PascalCase module basenames | set `basename.pascalCase` to `reject` if unset |
| Repeated `infrastructure/<name>/...` roots with no configured domain | add a `domains.<id>.paths` entry; matching modules are tagged with that domain but not moved or merged |

The advisor never edits or deletes existing config. It unions arrays, adds domain
entries only when the id is absent, sets `basename.pascalCase` only when missing,
and never generates aliases, package renames, or package merges.

Delivery:

| Path | Behavior |
|---|---|
| `repovine setup <client> --interactive` (or `-i`) | reviews one suggestion at a time: accept writes the proposed exclusion/domain change; keep-committed writes `infra.keep` for keepable infra suggestions; skip/hide stores the id locally; quit leaves the rest pending |
| setup without `--interactive` | leaves suggestions pending in `.repovine/onboarding-state.json`; the committed file is unchanged |
| MCP / plugin mode | `get_build_status` and `refresh_context` include `domainsSuggestions`; `suggest_domains_config` returns additions, an accept `mergedConfig`, and a `keepConfig` when an infra suggestion is keepable |

Both accept and keep-committed update `repovine.domains.json` and require
`refresh_context`. Accept excludes the suggested noise; keep-committed preserves
it in the graph and records the decision in Git. Skip/hide is workspace-local.

Declines are recorded by `decline_advisory({ "kind": "domains-config" })` in
`.repovine/onboarding-state.json` so they stay local and are not re-offered.

---

## `repovine.annots.json`

**Layer 2 memory** — AI-written notes keyed by graph node id. By default the file lives at the repository root as `repovine.annots.json`. To use another path, set `workspace.annotationsFile` in `repovine.config.json` (see above). Commit the configured file so annotations survive sessions, branches, and agents.

### Top-level shape

```json
{
  "version": 1,
  "annotations": {
    "mod:web-app/src/features/auth/SessionProvider": {
      "contentHash": "a1b2c3…",
      "pass": 2,
      "updatedAt": "2026-01-15T12:00:00.000Z",
      "annotation": {
        "summary": "React context for session state, login/logout, and token refresh.",
        "assumptions": ["API validates JWT server-side"],
        "sideEffects": [
          { "kind": "io-read", "subtype": "http", "description": "GET /api/session" },
          { "kind": "state-global", "description": "React context provider" }
        ],
        "risks": ["Stale token if refresh fails silently"]
      }
    }
  }
}
```

### Disk format conventions

- Valid JSON, but **canonicalized as one annotation entry per line** for reviewable Git diffs.
- The map **key is the node id**; on load the engine infers `nodeId`, `nodeType` (from id prefix), default `pass: 1`, default `schemaVersion: 1`.
- Do **not** hand-edit this file — use MCP tools only (`write_annotation`, `merge_annotations`, `refresh_context` with `cleanupOrphans`). Manual edits corrupt freshness/merge metadata.

Normalize legacy pretty-printed files through the MCP `merge_annotations({})` tool — it rewrites `repovine.annots.json` in canonical one-entry-per-line form.

### Node id prefixes

| Prefix | Node kind | Example |
|---|---|---|
| `mod:` | Code module | `mod:@acme/api/src/auth/session` |
| `infra:` | IaC module | `infra:dockerfile:Dockerfile` |
| `export:` | Exported symbol | `export:@acme/api/src/auth/login` |
| `domain:` | Domain roll-up | `domain:auth` |
| `resource:` | Runtime service | `resource:aws-lambda:UserApiFunction` |
| `template:` | Template/rendered surface | `template:app/templates/home.html` |

### Annotation payload fields

`summary` is required. Optional semantic fields:

`keyExports`, `assumptions`, `sideEffects`, `risks`, `patterns`, `flowDescription`, `invariants`, `extensionPoints`, `integrationPoints`, `stateShape`, `dataFlow`, `envDependencies`, `propagationSlice`.

**`risks`** — either a plain string (local risk) or
`{ "text": "…", "scope": "local" | "consumer" | "boundary" }`.
`consumer` marks an obligation importers must verify; `boundary` marks a surface
importers must not edit in place.

**`propagationSlice`** — optional audit trail for entrypoint-bounded derived
review: `{ anchor, path, entrypointId?, reviewedAt }`.

**`sideEffects`** — structured array `{ kind, subtype?, description? }`. Never write `sideEffects: []` (rejected). Omit the field, or declare zero effects with `[{ "kind": "pure" }]`.

Closed `kind` values: `io-read`, `io-write`, `state-local`, `state-global`, `process`, `concurrency`, `time`, `subscribe`, `external`, `resource`, `pure`.

Design rationale and detector contract: [DESIGN.md — sideEffects vocabulary](../DESIGN.md#sideeffects-vocabulary).

### Freshness

A note goes **stale** when its node's current content hash changes or when `schemaVersion` lags the engine (`staleKind: "content"`): modules use `ModuleInfo.contentHash`, templates use `TemplateFileInfo.contentHash`, runtime resources use the backing `InfraResource.contentHash`, and domains use a roll-up hash of tagged members. **Propagation-stale** (`staleKind: "propagation"`) applies to code modules when `importBaseline` (direct-import contentHash snapshots) differs from the live graph; clear via `write_annotation({ "refreshImportBaseline": true })` or rewrite integration fields when upstream contract changed. Propagation-stale is part of the same `needsWork` backlog (entrypoint-bounded). Removed graph nodes leave **orphaned** notes — prune with `refresh_context({ "cleanupOrphans": true })`.

Merge-review markers (`patterns: ["merge-review:<field>"]` plus matching `[merge-review:…:ours/theirs]` assumptions) are **not** freshness signals — they mean a scalar field was auto-merged during git annotation merge and an agent should rewrite it via `write_annotation`.

### Git merge workflow

After a git merge or rebase:

1. Resolve **code** conflicts in source files first.
2. If the configured annotations file contains conflict markers, call `merge_annotations` + `validate_annotations` — never resolve annotation JSON by hand.

| Merge input | When | `baseSource` |
|---|---|---|
| git index stages `:1:`/`:2:`/`:3:` | file is unmerged (any `merge.conflictStyle`) | `git-index` |
| diff3 `\|\|\|\|\|\|\|` base sections | index is merged, every hunk carries a base section that parses | `conflict-markers-diff3` |
| ours/theirs only, empty base | no base section, or the base does not parse | `none` |

An index-stage merge recomputes the file from the pre-merge blobs, so edits made inside the conflicted worktree file are not merge input. Those bytes are backed up under `.repovine/annotation-backups/` first and the backup is named in `replacedBackupPath`. A base carrying entries invalid under the current schema drops them and reports `baseWarning` — the merge still completes. `baseSource: "none"` always carries a `baseWarning`: without a base, a deletion on one side is indistinguishable from an addition on the other.

Git also resolves some conflicts at file level, leaving the index unmerged with no markers in the worktree: a `binary` or `-merge` attribute, modify/delete, and rename conflicts. The worktree then holds one side only. `merge_annotations` refuses these rather than normalizing the surviving side over the other, and `get_annotation_merge_status` reports `indexUnmerged`. Resolve by merging the stages explicitly, or by staging the worktree copy.

| Situation | Command |
|---|---|
| Merge the index stages (worktree file backed up first) | `merge_annotations({ "fromIndex": true })` |
| The worktree copy is the intended resolution | `git add <annotations path>` |
3. `git add` the configured annotations path, then `refresh_context({})` so the graph matches merged code.
4. If `validate_annotations` reports `counts.mergeReview > 0`, inspect affected nodes and rewrite conflicted fields via `write_annotation` (read both sides from the merge-review assumptions). The auto-merged scalar is a draft, not the final note.

Design rationale: [DESIGN.md — Semantic merge](../DESIGN.md#semantic-merge).

### Local backups

Before overwriting the configured annotations file with a write that would shrink the annotation count by more than 5%, the store copies the previous file beside it as `annotations.backup.<timestamp>.json` and keeps the newest five backups. Conflict-merge snapshots go to `.repovine/annotation-backups/` instead, where the managed `.gitignore` block already covers them. A backup whose content matches a retained one reuses that file. These shrink backups sit beside the configured annotations file, outside the managed `.gitignore` block; add an `annotations.backup.*.json` rule to keep them out of commits.

### Security

Never store secrets in annotations. The engine records env var **names**, not values, and rejects obvious secret values through `write_annotation`.

Annotation trust and lifecycle: [DESIGN.md — Annotations](../DESIGN.md#annotations).

---

## `.repovine/` (local cache and decline state)

Gitignored engine artifacts under `{workspaceRoot}/.repovine/`. The cache under `.cache` is safe to delete when it is corrupt or after upgrading repovine — the next `refresh_context` or `repovine build` rebuilds it. `onboarding-state.json` and `carrier-review.json` hold advisory declines a rebuild does not restore.

`setup` adds a managed block to `.gitignore` for this directory.

### Layout

```text
.repovine/
├── onboarding-state.json              # last ready build's onboarding counters + declined domains suggestions
├── carrier-review.json                # reviewed-not-a-gap carrier-link decisions (riskHash-invalidated)
├── boundary-index.json                # generated pre-edit boundary-risk lookup by source path
├── annotation-backups/                # conflict-merge snapshots of the replaced annotations file
└── .cache/
    ├── repository-facts-snapshot.json         # warm Stage 1 snapshot (incremental rebuilds)
    ├── build-calibration.json          # per-machine worker/shard advice from last cold run
    ├── semantic-index.json             # local graph-node embedding index when enabled
    ├── sessions/                       # Context Session Quality roll-ups
    ├── repository-facts-snapshot-dump.json    # optional full snapshot dump (src/index.ts)
    ├── repovine.json                   # optional {stats,nodes,edges} graph dump (src/index.ts)
    ├── graph.json                      # optional repository graph dump (src/dump/index.ts)
    └── graph.yaml                      # optional repository graph dump (src/dump/index.ts)
```

| File | Purpose |
|---|---|
| `onboarding-state.json` | Gitignored, best-effort SessionStart payload cache written after a successful build/refresh. Mirrors graph-ready counters, annotation/domain onboarding counters, and locally declined domains suggestion ids. Safe to delete; declined suggestions reappear. |
| `carrier-review.json` | Reviewed-not-a-gap decisions from `decline_advisory({ "kind": "carrier-link-gaps" })`, keyed by consumer-risk SSOT target. Each entry stores a `riskHash` (sha256[:16] of the target's sorted consumer-risk texts); a changed risk set re-surfaces the target. Workspace-local — triage does not travel with clones. Safe to delete; reviewed targets re-flag. |
| `boundary-index.json` | Generated path-indexed boundary-risk surface consumed by client pre-edit hooks. Rebuilt from graph and annotations. |
| `annotation-backups/` | Snapshots of the replaced annotations file written by `merge_annotations` when git index stages are the merge input, named in `replacedBackupPath`. Gitignored under `.repovine/`. Safe to delete. |
| `repository-facts-snapshot.json` | Cached Stage 1 output. Invalidated when `STAGE1_ANALYSIS_VERSION` changes. Used by `refresh_context` for fast rebuilds. |
| `build-calibration.json` | Records baseline/peak/incremental RSS, worker/shard shape, and reused/rescanned counts from the last representative cold build. Warm incremental runs leave it intact. Machine-local — do not commit. |
| `semantic-index.json` | Persisted graph-node embedding vectors keyed by node-card hash. Rebuilt incrementally. |
| `sessions/` | Persisted Context Session Quality roll-ups; lifecycle is defined in [context-quality.md](context-quality.md#session-lifecycle). |
| `graph.json` / `graph.yaml` | Written by the graph dump utility (`npx tsx src/dump/index.ts`) for offline inspection — not required for MCP. |

### When to clear

- Build fails with `status:"failed"` from `get_build_status`
- Stale or incompatible cache after a repovine upgrade
- Suspected corruption after interrupted builds

```bash
rm -rf .repovine/.cache
# then restart MCP server or run:
npx repovine build
```

Build performance model: [DESIGN.md — Build model](../DESIGN.md#build-model-and-performance).

---

## Related docs

| Doc | Topic |
|---|---|
| [DESIGN.md](../DESIGN.md) | System boundaries, graph contract, annotation trust model |
| [delivery-protocol.md](delivery-protocol.md) | External harness contracts |
| [scripts.md](scripts.md) | CLI vs npm scripts (`repovine build`, `setup`, …) |
