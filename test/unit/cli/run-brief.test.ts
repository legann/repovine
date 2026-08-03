import { describe, expect, it } from '@jest/globals';
import { buildRunBrief } from '../../../src/cli/run-brief.js';
import { PROJECTION_VERSION } from '../../../src/cli/agent-projection.js';

describe('buildRunBrief', () => {
  it('returns the manifest-derived protocol brief with version fields', () => {
    const result = buildRunBrief({});
    expect(result).not.toHaveProperty('error');
    if ('error' in result) throw new Error(result.error);
    expect(result.role).toBe('implementer');
    expect(result.name).toBe('project-subagent-sample');
    expect(result.protocolVersion).toBe('1');
    expect(result.projectionVersion).toBe(PROJECTION_VERSION);
    expect(result.brief).toContain('AUTONOMOUS harness run');
    expect(result.brief).toContain('do not bound inspect scope');
    expect(result.brief).toContain('Locality:');
    expect(result.brief).toContain('breadth is the task'); // task-conditioned closure
    expect(result.brief).toContain('Investigate channel'); // migrated from risk:true
    expect(result.brief).toContain('Enumerate-before-unchanged'); // intra-node enumeration
    expect(result.brief).toContain('consumer-scoped risk');
    expect(result.brief).toContain('accepted requires explicit user sign-off'); // accept-loophole closed
    expect(result).not.toHaveProperty('handoff');
  });

  it('selects a manifest by role and by name, and errors on an unknown name', () => {
    const byRole = buildRunBrief({ role: 'code-reviewer' });
    if ('error' in byRole) throw new Error(byRole.error);
    expect(byRole.name).toBe('repovine-code-reviewer');

    const byName = buildRunBrief({ name: 'repovine-repo-explorer' });
    if ('error' in byName) throw new Error(byName.error);
    expect(byName.role).toBe('explorer');

    expect(buildRunBrief({ name: 'no-such-manifest' })).toEqual({
      error: 'No built-in manifest for name "no-such-manifest".',
    });
  });
});
