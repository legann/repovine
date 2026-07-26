import { describe, expect, it } from '@jest/globals';
import { nodeInScopeHints } from '../../../src/annotations/scope-hints.js';

// Annotation validation and carrier-link advisories filter by the same scope hints, so one hint has
// to select one set of nodes. They ran two byte-identical copies that differed on a single line:
// only one expanded `pkg:foo` to `foo`. Without the expansion a `pkg:` hint selects nothing at all —
// module ids carry the package in the path tail, and the package node's own tail drops the prefix.
describe('nodeInScopeHints', () => {
  it('matches the package node named by a pkg: hint', () => {
    expect(nodeInScopeHints('pkg:client-ui', ['pkg:client-ui'])).toBe(true);
  });

  it('matches modules of the package named by a pkg: hint', () => {
    expect(nodeInScopeHints('mod:client-ui/src/app', ['pkg:client-ui'])).toBe(true);
    expect(nodeInScopeHints('export:client-ui/src/app#render', ['pkg:client-ui'])).toBe(true);
  });

  it('excludes modules of other packages under a pkg: hint', () => {
    expect(nodeInScopeHints('mod:backend/src/server', ['pkg:client-ui'])).toBe(false);
  });

  it('matches repo-path hints by module id tail', () => {
    expect(nodeInScopeHints('mod:backend/src/server', ['backend'])).toBe(true);
    expect(nodeInScopeHints('mod:backend/src/server', ['infra'])).toBe(false);
  });

  it('matches graph-kind hints by prefix and domain roll-up', () => {
    expect(nodeInScopeHints('infra:dockerfile:backend/Dockerfile', ['infra'])).toBe(true);
    expect(nodeInScopeHints('domain:infra-docker-compose', ['infra'])).toBe(true);
  });

  it('treats absent, empty and "." hints as the whole repository', () => {
    expect(nodeInScopeHints('mod:backend/src/server')).toBe(true);
    expect(nodeInScopeHints('mod:backend/src/server', [])).toBe(true);
    expect(nodeInScopeHints('mod:backend/src/server', ['.'])).toBe(true);
  });
});
