/**
 * Guard: every command the engine tells a user or an agent to run must be one the argv router
 * dispatches.
 *
 * A remediation line is read as an instruction, so a phantom command costs a turn and some trust
 * before it fails. The branch that produced one does not have to be reachable to do damage — it
 * only has to be believable to whoever reads the source next. This test reads the strings
 * themselves, so an unreachable branch fails here just like a live one.
 *
 * An instruction reaches the reader in two spellings, and both are read here: an imperative
 * sentence naming the command bare, and the command as a backticked code span, which carries
 * the same instruction with or without a verb in front of it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_ROOT = path.resolve(process.cwd(), 'src');
const ROUTER_FILE = path.join(SRC_ROOT, 'mcp', 'index.ts');
const AGENTS_ROUTER_FILE = path.join(SRC_ROOT, 'cli', 'agents.ts');
const DELIVERY_ROUTER_FILE = path.join(SRC_ROOT, 'cli', 'delivery.ts');

/** Imperative advice, either capitalization. Prose that merely names the product ("the repovine
 *  policy lives …") is not an instruction and must not be matched. */
const ADVICE_RE = /\b[Rr](?:un|erun) repovine ([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g;

/** The other spelling an instruction reaches the reader in: the command as a code span, with or
 *  without a verb in front of it ("or run `repovine build` now", "Recommended: `repovine setup`").
 *  A code span holds a command line — the command word, then further words and flags, then the
 *  closing backtick — so product prose that opens a template literal does not qualify. */
const QUOTED_COMMAND_RE = /`repovine ([a-z][a-z-]*)(?: (?:[a-z][a-z-]*|--?[a-z][a-z-]*))*`/g;

/** `repovine agents <sub>` anywhere, imperative or not: a second command in the same sentence
 *  ("Run repovine setup, then repovine agents session-quality") is advice too, and the subcommand
 *  namespace has no prose collisions. */
const AGENTS_INVOCATION_RE = /\brepovine agents ([a-z][a-z-]*)/g;

/** `repovine delivery <sub>` anywhere, the delivery-namespace counterpart. Bare `repovine delivery`
 *  and `repovine delivery --schemas` (the descriptor) carry no subcommand word and are not matched. */
const DELIVERY_INVOCATION_RE = /\brepovine delivery ([a-z][a-z-]*)/g;

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Top-level commands, read from the router's own dispatch conditions. */
function dispatchedCommands(): Set<string> {
  const source = fs.readFileSync(ROUTER_FILE, 'utf-8');
  const found = [...source.matchAll(/command === '([a-z][a-z-]*)'/g)].map(m => m[1]);
  return new Set(found);
}

/** `case '<sub>':` labels read from a subcommand router's own switch. */
function switchCaseSubcommands(file: string): Set<string> {
  const source = fs.readFileSync(file, 'utf-8');
  const found = [...source.matchAll(/case '([a-z][a-z-]*)':/g)].map(m => m[1]);
  return new Set(found);
}

describe('remediation advice names commands the router dispatches', () => {
  const commands = dispatchedCommands();
  const agentsSubcommands = switchCaseSubcommands(AGENTS_ROUTER_FILE);
  const deliverySubcommands = switchCaseSubcommands(DELIVERY_ROUTER_FILE);

  // Sanity: a regex that silently stopped matching would make every assertion below vacuous.
  it('reads a non-empty dispatch table from every router', () => {
    expect(commands).toContain('setup');
    expect(commands).toContain('agents');
    expect(commands).toContain('delivery');
    expect(agentsSubcommands).toContain('orient');
    expect(agentsSubcommands.size).toBeGreaterThanOrEqual(3);
    expect(deliverySubcommands).toContain('compliance');
    expect(deliverySubcommands.size).toBeGreaterThan(5);
  });

  // Sanity: a spelling that silently stopped matching would make the scan below vacuous for it.
  it('finds both instruction spellings in the source tree', () => {
    const imperative = new Set<string>();
    const quoted = new Set<string>();
    for (const file of listSourceFiles(SRC_ROOT)) {
      const source = fs.readFileSync(file, 'utf-8');
      if ([...source.matchAll(ADVICE_RE)].length > 0) imperative.add(file);
      if ([...source.matchAll(QUOTED_COMMAND_RE)].length > 0) quoted.add(file);
    }
    expect(imperative.size).toBeGreaterThan(0);
    // The code-span spelling carries advice the imperative one never sees.
    expect([...quoted].filter(file => !imperative.has(file)).length).toBeGreaterThan(0);
  });

  it('advises no command the router would reject', () => {
    const phantoms: Array<{ file: string; advice: string }> = [];

    for (const file of listSourceFiles(SRC_ROOT)) {
      const source = fs.readFileSync(file, 'utf-8');
      const rel = path.relative(SRC_ROOT, file);
      for (const [advice, command] of source.matchAll(ADVICE_RE)) {
        // Only `agents` and `delivery` take a subcommand; elsewhere the next word belongs to the
        // sentence, so the second capture is checked by the *_INVOCATION_RE scans rather than here.
        if (!commands.has(command)) phantoms.push({ file: rel, advice });
      }
      for (const [advice, command] of source.matchAll(QUOTED_COMMAND_RE)) {
        if (!commands.has(command)) phantoms.push({ file: rel, advice });
      }
      for (const [advice, subcommand] of source.matchAll(AGENTS_INVOCATION_RE)) {
        if (!agentsSubcommands.has(subcommand)) phantoms.push({ file: rel, advice });
      }
      for (const [advice, subcommand] of source.matchAll(DELIVERY_INVOCATION_RE)) {
        if (!deliverySubcommands.has(subcommand)) phantoms.push({ file: rel, advice });
      }
    }

    expect(phantoms).toEqual([]);
  });
});
