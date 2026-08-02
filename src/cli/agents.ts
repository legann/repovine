/**
 * `repovine agents <cmd>` — general agent utilities for harness / CI (file-in /
 * JSON-out):
 *
 *   repovine agents roles [--at <tree-ish>]
 *   repovine agents orient --query "<task text>" [--scope <pkg>]
 *   repovine agents session-quality <sessionId> [--phase <phase>] [--mode harness|client] ...
 *
 * These are not Delivery Protocol operations: `roles` reads the repository role
 * source, `orient` is a deterministic search_context + trace_flow, and
 * `session-quality` prints a Context Session Quality report. The Delivery Protocol
 * surface (descriptor, manifests, run-brief, validate-*, compliance) lives under
 * `repovine delivery`. Agent-asset drift checks live under `repovine doctor`
 * (human) and `repovine doctor --json` (CI).
 */
import { loadConfig } from '../config.js';
import { loadProjectRoleSource } from '../agents/roles-source.js';
import { ContextSessionStore } from '../context-quality/session-store.js';
import { buildOrientReport } from './orient.js';
import { setPipelineLogSink } from './ui.js';
import { type AgentsCliEnv, print, flagValue, numberFlag } from './agents-shared.js';

export type { AgentsCliEnv } from './agents-shared.js';

function printUsage(): void {
  console.error(
    [
      'Usage: repovine agents <command>',
      '',
      'Commands:',
      '  roles [--at <tree-ish>]                      Repository role source (agents.roles in repovine.config.json); --at reads a committed tree',
      '  orient --query "<task text>" [--scope <pkg>]   Deterministic search_context + trace_flow (no LLM)',
      '  session-quality <sessionId> [--phase <phase>] [--mode harness|client] [--threshold n] [--warning-threshold n] [--min-anchors n] [--byte-budget n] [--max-recovery-attempts n] [--events] [--consume] [--retain]',
      '                                               Print deterministic Context Session Quality report',
      '',
      'Delivery Protocol operations (descriptor, manifests, run-brief, validate-*, compliance) live under `repovine delivery`.',
    ].join('\n'),
  );
}

export async function runAgentsCli(argv: string[], env: AgentsCliEnv): Promise<number> {
  setPipelineLogSink('stderr');
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === '--help' || command === '-h') {
    printUsage();
    return command ? 0 : 1;
  }

  switch (command) {
    case 'roles': {
      const at = flagValue(rest, '--at');
      const result = loadProjectRoleSource(env.repoRoot, at ? { at } : {});
      if ('errors' in result) {
        print({ errors: result.errors });
        return 1;
      }
      print({ configured: result.configured, count: result.roles.length, roles: result.roles });
      return 0;
    }

    case 'orient': {
      const query = flagValue(rest, '--query') ?? rest.find((a) => !a.startsWith('--'));
      if (!query) {
        console.error('Usage: repovine agents orient --query "<task text>" [--scope <pkg>]');
        return 1;
      }
      const scope = flagValue(rest, '--scope');
      const report = await buildOrientReport(env, query, scope ? { scope } : undefined);
      print(report);
      return report.query ? 0 : 1;
    }

    case 'session-quality': {
      const sessionId = rest.find(a => !a.startsWith('--'));
      if (!sessionId) {
        console.error('Usage: repovine agents session-quality <sessionId> [--phase <explore|implement|annotate>] [--mode harness|client] [--threshold n] [--warning-threshold n] [--min-anchors n] [--byte-budget n] [--max-recovery-attempts n] [--events] [--consume] [--retain]');
        return 1;
      }
      const cfg = loadConfig(env.repoRoot);
      const store = new ContextSessionStore({ repoRoot: env.repoRoot, config: cfg.contextQuality });
      const phase = flagValue(rest, '--phase');
      if (phase !== undefined && phase !== 'explore' && phase !== 'implement' && phase !== 'annotate') {
        print({ error: `Invalid --phase "${phase}". Valid: explore, implement, annotate.` });
        return 1;
      }
      const mode = flagValue(rest, '--mode');
      if (mode !== undefined && mode !== 'harness' && mode !== 'client') {
        print({ error: `Invalid --mode "${mode}". Valid: harness, client.` });
        return 1;
      }
      const report = store.getReport(sessionId, {
        policy: {
          ...(phase ? { phase } : {}),
          ...(mode === 'harness' || mode === 'client' ? { mode } : {}),
          ...(numberFlag(rest, '--threshold') !== undefined ? { qualityThreshold: numberFlag(rest, '--threshold') } : {}),
          ...(numberFlag(rest, '--warning-threshold') !== undefined ? { warningThreshold: numberFlag(rest, '--warning-threshold') } : {}),
          ...(numberFlag(rest, '--min-anchors') !== undefined ? { minAnchors: numberFlag(rest, '--min-anchors') } : {}),
          ...(numberFlag(rest, '--byte-budget') !== undefined ? { byteBudget: numberFlag(rest, '--byte-budget') } : {}),
          ...(numberFlag(rest, '--max-recovery-attempts') !== undefined ? { maxRecoveryAttempts: numberFlag(rest, '--max-recovery-attempts') } : {}),
        },
        includeEvents: rest.includes('--events'),
        consume: rest.includes('--consume'),
        retain: rest.includes('--retain'),
      });
      if (!report) {
        print({ error: `Context session not found: ${sessionId}`, sessionId });
        return 1;
      }
      print(report);
      // Context-quality is advisory until the weighted score clears its
      // outcome-labelled validation bar. The JSON still exposes
      // acceptHandoff/rejectReasons; it must not become a process gate yet.
      return 0;
    }

    default:
      console.error(`Unknown agents command: ${command}`);
      printUsage();
      return 1;
  }
}
