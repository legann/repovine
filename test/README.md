# Tests

Run from the `repovine/` package root:

```bash
npm test
npm run test:projections
npm run test:coverage
```

`npm test` runs the Jest suites against source. `test:projections` builds first, then runs the
separate `node:test` client-projection contract. Coverage is informational; there is no threshold
gate yet.

The Linux CI gate runs audit, typecheck, lint, build, Jest, client projections, plugin examples, and
packed-install smokes. Native Windows and macOS gates repeat the build, tests, projections, plugin
examples, and packed plugin/install paths on their host filesystems. The Delivery Protocol harness
has its own Linux gate.

## Layout

| Path | What |
|------|------|
| `test/unit/` | Fast, focused tests next to the code they cover (`stage1/`, `mcp/`, `cli/`, …) |
| `test/integration/` | Full pipeline on mini-repo fixtures (stage1 → stage2 → graph/MCP surfaces) |
| `test/laws/` | Cross-cutting executable contracts for determinism, boundaries, delivery, and public APIs |
| `test/cli/` | CLI-level interaction tests kept outside the unit tree |
| `test/fixtures/` | Self-contained sample projects + `expected.json` contracts |
| `test/evals/` | Agent-driven MCP evaluation cards; Markdown corpus, not part of `npm test` |
| `test/helpers/` | Small shared helpers (CLI output, agent metrics) |
| `test/jest.setup.ts` | Global Jest setup: quiet logs, inline Stage 1/2 defaults, and the bundled plugin preset |

Mirror `src/` under `test/unit/` when you can: `src/mcp/…` → `test/unit/mcp/…`.

## Fixtures

`test/fixtures/*` are tiny repos (React SPA, Next.js, SAM, Terraform, Python web, **root-ts-python**, …). Most declare an `expected.json` that integration or parity suites assert against.

**Do not put secrets, tokens, or real customer data in fixtures.** Use redacted names and fake env var *names* only.

| Suite | Checks |
|-------|--------|
| `integration/domain-fixtures.test.ts` | Domain heuristics, module tags, runtime-resource nodes |
| `integration/python-fixtures.test.ts` | Python snapshot/graph contract (`expected.json` → `python`) |
| `integration/root-ts-python-fixtures.test.ts` | Root-level TS + Python with colliding package name (`expected.json` → `polyglot`) |
| `integration/runtime-links.test.ts` | Lambda / K8s / compose runtime linking |
| `integration/pipeline.test.ts` | End-to-end on `basic-typescript` |
| `unit/stage2/__phase6_parity__/graph-projection.test.ts` | Byte-stable MCP graph projection (22 fixtures) |
| `unit/analysis/architecture/detector-registry-parity.test.ts` | Byte-stable `analyze_architecture` output (7 fixtures) |

The same fixture may appear in several suites — they guard **different contracts**, not duplicate work.

### Add a fixture

1. Copy an existing layout under `test/fixtures/<name>/`.
2. Add `expected.json` with the fields your suite reads (`heavyDomains`, `runtimeLinks`, `python`, …).
3. Wire asserts in the matching integration or parity test (or extend an existing `describe.each` harness).

External-plugin coverage spans `integration/external-source-plugin.test.ts`, the packed canaries in
`test/fixtures/canary-plugins/`, and the runnable packages under `examples/`.

## Golden / parity updates

Only regenerate goldens from a **trusted green baseline** (main or your branch with passing tests).

```bash
# MCP graph projection (stage2 / layer lift-and-shift)
PHASE6_UPDATE=1 npm test -- --runTestsByPath test/unit/stage2/__phase6_parity__/graph-projection.test.ts

# Architecture detector output
UPDATE_PARITY_GOLDEN=1 npm test -- --runTestsByPath test/unit/analysis/architecture/detector-registry-parity.test.ts
```

Review the JSON diff in the PR like any other behavior change.

## Run one file

```bash
npm test -- --runTestsByPath test/unit/mcp/semantic-search.test.ts
npm test -- --watch --runTestsByPath test/unit/stage1/packages.test.ts
```

## Python

Some tests need a `python3` on `PATH` (`detectPython()`). If Python is missing, `test/unit/source-plugin/python.test.ts` skips interpreter-dependent cases; `integration/python-fixtures.test.ts` skips the whole suite.

## Adding a test

- **Pure logic** (parsers, config, helpers): unit test with in-memory inputs or a temp dir (`fs.mkdtempSync`).
- **Graph / domains / linking behavior**: prefer an integration fixture + `expected.json` over a huge inline graph.
- **MCP tool behavior**: `test/unit/mcp/handlers.test.ts` is the main contract suite today; smaller files (`semantic-search.test.ts`, `refresh-context.test.ts`, …) cover subsystems.

No coverage gate or test tiers yet — keep new tests close to the code they protect and fast enough for `npm test` on a laptop.
