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

## Scope

| In scope | Out of scope |
| --- | --- |
| repovine source in this repository | Compromise of the host running repovine (OS, shell, filesystem, credentials on the machine) |
| The published `repovine` and `@repovine/plugin-sdk` npm packages | Coding agents and MCP clients that consume repovine |
| Direct dependencies repovine pins and ships in its tarball | Transitive advisories repovine cannot reach or fix (see Known audit findings) |
| The MCP tool surface served over stdio | Third-party plugins not maintained in this repository |

### Plugin trust boundary

Configured plugins are executable dependencies: repovine loads their entrypoints in its own
process. Manifest, conformance, and emitted-fact validation constrain the contract and output shape;
they do not sandbox plugin code. Install and enable only trusted plugin packages.

## Secrets and repository data

The engine records environment-variable names, not their values, and
`write_annotation` rejects obvious secret values. Even with those safeguards,
do not put tokens, `.env` values, credentials, or customer data in annotations,
fixtures, logs, issues, or vulnerability reproductions. Redact sensitive values
before sharing supporting material.

## Known audit findings

`npm audit` reports one advisory in the development install through the optional
embedding peer. It is allowlisted in `scripts/audit-gate.mjs`; `npm run
audit:check` accepts that advisory and fails on any new one. The Delivery
Protocol harness demo carries its own lockfile and runs the same gate in CI; its
dependency tree currently audits clean.

| Advisory | Package (path) | Status |
| --- | --- | --- |
| [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) | `sharp` via `@huggingface/transformers` | libvips image-decode CVEs. `@huggingface/transformers` is an optional peer used for text embeddings; the image path is never invoked. The fix needs `sharp` >= 0.35; no transformers release adopts it. |

`@huggingface/transformers` is an optional peer, so the `sharp` advisory is
absent from the production tree and `npm audit --omit=dev` reports no findings.
