# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-07-25

Initial public preview release.

### Added

**Repository graph and context tools** — a language-agnostic graph of packages, modules, exported symbols, domains, templates, entrypoints, configuration, runtime resources, and their relationships. MCP tools support navigation, dependency impact, runtime-flow tracing, configuration discovery, architecture review, and graph maintenance.

**Language and infrastructure coverage** — first-class TypeScript/JavaScript extraction, partial Python extraction, supported framework semantics, and selected SAM/CloudFormation, Terraform, Kubernetes, Helm, Dockerfile, docker-compose, and Vercel resources. Repositories containing supported IaC can be indexed without a source project. See [supported stacks](README.md#supported-stacks).

**Semantic context** — Git-versioned annotations with freshness, validation, merge, and review guidance. Deterministic token search works locally by default; optional local embeddings improve fuzzy retrieval without requiring a database.

**Client integration and CLI** — setup for Cursor, Claude Code, and Codex, including MCP configuration, skills, hooks, agents, and instructions. The CLI provides setup, graph build, status, diagnostics, and cleanup commands.

**Delivery Protocol v1** — a harness/CI contract for structured assignments, agent results, and compliance reports grounded in observable repository state. The release includes protocol and validation CLI surfaces plus a runnable [LangGraph harness demo](examples/delivery-protocol-harness-demo). See the [integration guide](docs/delivery-protocol.md).

**Plugin SDK preview** — `@repovine/plugin-sdk@0.1.0` and runtime `apiVersion: 1` expose public fact-producing contracts for built-in and third-party source and IaC plugins while core retains graph identities and ontology. See the [plugin authoring guide](docs/plugin-authoring.md).

**Tier-1 platforms and distribution** — the package, CLI, stdio MCP server, client integration, and optional semantic search support Linux x64, Windows x64, and macOS arm64. npm and MCP Registry distribution metadata are included. See [platform support](docs/platform-support.md).

### Notes

- Requires Node.js 22 or later.
- MCP uses stdio transport only in v1.
- The Plugin SDK is preview; pin its exact version and consult release notes before upgrading.
- Python and IaC coverage are partial and expand through plugins.
- Optional semantic embeddings download a model into the local cache on first use.
