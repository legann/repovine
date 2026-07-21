# Runnable examples

These examples exercise repovine extension and integration contracts. They are
reference implementations, not additional supported product surfaces; each
example owns its setup and verification instructions.

## Plugin authoring

| Example | Demonstrates | Requirements |
|---|---|---|
| [Go source plugin](repovine-plugin-go) | A third-party language producer that emits packages, modules, imports, exports, and route hints without changing the core graph. | Build repovine; no Go toolchain or external package is required. |
| [IaC plugin](repovine-plugin-iac) | A third-party infrastructure producer whose facts become runtime resources, entrypoints, and graph edges through core projection. | Build repovine; no external package is required. |

Both examples include an optional author runner for SDK conformance and
integration checks. The runners verify the examples; they are not required to
install or use a plugin. Start with the [plugin authoring
guide](../docs/plugin-authoring.md) for the public contracts and publishing flow.

## Agent Protocol and harnesses

| Example | Demonstrates | Requirements |
|---|---|---|
| [Agent Harness Demo](agent-harness-demo) | A live LangGraph harness with provider adapters, sandboxed workers, retries, channels, review, and compliance gates. | Docker for the isolated path, or a local Node setup; provider credentials for live agents. |

Use the LangGraph demo when evaluating a complete external orchestration flow.
The deterministic CLI contract, including rejection of false graph-node claims,
is covered by the
[Agent Protocol blackbox test](../test/integration/agent-protocol-cli-blackbox.test.ts).
repovine defines the protocol and validators; the harness is not part of repovine core.

## Illustrative documentation

For a compact, non-runnable walkthrough of the graph, domains, and annotations,
see the [TODO app walkthrough](../docs/walkthroughs/todo-app.md).
