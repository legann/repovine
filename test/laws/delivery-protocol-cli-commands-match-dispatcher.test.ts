import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { Node, SyntaxKind } from 'ts-morph';
import { DELIVERY_PROTOCOL_CLI_COMMANDS } from '../../src/agents/protocol.js';
import { findRepovineRoot, makeProject } from './core-schema.js';

// Law: the declared CLI command list matches the command the dispatcher actually switches on.
//
// `DELIVERY_PROTOCOL_CLI_COMMANDS` is the harness-facing list of `repovine agents <cmd>` commands, built
// into the protocol descriptor. The dispatcher that serves them is a `switch (command)` in
// runAgentsCli, whose case labels are the real command set. Nothing tied the two: a command could be
// renamed in the switch, or added to the list, and the other side would not notice. This reads the
// case labels from source (the same ts-morph route core-schema uses for the graph producers) and the
// declared list, then asserts set-equality after stripping the shared `agents ` prefix.

/** The string literals of every `case` in the `switch (command)` of runAgentsCli. */
function dispatcherCommands(): Set<string> {
  const root = findRepovineRoot();
  const project = makeProject(root);
  const sourceFile = project.addSourceFileAtPath(path.join(root, 'src', 'cli', 'agents.ts'));
  const fn = sourceFile.getFunctionOrThrow('runAgentsCli');

  const commandSwitch = fn
    .getDescendantsOfKind(SyntaxKind.SwitchStatement)
    .find((node) => node.getExpression().getText() === 'command');
  if (!commandSwitch) throw new Error('runAgentsCli has no `switch (command)` — the dispatcher moved');

  const commands = new Set<string>();
  for (const clause of commandSwitch.getClauses()) {
    if (!Node.isCaseClause(clause)) continue; // skip the default clause
    const expression = clause.getExpression();
    if (Node.isStringLiteral(expression)) commands.add(expression.getLiteralText());
  }
  return commands;
}

/** The declared list, with the `agents ` command-group prefix the switch does not carry stripped. */
function declaredCommands(): Set<string> {
  return new Set(DELIVERY_PROTOCOL_CLI_COMMANDS.map((entry) => entry.replace(/^agents /, '')));
}

describe('core-laws the declared agent CLI commands match the dispatcher', () => {
  it('every DELIVERY_PROTOCOL_CLI_COMMANDS entry is prefixed `agents `', () => {
    for (const entry of DELIVERY_PROTOCOL_CLI_COMMANDS) {
      expect(entry.startsWith('agents ')).toBe(true);
    }
  });

  it('the declared list equals the dispatcher case set', () => {
    const dispatcher = dispatcherCommands();
    expect(dispatcher.size).toBeGreaterThan(5);
    expect([...declaredCommands()].sort()).toEqual([...dispatcher].sort());
  });
});
