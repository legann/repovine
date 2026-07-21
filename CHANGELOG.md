# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-05-25

Initial public release.

### Added

**Repository graph** — packages, modules, exports, imports, domains, services, entrypoints, config surface, runtime/resource links, and dependency edges over TypeScript/JS, Python, and infra-only repositories. A post-composition integrity gate checks that every Stage 1 record projects to a node and no edge dangles — warns by default, throws under `REPOVINE_DEV`.

**Annotations** — AI semantic annotations in `repovine.annots.json` with freshness/quality reporting, a unified bottom-up queue across modules, services, infra, and domains, orphan detection, and semantic merge for conflicted annotation files. Writes persist through a single-writer debounced save chain: concurrent edits to different fields of one node merge at field granularity, a save fails closed rather than overwrite a file changed externally to a conflicted state, and shutdown drains pending saves before exit. `write_annotation` reports persistence state and accepts `durable: true` to block on the disk flush.

**Carrier-link advisories** — `validate_annotations` flags missing-carrier-link candidates: runtime 2-hop delegation chains (`I → M → T`, both hops value imports) to consumer-risk SSOTs not named in the importer's `integrationPoints`. `get_annotation_status({ "view": "carrier-gaps" })` pages candidates grouped by SSOT target with reviewed state. `decline_advisory` records reviewed-not-a-gap decisions in workspace-local `.repovine/carrier-review.json`; each decision stores a `riskHash` of the target's consumer risks, so a changed risk set re-surfaces the target, and `suppressedTargets` keeps a fully-suppressed repo auditable.

**Investigate tags** — `inspect_node` flags a 1-hop ref worth inspecting before treating its target unchanged. Annotation-sourced tags: `risk` (consumer-scoped risk), `boundary` (off-limits surface), `effect` (persistent side effect). Topology-sourced tags read graph edges: `wiring` (runtime `infra` in-edge or `binds_to` out-edge — deployed topology dispatches into or binds from the node), `co-change` (either side of an `implements` edge). `hub` fires on import in-degree. Obligation tags hoist to a top-level `attention` block; `hub`/`wiring`/`co-change` stay inline, capped at 2 refs each. A runtime-wired node also gets a self `attention` item naming its resources with a `trace_flow` bridge.

**MCP server** — 18 public context tools:
- Context: `search_context`, `map_context`, `inspect_node`, `get_entrypoints`, `trace_flow`, `analyze_dependencies`, `get_config_surface`, `analyze_architecture`
- Annotations: `get_annotation_status`, `get_annotation_merge_status`, `merge_annotations`, `validate_annotations`, `write_annotation`
- Domains advisor: `suggest_domains_config`
- Advisory declines: `decline_advisory` (kind: `domains-config` | `carrier-link-gaps`; workspace-local state)
- Sync & quality: `refresh_context`, `get_context_session_quality`, `get_build_status` (`waitSec` long-poll returns when the build settles)

**Semantic search** — local embeddings augment `search_context`: graph node cards are embedded with a local MiniLM model (`all-MiniLM-L6-v2`, 384-dim, via `@huggingface/transformers` on CPU) and fused with the deterministic token index. Brute-force cosine over normalized vectors, no vector database; the index is cached under `.repovine/.cache` and re-embedded incrementally by card hash. On by default; toggle with `semantic_search_embeddings`.

**Agent Protocol v1** — harness-facing contract for verifiable agent runs: `AgentAssignment` → `AgentRunResult` → `AgentComplianceReport`. Zod-authoritative schemas, six built-in role manifests (utility agents are `repovine-*` prefixed), two-layer validation (schema + observable repo state), harness strict vs client advisory enforcement. **CLI-only integration surface:** `repovine agents protocol`, `manifests`, `validate-assignment`, `validate-result`, `compliance`, `run-brief`, `session-quality`. Integration guide: [docs/agent-protocol.md](docs/agent-protocol.md).

**Client assets** — `repovine setup {cursor|claude|codex|all}` projects MCP config, hooks, rules, skills, managed agents, and the marked `AGENTS.md` section from the same manifests. Drift checks: `repovine doctor` (human) or `repovine doctor --json` (CI).

**CLI & server** — `setup`, `build`, `status`, `doctor`, `clear`, `agents`; `setup` builds the graph by default (`--no-build` defers to first MCP start). MCP over stdio only in v1.

**Language & framework extraction** — framework-aware for React, Next.js, Remix, Nuxt, SvelteKit, Angular, NestJS, serverless monorepos, and Vue/Svelte/Astro SFCs; built-in source adapters for TypeScript/JS and Python, with additional languages/formats addable as `@repovine/plugin-sdk` plugins.

**IaC indexing** — SAM/CloudFormation, Terraform, Kubernetes, Helm, Dockerfile, docker-compose, and Vercel, through a plugin contract; infra-only repos build a graph without source packages.

**Architecture analysis** — review candidates for duplication, boundary issues, frontend state/effect problems, UI-domain coupling, route/flow convergence, annotation risk, and security-sensitive boundaries, with strictness profiles and per-knob overrides. The report fails loud on an empty detector registry instead of silently returning no findings.
