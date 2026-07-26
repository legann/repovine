/**
 * `repovine agents <cmd>` — CLI-only Agent Protocol surface (harness / CI).
 *
 * Gives CI and non-MCP harnesses a file-in / JSON-out integration path:
 *
 *   repovine agents protocol [--schemas]
 *   repovine agents manifests [--role <role>] [--name <name>]
 *   repovine agents validate-assignment <assignment.json>
 *   repovine agents validate-result <result.json>
 *   repovine agents validate-review-input <review-input.json>
 *   repovine agents compliance <result.json> [--assignment <a.json>] [--manifest <name>]
 *   repovine agents session-quality <sessionId> [--phase <phase>] [--events] [--consume] [--retain]
 *   repovine agents orient --query "<task text>" [--scope <pkg>]
 *   repovine agents run-brief [--role <role>] [--name <name>]
 *   repovine agents roles [--at <tree-ish>]
 *
 * Validation commands (validate-assignment, validate-result, compliance, protocol,
 * manifests) print JSON for CI/harness use. Agent-asset drift checks live under
 * `repovine doctor` (human) and `repovine doctor --json` (CI).
 */
import fs from 'node:fs';
import { loadConfig } from '../config.js';
import { loadProjectRoleSource } from '../agents/roles-source.js';
import { RepovineRuntime } from '../mcp/context.js';
import { buildAgentProtocol, AGENT_JSON_SCHEMAS, type AgentRole } from '../agents/protocol.js';
import { BUILTIN_MANIFESTS } from '../agents/manifests.js';
import {
  validateAssignment,
  validateRunResult,
  validateReviewInput,
  checkCompliance,
  type ComplianceState,
} from '../agents/validation.js';
import { ContextSessionStore } from '../context-quality/session-store.js';
import { buildRunBrief } from './run-brief.js';
import { buildOrientReport } from './orient.js';
import { setPipelineLogSink } from './ui.js';

export interface AgentsCliEnv {
  repoRoot: string;
  artifactsDir: string;
}

function print(value: unknown): void {
  // Write results straight to stdout so it stays pure JSON even when graph-build
  // progress is logged (see buildComplianceState), keeping the CLI pipe/CI-safe.
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printUsage(): void {
  console.error(
    [
      'Usage: repovine agents <command>',
      '',
      'Commands:',
      '  protocol [--schemas]                         Print the Agent Protocol descriptor',
      '  manifests [--role <role>] [--name <name>]    Print built-in agent manifests',
      '  run-brief [--role <role>] [--name <name>]    Pre-run JSON: the manifest-derived protocol brief',
      '  roles [--at <tree-ish>]                      Repository role source (agents.roles in repovine.config.json); --at reads a committed tree',
      '  validate-assignment <assignment.json>        Schema-validate an AgentAssignment',
      '  validate-result <result.json>                Schema-validate an AgentRunResult (structure only)',
      '  validate-review-input <review-input.json>    Schema-validate + linkage-check a standalone ReviewInput',
      '  compliance <result.json> [--assignment <a.json>] [--manifest <name>]',
      '                                               Schema-validate + compliance-check an AgentRunResult',
      '  session-quality <sessionId> [--phase <phase>] [--mode harness|client] [--threshold n] [--warning-threshold n] [--min-anchors n] [--byte-budget n] [--max-recovery-attempts n] [--events] [--consume] [--retain]',
      '                                               Print deterministic Context Session Quality report',
      '  orient --query "<task text>" [--scope <pkg>]   Deterministic search_context + trace_flow (no LLM)',
    ].join('\n'),
  );
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function readJsonFile(file: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf-8')) };
  } catch (e) {
    return { ok: false, error: `Cannot read/parse ${file}: ${(e as Error).message}` };
  }
}

function numberFlag(args: string[], flag: string): number | undefined {
  const raw = flagValue(args, flag);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function buildComplianceState(env: AgentsCliEnv): Promise<ComplianceState> {
  setPipelineLogSink('stderr');
  const cfg = loadConfig(env.repoRoot);
  const ctx = await RepovineRuntime.create(env.repoRoot, env.artifactsDir, cfg);
  const { graph, snapshot, annotations } = ctx.getState();
  const contextQualityStore = new ContextSessionStore({ repoRoot: env.repoRoot, config: cfg.contextQuality });
  return {
    repoRoot: env.repoRoot,
    graph,
    snapshot,
    annotations,
    getContextQualityReport: (sessionId, policy) => contextQualityStore.getReport(sessionId, { policy }),
    consumeContextQualitySession: (sessionId, options) => contextQualityStore.consumeSession(sessionId, options),
    contextQualityConfig: cfg.contextQuality,
  };
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
    case 'protocol': {
      const includeSchemas = rest.includes('--schemas');
      print(includeSchemas
        ? { protocol: buildAgentProtocol(), jsonSchemas: AGENT_JSON_SCHEMAS }
        : { protocol: buildAgentProtocol() });
      return 0;
    }

    case 'manifests': {
      const role = flagValue(rest, '--role') as AgentRole | undefined;
      const name = flagValue(rest, '--name');
      let manifests = BUILTIN_MANIFESTS;
      if (role) manifests = manifests.filter(m => m.role === role);
      if (name) manifests = manifests.filter(m => m.name === name);
      print({ count: manifests.length, manifests });
      return manifests.length > 0 ? 0 : 1;
    }

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

    case 'run-brief': {
      const role = flagValue(rest, '--role') as AgentRole | undefined;
      const name = flagValue(rest, '--name');
      const result = buildRunBrief({ role, name });
      if ('error' in result) {
        print({ error: result.error });
        return 1;
      }
      print(result);
      return 0;
    }

    case 'validate-assignment': {
      const file = rest.find(a => !a.startsWith('--'));
      if (!file) {
        console.error('Usage: repovine agents validate-assignment <assignment.json>');
        return 1;
      }
      const read = readJsonFile(file);
      if (!read.ok) {
        print({ valid: false, errors: [read.error] });
        return 1;
      }
      const result = validateAssignment(read.value);
      print({
        valid: result.valid,
        errors: result.errors,
        warnings: result.warnings,
        ...(result.unsupportedVersion ? { unsupportedVersion: result.unsupportedVersion } : {}),
      });
      return result.valid ? 0 : 1;
    }

    case 'validate-result': {
      // Schema-only: structural validation of an AgentRunResult, symmetric with
      // validate-assignment. Never builds a graph; use `compliance` for the gate.
      const file = rest.find(a => !a.startsWith('--'));
      if (!file) {
        console.error('Usage: repovine agents validate-result <result.json>');
        return 1;
      }
      const read = readJsonFile(file);
      if (!read.ok) {
        print({ valid: false, errors: [read.error] });
        return 1;
      }
      const result = validateRunResult(read.value);
      print({
        valid: result.valid,
        errors: result.errors,
        warnings: result.warnings,
        ...(result.unsupportedVersion ? { unsupportedVersion: result.unsupportedVersion } : {}),
      });
      return result.valid ? 0 : 1;
    }

    case 'validate-review-input': {
      // Schema + cross-object linkage of a standalone ReviewInput. Never builds a
      // graph; graph-node existence is left to result/compliance validation.
      const file = rest.find(a => !a.startsWith('--'));
      if (!file) {
        console.error('Usage: repovine agents validate-review-input <review-input.json>');
        return 1;
      }
      const read = readJsonFile(file);
      if (!read.ok) {
        print({ valid: false, errors: [read.error] });
        return 1;
      }
      const result = validateReviewInput(read.value);
      print({
        valid: result.valid,
        errors: result.errors,
        warnings: result.warnings,
      });
      return result.valid ? 0 : 1;
    }

    case 'compliance': {
      const file = rest.find(a => !a.startsWith('--') && a !== flagValue(rest, '--assignment') && a !== flagValue(rest, '--manifest'));
      if (!file) {
        console.error('Usage: repovine agents compliance <result.json> [--assignment <a.json>] [--manifest <name>] [--greenfield-run]');
        return 1;
      }
      const read = readJsonFile(file);
      if (!read.ok) {
        print({ valid: false, errors: [read.error] });
        return 1;
      }
      // Schema-validate the result first so malformed input never triggers a graph build.
      const schema = validateRunResult(read.value);
      if (!schema.valid || !schema.value) {
        print({
          schemaValid: false,
          schemaErrors: schema.errors,
          ...(schema.unsupportedVersion ? { unsupportedVersion: schema.unsupportedVersion } : {}),
        });
        return 1;
      }
      let assignment;
      const assignmentFile = flagValue(rest, '--assignment');
      if (assignmentFile) {
        const a = readJsonFile(assignmentFile);
        if (!a.ok) {
          print({ valid: false, errors: [a.error] });
          return 1;
        }
        assignment = validateAssignment(a.value);
        if (!assignment.valid) {
          print({
            schemaValid: true,
            assignmentSchemaValid: false,
            assignmentSchemaErrors: assignment.errors,
            complianceSkipped: true,
            skipReason: 'assignment failed schema validation',
          });
          return 1;
        }
      }
      const report = checkCompliance({
        result: schema.value,
        assignment: assignment?.value,
        state: await buildComplianceState(env),
        manifestName: flagValue(rest, '--manifest'),
        greenfieldRun: rest.includes('--greenfield-run'),
      });
      print({
        schemaValid: true,
        ...(assignment ? { assignmentSchemaValid: assignment.valid, assignmentSchemaErrors: assignment.errors } : {}),
        report,
      });
      return report.valid && (assignment?.valid ?? true) ? 0 : 1;
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
