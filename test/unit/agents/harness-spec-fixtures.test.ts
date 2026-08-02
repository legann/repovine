import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import type { AnnotationStore } from '../../../src/annotations/store.js';
import {
  AgentAssignmentSchema,
  AgentRunResultSchema,
  ArchitectureAuditResultSchema,
  CodeReviewResultSchema,
  ContextPackSchema,
  PROTOCOL_VERSION,
  ReviewInputSchema,
} from '../../../src/agents/protocol.js';
import { checkCompliance, type ComplianceState } from '../../../src/agents/validation.js';
import { getManifest } from '../../../src/agents/manifests.js';
import type { RepositoryGraph, RepositoryFactsSnapshot } from '../../../src/types.js';

/** Resolve a built-in manifest into the role-agnostic inputs checkCompliance takes. */
function manifestArgs(name: string): { requiredRunResultFields?: string[]; readOnlyManifestName?: string } {
  const m = getManifest(name);
  return {
    requiredRunResultFields: m?.requiredRunResultFields,
    readOnlyManifestName: m && m.canEditFiles === false ? m.name : undefined,
  };
}

const fixturePath = path.join(
  process.cwd(),
  'test',
  'fixtures',
  'delivery-protocol-harness',
  'harness-spec-fixtures.json',
);

function readFixture(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
}

function fakeGraph(nodeIds: string[]): RepositoryGraph {
  const nodes = new Map(nodeIds.map(id => [id, { type: 'module' }]));
  return { nodes } as unknown as RepositoryGraph;
}

function fakeStore(): AnnotationStore {
  return {
    get: () => undefined,
    getAll: () => ({}),
    detectOrphaned: () => ({ total: 0, orphaned: [], byType: {} }),
    scanAnnotationHealth: () => ({
      counts: { needsWork: 0, stale: 0, staleContent: 0, stalePropagation: 0, unannotated: 0 },
      rows: [],
      sample: () => [],
    }),
  } as unknown as AnnotationStore;
}

describe('delivery protocol harness spec fixtures', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-spec-fixtures-'));
    fs.writeFileSync(path.join(repoRoot, 'repovine.annots.json'), '{"version":1,"annotations":{}}\n');
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  function state(nodes: string[]): ComplianceState {
    return {
      repoRoot,
      graph: fakeGraph(nodes),
      snapshot: {} as unknown as RepositoryFactsSnapshot,
      annotations: fakeStore(),
    };
  }

  it('keeps delivery protocol harness fixtures aligned with every harness-facing schema', () => {
    const f = readFixture();
    expect(f.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(Array.isArray(f.graphNodes)).toBe(true);

    expect(ContextPackSchema.safeParse(f.contextPack).success).toBe(true);
    expect(ArchitectureAuditResultSchema.safeParse(f.architectureAudit).success).toBe(true);
    expect(CodeReviewResultSchema.safeParse(f.codeReview).success).toBe(true);
    expect(ReviewInputSchema.safeParse(f.reviewInput).success).toBe(true);

    for (const key of ['implementationAssignment', 'architectureAuditAssignment', 'codeReviewAssignment']) {
      const parsed = AgentAssignmentSchema.safeParse(f[key]);
      expect(parsed.success).toBe(true);
    }

    for (const key of ['implementationResult', 'architectureAuditRunResult', 'codeReviewRunResult']) {
      const parsed = AgentRunResultSchema.safeParse(f[key]);
      expect(parsed.success).toBe(true);
    }
  });

  it('keeps harness fixture flows compliant against observable repovine claims', () => {
    const f = readFixture();
    const nodes = f.graphNodes as string[];
    const complianceState = state(nodes);

    const implementation = checkCompliance({
      assignment: AgentAssignmentSchema.parse(f.implementationAssignment),
      result: AgentRunResultSchema.parse(f.implementationResult),
      state: complianceState,
      ...manifestArgs('project-subagent-sample'),
    });
    expect(implementation.valid).toBe(true);
    expect(implementation.errors).toEqual([]);

    const architectureAudit = checkCompliance({
      assignment: AgentAssignmentSchema.parse(f.architectureAuditAssignment),
      result: AgentRunResultSchema.parse(f.architectureAuditRunResult),
      state: complianceState,
      ...manifestArgs('repovine-architecture-auditor'),
    });
    expect(architectureAudit.valid).toBe(true);
    expect(architectureAudit.errors).toEqual([]);

    const codeReview = checkCompliance({
      assignment: AgentAssignmentSchema.parse(f.codeReviewAssignment),
      result: AgentRunResultSchema.parse(f.codeReviewRunResult),
      state: complianceState,
      ...manifestArgs('repovine-code-reviewer'),
    });
    expect(codeReview.valid).toBe(true);
    expect(codeReview.errors).toEqual([]);
  });
});
