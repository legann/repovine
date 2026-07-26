import { describe, expect, it } from '@jest/globals';
import {
  DOMAIN_MODULE_LIMIT_MAX,
  paginateDomainModules,
  parseDomainPaginationArgs,
  sortModulesByConnectivity,
} from '../../../src/mcp/domain-pagination.js';

const sample = [
  { id: 'mod:a', label: 'a', links: 2 },
  { id: 'mod:b', label: 'b', links: 10 },
  { id: 'mod:c', label: 'c', links: 5 },
];

describe('domain-pagination', () => {
  it('sortModulesByConnectivity orders by links desc', () => {
    const sorted = sortModulesByConnectivity(sample);
    expect(sorted.map(m => m.id)).toEqual(['mod:b', 'mod:c', 'mod:a']);
  });

  it('sortModulesByConnectivity breaks ties by label then id', () => {
    // All rows share the same link count so the primary key is a no-op. Label order is
    // deliberately made to DISAGREE with id order so each tie-breaker is exercised in
    // isolation: 'a' must sort before 'b' even though 'b' has the lower id (mod:0), which
    // fails if the label tie-breaker is dropped; and among the two 'a' rows the id
    // tie-breaker (asc) must put mod:3 before mod:9 against their input order [mod:9, mod:3],
    // which fails if the id tie-breaker is dropped.
    const tied = [
      { id: 'mod:0', label: 'b', links: 5 },
      { id: 'mod:9', label: 'a', links: 5 },
      { id: 'mod:3', label: 'a', links: 5 },
    ];
    const sorted = sortModulesByConnectivity(tied);
    expect(sorted.map(m => m.id)).toEqual(['mod:3', 'mod:9', 'mod:0']);
  });

  it('summaryOnly returns topModules without modules list', () => {
    const { modules, topModules, pagination } = paginateDomainModules(sample, { summaryOnly: true, moduleLimit: 2 });
    expect(modules).toHaveLength(0);
    expect(topModules?.map(m => m.id)).toEqual(['mod:b', 'mod:c']);
    expect(pagination.summaryOnly).toBe(true);
    expect(pagination.truncation).toEqual({
      shown: 2,
      total: 3,
      unit: 'item',
      more: { kind: 'arg', arg: 'view', value: 'modules', hint: expect.stringContaining('top 2 modules') },
    });
  });

  it('moduleLimit and offset paginate full list', () => {
    const page0 = paginateDomainModules(sample, { moduleLimit: 2, offset: 0 });
    expect(page0.modules.map(m => m.id)).toEqual(['mod:b', 'mod:c']);
    expect(page0.pagination.truncation?.more).toEqual({
      kind: 'page',
      arg: 'offset',
      nextOffset: 2,
      hint: expect.stringContaining('3 modules'),
    });

    const page1 = paginateDomainModules(sample, { moduleLimit: 2, offset: 2 });
    expect(page1.modules.map(m => m.id)).toEqual(['mod:a']);
    expect(page1.pagination.truncation).toBeUndefined();
  });

  it('parseDomainPaginationArgs validates bounds', () => {
    expect(() => parseDomainPaginationArgs({ moduleLimit: 0 })).toThrow(/moduleLimit/);
    expect(() => parseDomainPaginationArgs({ moduleLimit: DOMAIN_MODULE_LIMIT_MAX + 1 })).toThrow(/moduleLimit/);
    expect(() => parseDomainPaginationArgs({ moduleLimit: DOMAIN_MODULE_LIMIT_MAX })).not.toThrow();
    expect(() => parseDomainPaginationArgs({ offset: -1 })).toThrow(/offset/);
  });
});
