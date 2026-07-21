---
requireContractsWhenFilesChanged: true
implementerRoles: backend, infra, frontend, default
---

# Policy

This file configures **inter-sub-agent handoff inside one multi-agent run**. It is not the product-continuation or greenfield policy; planner rules own task decomposition and workspace-state decisions.

repovine **annotations** are **durable graph memory** — summaries, sideEffects, risks, integration points. Use them via MCP whenever they help (within this run or later).

**AgentRunResult** fields (`summary`, `filesChanged`, `contractsChanged`, `blockers`) are what the **orchestrator threads** to the next sub-agent in the same multi-agent run. Emit `contractsChanged` for facts a sibling must not miss; do not substitute annotation-sync prose for that.

Treat `contractsChanged` as a delta ledger, not a replacement product spec. Mark facts as ADDED/CHANGED/UNCHANGED/REMOVED when useful; REMOVED requires explicit user intent or a blocker.

The orchestrator injects prior sub-agents' structured output into the next assignment — it does not infer stack-specific facts. Sub-agents must verify ambiguous handoff facts through repovine before changing code.

The orchestrator may append authoritative harness sections to a task: a harness tree-diff (the observed change set; it overrides self-reported filesChanged), the repovine orient context, and graph memory obligations for verification. Treat these sections as ground truth.

# Template interSubAgentSection

## Inter-sub-agent handoff (structured output from prior sub-agents)

{{contracts}}

## Prior sub-agents

{{priorPhases}}

# Template constraintImplementer

You are the {{role}} sub-agent. In AgentRunResult emit structured handoff: **summary** (what you did), **filesChanged**, **contractsChanged** (string[] — delta facts the next sub-agent needs; mark ADDED/CHANGED/UNCHANGED/REMOVED when useful), **blockers** if any. The orchestrator threads these to siblings; use repovine annotations for extra graph context when useful — but annotation sync alone is not a substitute for **contractsChanged**.

# Template constraintReview

You are the review sub-agent. Validate prior sub-agents' contractsChanged and filesChanged for cross-stack consistency; when a harness tree-diff section is present it is the authoritative change set. Report blockers — do not edit files.

# minimalExample

- One string per delta fact the next sub-agent must know (route, response shape, shared type path, port, env var name, client convention)
- Use ADDED/CHANGED/UNCHANGED/REMOVED prefixes when helpful; REMOVED must cite explicit user intent or become a blocker
- Example shape only — replace with what YOU actually changed
