import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EDGE_KINDS, NODE_TYPES } from '../../src/types.js';

// Doc-lint law: DESIGN.md defines the graph schema as the pinned core contract, yet it drifted
// once (documented thirteen edge kinds while the code shipped fourteen — `reexports` was absent).
// This asserts the doc enumerates every node/edge kind, so the next added kind cannot drift silently.

function readDesignDoc(): string {
  const candidates = [
    path.join(process.cwd(), 'DESIGN.md'),
    path.join(process.cwd(), 'repovine', 'DESIGN.md'),
  ];
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) throw new Error(`DESIGN.md not found (looked in: ${candidates.join(', ')})`);
  return fs.readFileSync(found, 'utf-8');
}

describe('DESIGN.md documents the full graph-schema contract', () => {
  const doc = readDesignDoc();

  it('names every edge kind in EDGE_KINDS', () => {
    const missing = EDGE_KINDS.filter(kind => !doc.includes(`\`${kind}\``));
    expect(missing).toEqual([]);
  });

  it('names every node type in NODE_TYPES', () => {
    const missing = NODE_TYPES.filter(type => !doc.includes(`\`${type}\``));
    expect(missing).toEqual([]);
  });

  it('states the current edge-kind count in words', () => {
    const countWord = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
      'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen'][EDGE_KINDS.length];
    expect(countWord).toBeDefined();
    expect(doc).toContain(`${countWord} graph edge kinds`);
  });

  it('states the current node-type count in words', () => {
    const countWord = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
      'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen'][NODE_TYPES.length];
    expect(countWord).toBeDefined();
    expect(doc).toContain(`${countWord} graph node types`);
  });
});
