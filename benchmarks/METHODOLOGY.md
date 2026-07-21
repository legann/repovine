# Methodology

This document defines the experimental design, scoring, statistical reporting, redaction, and validity controls for the benchmarks. Results and corpus counts are published in [README.md](README.md) and [manifest.json](manifest.json). Runtime and rerun details are published in [REPRODUCIBILITY.md](REPRODUCIBILITY.md).

## Terms

| Term | Meaning |
|---|---|
| arm | a run condition: Baseline or Repovine |
| seam | the repository relationship exercised by a case |
| Target | a surface the task requires changing |
| Frozen | a versioned, published, or shared surface protected by a restraint gate |
| Judgment call | a surface neither required nor protected by the gate |
| gate | the case-specific pass/DQ predicate over the final diff |
| DQ | disqualified: the final diff fails the gate |
| over-reach | an edit to a Frozen surface |
| placement | the implementation surface selected by the run |
| pin | the fixed upstream commit used by a case |

Correctness cases define **C1**, the requested behavior, and **G1**, the required related update scored by the gate.

## Experimental design

| Arm | Environment |
|---|---|
| Baseline | the repository's native instructions, documentation, skills, and agent tools |
| Repovine | the same native environment with Repovine `0.1.0` enabled under the setup published for the case |

Within each model–case comparison, both arms use the same repository pin, task prompt, deliverables, model, effort setting, and native repository environment. Every run starts in a clean worktree with a fresh agent context and disabled cross-run memory. Baseline runs make zero Repovine tool calls.

The comparison measures Repovine as a whole. Component-level effects are outside the current design.

Repository-native guidance is held constant:

- Archestra provides `platform/AGENTS.md`, `platform/CLAUDE.md`, and eight `archestra-dev-*` skills to both arms. Repovine-generated root bootstrap files belong to the Repovine treatment.
- Kibana provides its native root `AGENTS.md`, root `CLAUDE.md`, `dev_docs`, and approximately 30 native skills to both arms.

The exact model identifiers, client version line, Repovine version, effort setting, repository pins, and run counts are recorded in [REPRODUCIBILITY.md](REPRODUCIBILITY.md) and [manifest.json](manifest.json).

## Case publication schema

Each case README publishes the evidence required to understand and audit the case.

| Content | Requirement |
|---|---|
| Setup | repository pin, models, arms, effort, scoring summary, and native context |
| Repository evidence | tests, documentation, migration precedents, or traceable code behavior available to both arms |
| Seam and surfaces | requested target, required related updates, protected surfaces, and relevant readers or consumers |
| Task | the exact prompt used in both arms |
| Repovine setup | the setup and annotation published for the case |
| Gate | the structural pass/DQ predicate over the final diff |
| Results | per-run facts, model-level counts, and Fisher values |
| Logs | 60 redacted transcripts per case |
| Validity | arm parity, source reach, gate basis, controls, and limits |

Restraint cases use a Frozen-surface gate. Correctness cases record C1 separately and use G1 as the discriminating gate. Cases may also describe observed implementation paths and source reachability.

## Scoring and published records

Scoring uses the complete final worktree diff, including tracked and untracked files. One run passes when its final diff satisfies the case-specific gate. The primary effectiveness measure is the fraction of runs that pass.

| Class | Pass predicate | DQ predicate |
|---|---|---|
| Restraint | the requested change is present and every Frozen surface remains byte-identical to the pin | any Frozen surface changes |
| Correctness | C1 is present and the final diff implements the related update defined by G1 | C1 is absent or the required G1 update is absent |

Each published run record contains controlled structural facts:

```text
run: <id>
arm: <baseline|repovine>
required behavior: <present|absent>
related update: <present|absent|not-applicable>
placement: <target|frozen|other>
gate: <pass|DQ>
```

Every transcript header records the case, arm, run number, model, effort, and gate verdict. The gate line is publication metadata derived from the audited final diff.

## Statistical reporting

### Fisher exact convention

Each model–case comparison uses a 2×2 table with Repovine and Baseline as rows and pass and DQ as columns. The reported exact conditional Fisher p-value uses the one-sided alternative **Repovine > Baseline**. Values use three significant figures and `e` notation below 0.001.

The 12 model–case p-values are exploratory and unadjusted for multiple comparisons. Raw pass counts and the complete matrix are the primary results.

### Headroom rule

The descriptive headroom aggregate includes model–case comparisons whose baseline arm passes at most 8/10 runs. This rule depends only on the baseline count. It affects the descriptive aggregate and leaves every case table and Fisher comparison unchanged.

## One-shot session policy

One run consists of one task prompt submitted to one fresh model session. The model works autonomously until it returns its final worktree diff. The harness supplies no evaluator verdict, hidden-test feedback, manual hint, follow-up prompt, or post-run repair. Human reviewers do not select or rewrite model edits before scoring.

Within the session, the model may inspect the repository, run tests or checks, create temporary verification files, observe results, and revise its implementation. These actions remain visible in the redacted transcript. Temporary files are accepted when absent from the final diff.

The task prompt prohibits test-file additions and modifications in the final deliverable. Scoring uses the complete diff captured at the end of the session.

## Redaction

Redaction applies recursively to tool inputs, tool outputs, model reasoning, final reports, graph-derived content, and case READMEs. Repovine-derived fields receive the same treatment as native file reads and searches.

Published artifacts remove source-bearing material:

- file-read and search-result contents, signatures, type bodies, member layouts, exact values, and bulk symbol inventories;
- diff hunks, edit payloads, and submitted source code;
- shell payloads, SQL, scripts, source-bearing command output, and executable code blocks;
- exact assignments, calls, object literals, lambdas, conditions, regular expressions, and inline source fragments.

Published artifacts retain tool names, file paths, symbol identifiers, gate labels, aggregate counts, behavioral descriptions, experiment-authored prompts, and publication metadata. Removed fragments receive a descriptive marker such as `[source omitted: path/to/file; function normalizeUrl; inspected identity normalization]`. Blocks that reconstruct source are omitted in full. Licensing details are in [README.md#license](README.md#license).

## Validity controls

| Dimension | Control or limit |
|---|---|
| Arm parity | both arms share the pin, prompt, model, effort, deliverables, and native repository environment; the Repovine treatment defines the experimental condition |
| Repository grounding | both arms can reach the pinned-repository evidence needed to derive the required update or protected boundary; each case cites existing tests, documentation, migration precedents, or traceable code behavior |
| Annotation content | annotations state repository facts, coupling, persisted state, and consequences; each case applies a leak guard to exclude an implementation recipe |
| Gate construction | gates are structural predicates scored from the complete final diff and remain independent of model narration |
| Product attribution | the comparison estimates the effect of using Repovine; component-level attribution remains unmeasured |
| Inference scope | the corpus contains one case per task class and repository with N=10 per fixed model–arm setup; population-level reliability and converting-seam density remain unmeasured |

The `Validity` section in each case README cites the concrete evidence and case-specific limits.

## Evidence and reruns

The published evidence consists of redacted transcripts, exact prompts, repository pins, annotations, gate predicates, per-run structural facts, and gate metadata. A complete run diff supports re-derivation of its verdict. The public evidence supports inspection of the chain from task to predicate, run facts, and verdict.

[REPRODUCIBILITY.md](REPRODUCIBILITY.md) records the runtime envelope and manual rerun procedure. A rerun applies the published pin, prompt, arms, and gate to a newly executed set of model sessions.
