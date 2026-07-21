# Benchmarks: Complete Changes With Controlled Scope

The benchmark tasks are grouped into two classes:

- **Correctness (change completeness)** — every change required for the requested behavior is present, including related code, stored data, configuration, and infrastructure.
- **Restraint (scope control)** — the requested change is present and protected surfaces outside task scope remain unchanged.

## Results

The published corpus contains four cases, three models, two arms, and ten runs per model–case–arm cell: **240 runs** and **12 model–case comparisons**. Each case defines a gate over the final diff. One run passes when its final diff satisfies that gate; **10/10** means that all ten runs in one arm of a model–case comparison passed.

The Repovine arm has a higher pass count in all 12 comparisons. Across the full corpus, **108/120 individual Repovine runs (90.0%)** pass and **15/120 baseline runs (12.5%)** pass.

The headroom subset includes cells with a baseline score of at most 8/10. It excludes the `sonnet-5` Archestra restraint cell, where the baseline passes 9/10 runs and Repovine passes 10/10. Across the included 11 comparisons, **98/110 individual Repovine runs (89.1%)** pass and **6/110 baseline runs (5.5%)** pass.

Each model cell lists passed runs for both arms. Cases are grouped by class and ordered `archestra-ai`, then `elastic/kibana`.

| Repository | Benchmark | Class | `sonnet-5` | `opus-4.8` | `fable-5` |
|---|---|---|---|---|---|
| `archestra-ai` | [tool-name slug](restraint/archestra-restraint-tool-slug/README.md) | restraint | Baseline: 9/10<br>**Repovine: 10/10** | Baseline: 0/10<br>**Repovine: 10/10** | Baseline: 0/10<br>**Repovine: 10/10** |
| `elastic/kibana` | [frozen validator consumer](restraint/kibana-restraint-frozen-consumer/README.md) | restraint | Baseline: 4/10<br>**Repovine: 10/10** | Baseline: 1/10<br>**Repovine: 10/10** | Baseline: 1/10<br>**Repovine: 10/10** |
| `archestra-ai` | [web-crawler URL identity](correctness/archestra-correctness-web-crawler-url-identity/README.md) | correctness | Baseline: 0/10<br>**Repovine: 7/10** | Baseline: 0/10<br>**Repovine: 7/10** | Baseline: 0/10<br>**Repovine: 10/10** |
| `elastic/kibana` | [mapped-params migration](correctness/kibana-correctness-mapped-params-migration/README.md) | correctness | Baseline: 0/10<br>**Repovine: 7/10** | Baseline: 0/10<br>**Repovine: 7/10** | Baseline: 0/10<br>**Repovine: 10/10** |

## Study design

Each case runs the same task at the same repository pin in two conditions. The baseline uses the repository's native instructions, skills, documentation, and agent tools. The Repovine arm uses the same native environment with Repovine `0.1.0` enabled under the setup published for the case.

Runs use `sonnet-5`, `opus-4.8`, and `fable-5` under Claude Code at configured max effort (`--effort max`, ultracode), with N=10 per arm and model. The published environment records Repovine `0.1.0` and the Claude Code `1.2` line; the exact per-run client build was not retained.

The primary effectiveness measure is the case-specific diff-gate pass rate. Each case defines a structural predicate over the final diff.

## Claim scope and evidence

The claim covers the use of Repovine `0.1.0` on these four cases. N=10 provides repeated observations within each fixed model–arm setup, and each task class appears once per repository. Population-level reliability across repositories and tasks, converting-seam density, token usage, latency, cost, and production readiness beyond each gate remain unmeasured.

Benchmark validity is grounded in evidence available to both arms in the pinned repositories. Each case supports its gate with existing tests, repository documentation, migration precedents, or traceable code behavior: [tool-name slug](restraint/archestra-restraint-tool-slug/README.md#validity), [frozen validator consumer](restraint/kibana-restraint-frozen-consumer/README.md#validity), [web-crawler URL identity](correctness/archestra-correctness-web-crawler-url-identity/README.md#validity), and [mapped-params migration](correctness/kibana-correctness-mapped-params-migration/README.md#validity).

Each case publishes the task, gate, annotation, per-run facts, validity analysis, and 60 redacted transcripts. The transcripts omit upstream source and submitted code under the [redaction rules](METHODOLOGY.md#redaction); licensing details are in [License](#license). [METHODOLOGY.md](METHODOLOGY.md) also defines scoring, one-shot session boundaries, and the Fisher exact convention. [REPRODUCIBILITY.md](REPRODUCIBILITY.md) records the runtime envelope and rerun procedure. [manifest.json](manifest.json) contains the machine-readable corpus inventory.

## License

The benchmark text, scoring, predicates, and analysis are part of repovine and licensed MIT (© 2026 legann). The analyzed projects retain their own licenses.

No upstream source is redistributed. Published artifacts are derived structural predicates and redacted transcripts; only file paths and symbol identifiers (such as functions, methods, types, fields, and constants) are retained where needed for research identification, with source behavior described in prose. Exact source-derived values, expressions, signatures, and layouts are removed; experiment-authored prompts remain exact. To obtain the analyzed code, clone each project from its source under that project's own license.

| Project | License |
|---|---|
| `elastic/kibana` | triple license per file header — AGPL-3.0-only / SSPL-1.0 / Elastic License 2.0; code under `x-pack` (where the synthetics plugin lives) is triple or Elastic License 2.0 only |
| `archestra-ai` | AGPL-3.0-only by default; Enterprise regions under `LicenseRef-Archestra-Enterprise` (proprietary), marked by SPDX header or `ee/` path |

Each project's license governs its own source. This work asserts no license over it.

repovine and these benchmarks are not affiliated with, sponsored by, or endorsed by Elastic N.V. or Archestra Inc. `Kibana`, `Elastic`, and `Archestra` are trademarks of their respective owners, named here for identification only.
