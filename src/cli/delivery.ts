/**
 * `repovine delivery <cmd>` — CLI-only Delivery Protocol surface (harness / CI).
 *
 * Gives CI and non-MCP harnesses a file-in / JSON-out integration path:
 *
 *   repovine delivery [--schemas]                       Delivery Protocol descriptor (+ JSON Schemas)
 *   repovine delivery manifests [--role <role>] [--name <name>]
 *   repovine delivery run-brief [--role <role>] [--name <name>]
 *   repovine delivery validate-assignment <assignment.json>
 *   repovine delivery validate-result <result.json>
 *   repovine delivery validate-review-input <review-input.json>
 *   repovine delivery compliance <result.json> [--assignment <a.json>] [--manifest <name>] [--greenfield-run]
 *
 * Every command prints JSON on stdout for CI/harness use. General agent utilities
 * (roles, orient, session-quality) live under `repovine agents`; agent-asset drift
 * checks live under `repovine doctor` (human) and `repovine doctor --json` (CI).
 */
import { loadConfig } from '../config.js';
import { RepovineRuntime } from '../mcp/context.js';
import { buildDeliveryProtocol, AGENT_JSON_SCHEMAS, type AgentRole } from '../agents/protocol.js';
import { BUILTIN_MANIFESTS, getManifest, getManifestByRole } from '../agents/manifests.js';
import {
  validateAssignment,
  validateRunResult,
  validateReviewInput,
  checkCompliance,
  type ComplianceState,
} from '../agents/validation.js';
import { ContextSessionStore } from '../context-quality/session-store.js';
import { buildRunBrief } from './run-brief.js';
import { setPipelineLogSink } from './ui.js';
import { type AgentsCliEnv, print, flagValue, readJsonFile } from './agents-shared.js';

function printUsage(): void {
  console.error(
    [
      'Usage: repovine delivery [<command>]',
      '',
      '  delivery [--schemas]                         Print the Delivery Protocol descriptor (+ JSON Schemas with --schemas)',
      '',
      'Commands:',
      '  manifests [--role <role>] [--name <name>]    Print built-in agent manifests',
      '  run-brief [--role <role>] [--name <name>]    Pre-run JSON: the manifest-derived protocol brief',
      '  validate-assignment <assignment.json>        Schema-validate an AgentAssignment',
      '  validate-result <result.json>                Schema-validate an AgentRunResult (structure only)',
      '  validate-review-input <review-input.json>    Schema-validate + linkage-check a standalone ReviewInput',
      '  compliance <result.json> [--assignment <a.json>] [--manifest <name>] [--greenfield-run]',
      '                                               Schema-validate + compliance-check an AgentRunResult;',
      '                                               --greenfield-run marks a run that started with no annotated context',
    ].join('\n'),
  );
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

export async function runDeliveryCli(argv: string[], env: AgentsCliEnv): Promise<number> {
  setPipelineLogSink('stderr');
  const command = argv[0];
  const rest = argv.slice(1);

  if (command === '--help' || command === '-h') {
    printUsage();
    return 0;
  }

  // No subcommand (or a bare flag such as --schemas): the descriptor is the
  // command. `repovine delivery` prints it; `--schemas` adds the JSON Schemas.
  if (!command || command.startsWith('--')) {
    const includeSchemas = argv.includes('--schemas');
    print(includeSchemas
      ? { protocol: buildDeliveryProtocol(), jsonSchemas: AGENT_JSON_SCHEMAS }
      : { protocol: buildDeliveryProtocol() });
    return 0;
  }

  switch (command) {
    case 'manifests': {
      const role = flagValue(rest, '--role') as AgentRole | undefined;
      const name = flagValue(rest, '--name');
      let manifests = BUILTIN_MANIFESTS;
      if (role) manifests = manifests.filter(m => m.role === role);
      if (name) manifests = manifests.filter(m => m.name === name);
      print({ count: manifests.length, manifests });
      return manifests.length > 0 ? 0 : 1;
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
        console.error('Usage: repovine delivery validate-assignment <assignment.json>');
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
        console.error('Usage: repovine delivery validate-result <result.json>');
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
        console.error('Usage: repovine delivery validate-review-input <review-input.json>');
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
        console.error('Usage: repovine delivery compliance <result.json> [--assignment <a.json>] [--manifest <name>] [--greenfield-run]');
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
      // Resolve the run's manifest once: an explicit --manifest wins, else the assignment's role
      // (closing the silent ['summary'] fallback). The validator stays role-agnostic — it receives the
      // required fields and the read-only flag, not the manifest.
      const manifestFlag = flagValue(rest, '--manifest');
      const manifest = manifestFlag
        ? getManifest(manifestFlag)
        : assignment?.value
          ? getManifestByRole(assignment.value.role)
          : undefined;
      const report = checkCompliance({
        result: schema.value,
        assignment: assignment?.value,
        state: await buildComplianceState(env),
        requiredRunResultFields: manifest?.requiredRunResultFields,
        readOnlyManifestName: manifest && manifest.canEditFiles === false ? manifest.name : undefined,
        greenfieldRun: rest.includes('--greenfield-run'),
      });
      print({
        schemaValid: true,
        ...(assignment ? { assignmentSchemaValid: assignment.valid, assignmentSchemaErrors: assignment.errors } : {}),
        report,
      });
      return report.valid && (assignment?.valid ?? true) ? 0 : 1;
    }

    default:
      console.error(`Unknown delivery command: ${command}`);
      printUsage();
      return 1;
  }
}
