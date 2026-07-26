import { describe, it, expect } from '@jest/globals';
import { paginateNodeViewChildren } from '../../../src/mcp/response/pagination.js';
import type { InvestigateTag, NodeView } from '../../../src/types.js';

type Child = NodeView['drillDown'][number];

function child(id: string, investigate?: InvestigateTag[]): Child {
  return { id, label: id, type: 'export-symbol', ...(investigate ? { investigate } : {}) };
}

function viewWith(children: Child[]): NodeView {
  return { id: 'mod:x', level: 2, label: 'x', description: '', drillDown: children };
}

describe('paginateNodeViewChildren — salience ordering (Part A)', () => {
  it('floats a tagged child past the page limit onto page 1', () => {
    const children = Array.from({ length: 30 }, (_, i) =>
      child(`c${i}`, i === 25 ? ['boundary'] : undefined),
    );
    const { drillDown, truncation } = paginateNodeViewChildren(viewWith(children), { limit: 20 });

    expect(drillDown[0].id).toBe('c25'); // the only tagged child leads
    expect(drillDown.map((c) => c.id)).toContain('c25');
    // Counting is about the whole child set, not the ordering — unchanged.
    expect(truncation?.children).toEqual({
      shown: 20,
      total: 30,
      unit: 'item',
      more: { kind: 'page', arg: 'offset', nextOffset: 20, hint: expect.any(String) },
    });
  });

  it('preserves untagged relative (declaration) order behind the tagged front', () => {
    const children = [child('a'), child('b', ['risk']), child('c'), child('d', ['hub']), child('e')];
    const { drillDown } = paginateNodeViewChildren(viewWith(children), { limit: 10 });
    // tagged by priority (risk > hub), then untagged in source order a, c, e.
    expect(drillDown.map((c) => c.id)).toEqual(['b', 'd', 'a', 'c', 'e']);
  });

  it('orders multiple tagged children by descending tag priority, ties by original index', () => {
    const children = [
      child('lowHub', ['hub']),
      child('risk1', ['risk']),
      child('boundary1', ['boundary']),
      child('risk2', ['risk']),
    ];
    const { drillDown } = paginateNodeViewChildren(viewWith(children), { limit: 10 });
    // risk(both, by index) > boundary > hub.
    expect(drillDown.map((c) => c.id)).toEqual(['risk1', 'risk2', 'boundary1', 'lowHub']);
  });

  it('is a no-op when no child is tagged (source order preserved)', () => {
    const children = Array.from({ length: 5 }, (_, i) => child(`c${i}`));
    const { drillDown } = paginateNodeViewChildren(viewWith(children), { limit: 10 });
    expect(drillDown.map((c) => c.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
  });

  it('keeps exportOffset paging well-defined against the salience order', () => {
    const children = [child('a'), child('b'), child('tagged', ['risk']), child('d')];
    // page 1: tagged floats to front; page 2 continues the same ordering.
    const page1 = paginateNodeViewChildren(viewWith(children), { limit: 2, offset: 0 });
    const page2 = paginateNodeViewChildren(viewWith(children), { limit: 2, offset: 2 });
    expect(page1.drillDown.map((c) => c.id)).toEqual(['tagged', 'a']);
    expect(page2.drillDown.map((c) => c.id)).toEqual(['b', 'd']);
    expect(page1.truncation?.children?.total).toBe(4);
  });
});
