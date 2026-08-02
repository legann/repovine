# Security Policy

## Supported versions

repovine is currently in preview. Security fixes are provided for the latest
`0.1.x` release only.

| Version | Supported |
| --- | --- |
| Latest `0.1.x` | Yes |
| Earlier releases | No |

## Reporting a vulnerability

Please email suspected vulnerabilities to
[oleg.kordn@gmail.com](mailto:oleg.kordn@gmail.com) with `[SECURITY] repovine` in
the subject. Do not open a public issue, discussion, or pull request with
vulnerability details or sensitive data.

Include the affected version, impact, reproduction steps, and any suggested
mitigation. We will acknowledge the report within three business days, provide
an initial assessment within seven calendar days, and send status updates at
least every seven calendar days until the report is resolved or closed.

## Secrets and repository data

The engine records environment-variable names, not their values, and
`write_annotation` rejects obvious secret values. Even with those safeguards,
do not put tokens, `.env` values, credentials, or customer data in annotations,
fixtures, logs, issues, or vulnerability reproductions. Redact sensitive values
before sharing supporting material.

## Known audit findings

`npm audit` reports transitive advisories that repovine cannot fix and does not
expose. They are allowlisted in `scripts/audit-gate.mjs`; `npm run audit:check`
passes them and fails on any new advisory.

Do not run `npm audit fix --force`: it downgrades `@modelcontextprotocol/sdk`
from 1.29.0 to 1.24.3 — a breaking major downgrade to a release predating the
SDK's HTTP transport — and does not fix `sharp`.

The Delivery Protocol harness demo (`examples/delivery-protocol-harness-demo`) carries its own lockfile
and is gated by the same script and allowlist: the `harness-linux` CI job runs
`audit-gate.mjs` in the demo directory. The `@hono/node-server` advisory reaches
the demo through the same `@modelcontextprotocol/sdk` pin (a peer of
`@anthropic-ai/claude-agent-sdk`); the harness runtime is a Linux container and
speaks MCP over stdio, so the Windows `serve-static` path is unreachable there
too.

| Advisory | Package (path) | Status |
| --- | --- | --- |
| [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9) | `@hono/node-server` via `@modelcontextprotocol/sdk` | Path traversal in `serve-static` on the HTTP transport (Windows). repovine runs over stdio; the HTTP path is unused. The fix needs `@hono/node-server` >= 2.0.5; the MCP SDK pins `^1.19.9`. Clears when the SDK adopts node-server 2.x. |
| [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) | `sharp` via `@huggingface/transformers` | libvips image-decode CVEs. `@huggingface/transformers` is an optional peer used for text embeddings; the image path is never invoked. The fix needs `sharp` >= 0.35; no transformers release adopts it. |

`@huggingface/transformers` is an optional peer, so the `sharp` advisory is
absent from the production tree — `npm audit --omit=dev` reports only the
`@hono/node-server` finding.
