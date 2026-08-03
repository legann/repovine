import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { Node, SyntaxKind } from 'ts-morph';
import { DELIVERY_PROTOCOL_CLI_COMMANDS } from '../../src/agents/protocol.js';
import { findRepovineRoot, makeProject } from './core-schema.js';

// Law: the declared CLI command list matches the command the dispatcher actually switches on.
//
// `DELIVERY_PROTOCOL_CLI_COMMANDS` is the harness-facing list of `repovine delivery <cmd>` commands,
// built into the protocol descriptor. The dispatcher that serves them is a `switch (command)` in
// runDeliveryCli, whose case labels are the real subcommand set. The bare `delivery` entry is the
// descriptor itself — served before the switch, so it has no case label. Nothing else tied the two:
// a subcommand could be renamed in the switch, or added to the list, and the other side would not
// notice. This reads the case labels from source (the same ts-morph route core-schema uses for the
// graph producers) and the declared list, then asserts set-equality after stripping the shared
// `delivery ` prefix and the bare descriptor entry.

/** The string literals of every `case` in the `switch (command)` of runDeliveryCli. */
function dispatcherSubcommands(): Set<string> {
  const root = findRepovineRoot();
  const project = makeProject(root);
  const sourceFile = project.addSourceFileAtPath(path.join(root, 'src', 'cli', 'delivery.ts'));
  const fn = sourceFile.getFunctionOrThrow('runDeliveryCli');

  const commandSwitch = fn
    .getDescendantsOfKind(SyntaxKind.SwitchStatement)
    .find((node) => node.getExpression().getText() === 'command');
  if (!commandSwitch) throw new Error('runDeliveryCli has no `switch (command)` — the dispatcher moved');

  const commands = new Set<string>();
  for (const clause of commandSwitch.getClauses()) {
    if (!Node.isCaseClause(clause)) continue; // skip the default clause
    const expression = clause.getExpression();
    if (Node.isStringLiteral(expression)) commands.add(expression.getLiteralText());
  }
  return commands;
}

/** The declared subcommands: the `delivery ` command-group prefix stripped, the bare descriptor
 *  entry (`delivery`) dropped since the switch does not serve it. */
function declaredSubcommands(): Set<string> {
  return new Set(
    DELIVERY_PROTOCOL_CLI_COMMANDS
      .filter((entry) => entry !== 'delivery')
      .map((entry) => entry.replace(/^delivery /, '')),
  );
}

describe('core-laws the declared delivery CLI commands match the dispatcher', () => {
  it('every DELIVERY_PROTOCOL_CLI_COMMANDS entry is `delivery` or prefixed `delivery `', () => {
    for (const entry of DELIVERY_PROTOCOL_CLI_COMMANDS) {
      expect(entry === 'delivery' || entry.startsWith('delivery ')).toBe(true);
    }
  });

  it('advertises the bare descriptor command', () => {
    expect([...DELIVERY_PROTOCOL_CLI_COMMANDS]).toContain('delivery');
  });

  it('the declared subcommands equal the dispatcher case set', () => {
    const dispatcher = dispatcherSubcommands();
    expect(dispatcher.size).toBeGreaterThan(5);
    expect([...declaredSubcommands()].sort()).toEqual([...dispatcher].sort());
  });
});
