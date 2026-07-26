/**
 * Guard: every command the engine tells a user or an agent to run must be one the argv router
 * dispatches.
 *
 * A remediation line is read as an instruction, so a phantom command costs a turn and some trust
 * before it fails. The branch that produced one does not have to be reachable to do damage — it
 * only has to be believable to whoever reads the source next. This test reads the strings
 * themselves, so an unreachable branch fails here just like a live one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_ROOT = path.resolve(process.cwd(), 'src');
const ROUTER_FILE = path.join(SRC_ROOT, 'mcp', 'index.ts');
const AGENTS_ROUTER_FILE = path.join(SRC_ROOT, 'cli', 'agents.ts');

/** Imperative advice. Prose that merely names the product ("the repovine policy lives …") is not
 *  an instruction and must not be matched. */
const ADVICE_RE = /\b(?:Run|Rerun) repovine ([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g;

/** `repovine agents <sub>` anywhere, imperative or not: a second command in the same sentence
 *  ("Run repovine setup, then repovine agents compliance") is advice too, and the subcommand
 *  namespace has no prose collisions. */
const AGENTS_INVOCATION_RE = /\brepovine agents ([a-z][a-z-]*)/g;

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

/** `repovine agents <sub>` subcommands, read from that router's own switch. */
function dispatchedAgentsSubcommands(): Set<string> {
  const source = fs.readFileSync(AGENTS_ROUTER_FILE, 'utf-8');
  const found = [...source.matchAll(/case '([a-z][a-z-]*)':/g)].map(m => m[1]);
  return new Set(found);
}

describe('remediation advice names commands the router dispatches', () => {
  const commands = dispatchedCommands();
  const agentsSubcommands = dispatchedAgentsSubcommands();

  // Sanity: a regex that silently stopped matching would make every assertion below vacuous.
  it('reads a non-empty dispatch table from both routers', () => {
    expect(commands).toContain('setup');
    expect(commands).toContain('agents');
    expect(agentsSubcommands).toContain('compliance');
    expect(agentsSubcommands.size).toBeGreaterThan(5);
  });

  it('advises no command the router would reject', () => {
    const phantoms: Array<{ file: string; advice: string }> = [];

    for (const file of listSourceFiles(SRC_ROOT)) {
      const source = fs.readFileSync(file, 'utf-8');
      const rel = path.relative(SRC_ROOT, file);
      for (const [advice, command] of source.matchAll(ADVICE_RE)) {
        // Only `agents` takes a subcommand; elsewhere the next word belongs to the sentence, so
        // the second capture is checked by AGENTS_INVOCATION_RE rather than here.
        if (!commands.has(command)) phantoms.push({ file: rel, advice });
      }
      for (const [advice, subcommand] of source.matchAll(AGENTS_INVOCATION_RE)) {
        if (!agentsSubcommands.has(subcommand)) phantoms.push({ file: rel, advice });
      }
    }

    expect(phantoms).toEqual([]);
  });
});
