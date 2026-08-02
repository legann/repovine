import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it, beforeEach, afterEach, jest } from '@jest/globals';
import { runAgentsCli } from '../../../src/cli/agents.js';
import { runDeliveryCli } from '../../../src/cli/delivery.js';
import { PROTOCOL_VERSION, SCHEMA_IDS } from '../../../src/agents/protocol.js';
import { ContextSessionStore } from '../../../src/context-quality/session-store.js';
import {
  lastStdoutJson,
  spyStdoutWrite,
  type StdoutWriteSpy,
} from '../../helpers/cli-output.js';

describe('agents / delivery CLI', () => {
  let repoRoot: string;
  let env: { repoRoot: string; artifactsDir: string };
  let outSpy: StdoutWriteSpy;
  let errSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-'));
    env = { repoRoot, artifactsDir: path.join(repoRoot, '.repovine') };
    // print() writes JSON straight to stdout; usage/errors go to console.error.
    outSpy = spyStdoutWrite();
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function lastJson(): unknown {
    return lastStdoutJson(outSpy);
  }

  describe('runDeliveryCli', () => {
    it('prints the protocol descriptor when run bare', async () => {
      const code = await runDeliveryCli([], env);
      expect(code).toBe(0);
      expect((lastJson() as { protocol: { protocolVersion: string } }).protocol.protocolVersion).toBe(PROTOCOL_VERSION);
    });

    it('includes all Delivery Protocol v1 JSON schemas with --schemas', async () => {
      await runDeliveryCli(['--schemas'], env);
      const out = lastJson() as { jsonSchemas: Record<string, unknown> };
      for (const id of Object.values(SCHEMA_IDS)) {
        expect(out.jsonSchemas).toHaveProperty(id);
        expect(out.jsonSchemas[id]).toEqual(expect.objectContaining({ type: 'object' }));
      }
    });

    it('lists manifests and filters by role', async () => {
      expect(await runDeliveryCli(['manifests'], env)).toBe(0);
      expect((lastJson() as { count: number }).count).toBe(6);

      await runDeliveryCli(['manifests', '--role', 'explorer'], env);
      const out = lastJson() as { count: number; manifests: Array<{ name: string }> };
      expect(out.count).toBe(1);
      expect(out.manifests[0].name).toBe('repovine-repo-explorer');
    });

    it('returns run-brief prompt material', async () => {
      expect(await runDeliveryCli(['run-brief'], env)).toBe(0);
      const out = lastJson() as { role: string; brief: string; protocolVersion: string; projectionVersion: string };
      expect(out.role).toBe('implementer');
      expect(out.brief).toContain('AUTONOMOUS harness run');
      expect(out.protocolVersion).toBe('1');
      expect(out.projectionVersion).toBe('1');
      expect('handoff' in out).toBe(false);
    });

    it('validates a well-formed assignment file', async () => {
      const file = path.join(repoRoot, 'a.json');
      fs.writeFileSync(file, JSON.stringify({
        protocolVersion: PROTOCOL_VERSION, runId: 'r', role: 'implementer', task: 't', scope: [], version: 1, acceptanceCriteria: [], constraints: [], contracts: [], requestedChecks: [],
      }));
      expect(await runDeliveryCli(['validate-assignment', file], env)).toBe(0);
      expect((lastJson() as { valid: boolean }).valid).toBe(true);
    });

    it('rejects a malformed assignment file with exit 1', async () => {
      const file = path.join(repoRoot, 'bad.json');
      fs.writeFileSync(file, JSON.stringify({ protocolVersion: PROTOCOL_VERSION, runId: 'r' }));
      expect(await runDeliveryCli(['validate-assignment', file], env)).toBe(1);
      expect((lastJson() as { valid: boolean }).valid).toBe(false);
    });

    it('rejects a malformed result without building a graph', async () => {
      const file = path.join(repoRoot, 'bad-result.json');
      fs.writeFileSync(file, JSON.stringify({ protocolVersion: '2', runId: 'r' }));
      expect(await runDeliveryCli(['validate-result', file], env)).toBe(1);
      const out = lastJson() as { valid: boolean; unsupportedVersion?: string };
      expect(out.valid).toBe(false);
      expect(out.unsupportedVersion).toBe('2');
    });

    it('validates a linkage-consistent ReviewInput and rejects a runId mismatch (no graph)', async () => {
      const impl = {
        protocolVersion: PROTOCOL_VERSION, runId: 'run-1', status: 'complete', summary: 'done',
        scope: ['pkg/src'], filesChanged: ['pkg/src/a.ts'], graphNodesTouched: ['mod:pkg/src/a'],
        contractsChanged: [], testsRun: [], annotationsWritten: [],
        compliance: { refreshContextRun: true, annotationsClean: true, dependencyImpactChecked: true, configSurfaceChecked: true, flowChecked: true, architectureChecked: true },
        blockers: [],
      };
      const assignment = {
        protocolVersion: PROTOCOL_VERSION, runId: 'run-1', role: 'implementer', task: 't', scope: ['pkg/src'], version: 1,
        acceptanceCriteria: [], constraints: [], contracts: [], requestedChecks: [],
      };
      const reviewInput = { assignment, implementationResult: impl, diffBase: 'tree-1', changedFiles: ['pkg/src/a.ts'], graphNodesTouched: ['mod:pkg/src/a'] };

      const okFile = path.join(repoRoot, 'ri-ok.json');
      fs.writeFileSync(okFile, JSON.stringify(reviewInput));
      expect(await runDeliveryCli(['validate-review-input', okFile], env)).toBe(0);
      expect((lastJson() as { valid: boolean }).valid).toBe(true);

      const badFile = path.join(repoRoot, 'ri-bad.json');
      fs.writeFileSync(badFile, JSON.stringify({ ...reviewInput, assignment: { ...assignment, runId: 'run-review-9' } }));
      expect(await runDeliveryCli(['validate-review-input', badFile], env)).toBe(1);
      const out = lastJson() as { valid: boolean; errors: string[] };
      expect(out.valid).toBe(false);
      expect(out.errors.join(' ')).toMatch(/linkage: assignment\.runId/);
    });

    it('rejects a malformed assignment without emitting a compliance report', async () => {
      const resultFile = path.join(repoRoot, 'result.json');
      const assignmentFile = path.join(repoRoot, 'assignment.json');
      fs.writeFileSync(resultFile, JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        runId: 'r',
        status: 'complete',
        summary: 'done',
        scope: [],
        filesChanged: [],
        graphNodesTouched: [],
        contractsChanged: [],
        testsRun: [],
        annotationsWritten: [],
        compliance: {
          refreshContextRun: true,
          annotationsClean: true,
          dependencyImpactChecked: true,
          configSurfaceChecked: true,
          flowChecked: true,
          architectureChecked: true,
        },
        blockers: [],
      }));
      fs.writeFileSync(assignmentFile, JSON.stringify({ protocolVersion: PROTOCOL_VERSION, runId: 'r' }));

      expect(await runDeliveryCli(['compliance', resultFile, '--assignment', assignmentFile], env)).toBe(1);
      const out = lastJson() as { schemaValid: boolean; assignmentSchemaValid: boolean; complianceSkipped: boolean; report?: unknown };
      expect(out.schemaValid).toBe(true);
      expect(out.assignmentSchemaValid).toBe(false);
      expect(out.complianceSkipped).toBe(true);
      expect(out.report).toBeUndefined();
    });

    it('rejects unknown delivery subcommands via the default branch, naming the command', async () => {
      expect(await runDeliveryCli(['frobnicate'], env)).toBe(1);
      const calls = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(calls).toContainEqual(expect.stringContaining('Unknown delivery command: frobnicate'));
    });
  });

  describe('runAgentsCli', () => {
    it('roles: unconfigured repo returns configured:false; a configured role round-trips', async () => {
      fs.writeFileSync(path.join(repoRoot, 'repovine.config.json'), '{}');
      expect(await runAgentsCli(['roles'], env)).toBe(0);
      expect(lastJson()).toEqual({ configured: false, count: 0, roles: [] });

      fs.mkdirSync(path.join(repoRoot, 'roles'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'roles', 'acme-api.md'), '# Acme API\n\nRole knowledge.\n');
      fs.writeFileSync(
        path.join(repoRoot, 'repovine.config.json'),
        JSON.stringify({ agents: { roles: { 'acme-api': { brief: 'roles/acme-api.md', scope: ['services/api'] } } } }),
      );
      expect(await runAgentsCli(['roles'], env)).toBe(0);
      const out = lastJson() as { configured: boolean; count: number; roles: Array<{ id: string; brief: string; hash: string }> };
      expect(out.configured).toBe(true);
      expect(out.count).toBe(1);
      expect(out.roles[0].id).toBe('acme-api');
      expect(out.roles[0].brief).toContain('# Acme API');
    });

    it('prints persisted context session quality', async () => {
      const store = new ContextSessionStore({ repoRoot });
      const result = {
        scope: 'pkg:prod',
        resolvedScope: { kind: 'package', id: 'pkg:prod' },
        summary: 'mapped',
        confidence: 'high',
        result: { focus: { id: 'pkg:prod' } },
        gaps: [],
        navigation: {},
      };
      store.recordToolCall({
        sessionId: 'sess-cli',
        tool: 'inspect_node',
        args: { nodeId: 'pkg:prod', contextSessionId: 'sess-cli' },
        result,
        responseText: JSON.stringify(result),
      });

      expect(await runAgentsCli(['session-quality', 'sess-cli', '--phase', 'annotate', '--threshold', '0.1', '--consume'], env)).toBe(0);
      const out = lastJson() as { sessionId: string; acceptHandoff: boolean };
      expect(out.sessionId).toBe('sess-cli');
      expect(out.acceptHandoff).toBe(true);
      expect(await runAgentsCli(['session-quality', 'sess-cli'], env)).toBe(1);
    });

    it('keeps weak context advisory in both client and harness report modes', async () => {
      const store = new ContextSessionStore({ repoRoot });
      const result = {
        scope: 'query:noisy',
        resolvedScope: { kind: 'query', id: 'query:noisy' },
        summary: 'noisy',
        confidence: 'medium',
        result: {
          matches: {
            strategy: { requested: 'auto', used: 'or', relaxedFrom: 'and' },
            topResults: [
              { id: 'export:pkg/a/Foo', label: 'Foo', type: 'export-symbol' },
              { id: 'export:pkg/a/Bar', label: 'Bar', type: 'export-symbol' },
              { id: 'export:pkg/a/Baz', label: 'Baz', type: 'export-symbol' },
            ],
            suggestedScopes: [{ scope: 'export:pkg/a/Foo' }],
            totalResults: 1000,
            returned: 3,
            truncated: true,
          },
        },
        gaps: [],
        navigation: {},
      };
      store.recordToolCall({
        sessionId: 'sess-weak-cli',
        tool: 'search_context',
        args: { query: 'noisy', contextSessionId: 'sess-weak-cli' },
        result,
        responseText: JSON.stringify(result),
      });

      expect(await runAgentsCli(['session-quality', 'sess-weak-cli', '--mode', 'client', '--max-recovery-attempts', '2'], env)).toBe(0);
      const clientOut = lastJson() as {
        acceptHandoff: boolean;
        warnings: string[];
        policy: { mode: string; maxRecoveryAttempts?: number };
      };
      expect(clientOut.acceptHandoff).toBe(false);
      expect(clientOut.policy).toMatchObject({ mode: 'client', maxRecoveryAttempts: 2 });
      expect(clientOut.warnings.join(' ')).toContain('client advisory mode');

      expect(await runAgentsCli(['session-quality', 'sess-weak-cli', '--mode', 'harness'], env)).toBe(0);
    });

    it('rejects unknown subcommands via the default branch, naming the command', async () => {
      // `render` is not a runAgentsCli subcommand
      // and the CLI has no --client concept, so this falls through to the default
      // unknown-command branch (agents.ts default: console.error `Unknown agents command: ...`).
      expect(await runAgentsCli(['render', '--client', 'emacs'], env)).toBe(1);
      const renderCalls = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(renderCalls).toContainEqual(expect.stringContaining('Unknown agents command: render'));

      errSpy.mockClear();
      expect(await runAgentsCli(['frobnicate'], env)).toBe(1);
      const frobCalls = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(frobCalls).toContainEqual(expect.stringContaining('Unknown agents command: frobnicate'));
    });
  });
});
