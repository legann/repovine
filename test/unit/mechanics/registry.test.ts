import { describe, it, expect } from '@jest/globals';
import {
  HUB_IMPORTER_FLOOR,
  DELIVERY_MECHANICS,
  DELIVERY_MECHANIC_PRIORITY,
  deliveryMechanic,
} from '../../../src/mechanics/registry.js';
import { INVESTIGATE_PRIORITY } from '../../../src/mcp/lib/investigate-refs.js';
import { hasBoundaryScopedRisk, hasConsumerScopedRisk } from '../../../src/annotations/format.js';
import { hasPersistentEffect } from '../../../src/annotations/side-effect-vocab.js';
import type { AnnotationContent, EdgeKind } from '../../../src/types.js';

/** Truth-table fixtures spanning every mechanic's primitive: risk scopes, side effects, absence. */
const ANNOTATIONS: Array<AnnotationContent | undefined> = [
  undefined,
  { summary: 's' },
  { summary: 's', risks: ['plain local risk'] },
  { summary: 's', risks: [{ text: 'frozen contract', scope: 'boundary' }] },
  { summary: 's', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] },
  {
    summary: 's',
    risks: [
      { text: 'importer must verify gate', scope: 'consumer' },
      { text: 'frozen contract', scope: 'boundary' },
    ],
  },
  { summary: 's', sideEffects: [{ kind: 'io-write', subtype: 'db' }] },
  { summary: 's', sideEffects: [{ kind: 'io-write', subtype: 'stdout' }] },
  { summary: 's', sideEffects: [{ kind: 'state-global' }] },
  { summary: 's', sideEffects: [{ kind: 'pure' }] },
];

describe('mechanics registry', () => {
  it('declares the frozen priority order and feeds INVESTIGATE_PRIORITY', () => {
    expect([...DELIVERY_MECHANIC_PRIORITY]).toEqual(['risk', 'boundary', 'effect', 'unannotated', 'wiring', 'co-change', 'hub']);
    expect([...INVESTIGATE_PRIORITY]).toEqual([...DELIVERY_MECHANIC_PRIORITY]);
  });

  it('resolves every registered mechanic through deliveryMechanic()', () => {
    for (const m of DELIVERY_MECHANICS) expect(deliveryMechanic(m.id)).toBe(m);
  });

  it('risk.detect matches hasConsumerScopedRisk on the truth table', () => {
    for (const annotation of ANNOTATIONS) {
      expect(deliveryMechanic('risk').detect({ nodeId: 'mod:x', annotation })).toBe(hasConsumerScopedRisk(annotation));
    }
  });

  it('boundary.detect matches hasBoundaryScopedRisk on the truth table', () => {
    for (const annotation of ANNOTATIONS) {
      expect(deliveryMechanic('boundary').detect({ nodeId: 'mod:x', annotation })).toBe(hasBoundaryScopedRisk(annotation));
    }
  });

  it('effect.detect matches hasPersistentEffect on the truth table', () => {
    for (const annotation of ANNOTATIONS) {
      expect(deliveryMechanic('effect').detect({ nodeId: 'mod:x', annotation })).toBe(hasPersistentEffect(annotation?.sideEffects));
    }
  });

  it('unannotated.detect is always false (reserved slot)', () => {
    for (const annotation of ANNOTATIONS) {
      expect(deliveryMechanic('unannotated').detect({ nodeId: 'mod:x', annotation })).toBe(false);
    }
  });

  /** edgeCount fake keyed by `${kind}:${dir}`; every other (kind, dir) pair counts 0. */
  const edgeCountFrom = (counts: Record<string, number>) =>
    (id: string, kind: EdgeKind, dir: 'in' | 'out'): number => (id === 'mod:x' ? counts[`${kind}:${dir}`] ?? 0 : 0);

  describe('wiring.detect', () => {
    it('is false without an edgeCount input (self-gate)', () => {
      expect(deliveryMechanic('wiring').detect({ nodeId: 'mod:x' })).toBe(false);
      expect(deliveryMechanic('wiring').detect({ nodeId: 'mod:x', importerCount: () => 99 })).toBe(false);
    });

    it('fires on an infra in-edge (resource dispatches into the node)', () => {
      expect(deliveryMechanic('wiring').detect({ nodeId: 'mod:x', edgeCount: edgeCountFrom({ 'infra:in': 1 }) })).toBe(true);
    });

    it('fires on a binds_to out-edge (node binds a resource)', () => {
      expect(deliveryMechanic('wiring').detect({ nodeId: 'mod:x', edgeCount: edgeCountFrom({ 'binds_to:out': 2 }) })).toBe(true);
    });

    it('ignores wrong directions and resource-side kinds', () => {
      const edgeCount = edgeCountFrom({
        'infra:out': 3,
        'binds_to:in': 2,
        'publishes:out': 5,
        'consumes:in': 5,
        'routes_to:in': 5,
        'imports:in': 20,
      });
      expect(deliveryMechanic('wiring').detect({ nodeId: 'mod:x', edgeCount })).toBe(false);
    });
  });

  describe('co-change.detect', () => {
    it('is false without an edgeCount input (self-gate)', () => {
      expect(deliveryMechanic('co-change').detect({ nodeId: 'export:x/Foo' })).toBe(false);
    });

    it('fires on an implements in-edge (the contract side)', () => {
      expect(deliveryMechanic('co-change').detect({ nodeId: 'mod:x', edgeCount: edgeCountFrom({ 'implements:in': 1 }) })).toBe(true);
    });

    it('fires on an implements out-edge (the implementation side)', () => {
      expect(deliveryMechanic('co-change').detect({ nodeId: 'mod:x', edgeCount: edgeCountFrom({ 'implements:out': 1 }) })).toBe(true);
    });

    it('ignores every other edge kind', () => {
      const edgeCount = edgeCountFrom({ 'imports:in': 20, 'imports:out': 20, 'contains:in': 1, 'infra:in': 1 });
      expect(deliveryMechanic('co-change').detect({ nodeId: 'mod:x', edgeCount })).toBe(false);
    });
  });

  describe('hub.detect', () => {
    it('is false without an importerCount input', () => {
      expect(deliveryMechanic('hub').detect({ nodeId: 'mod:x' })).toBe(false);
      expect(deliveryMechanic('hub').detect({ nodeId: 'mod:x', hubThreshold: 0 })).toBe(false);
    });

    it('compares the importer count of ctx.nodeId against the supplied threshold', () => {
      const importerCount = (id: string): number => (id === 'mod:x' ? 5 : 99);
      expect(deliveryMechanic('hub').detect({ nodeId: 'mod:x', importerCount, hubThreshold: 5 })).toBe(true);
      expect(deliveryMechanic('hub').detect({ nodeId: 'mod:x', importerCount, hubThreshold: 6 })).toBe(false);
    });

    it('falls back to HUB_IMPORTER_FLOOR when no threshold is supplied', () => {
      expect(deliveryMechanic('hub').detect({ nodeId: 'mod:x', importerCount: () => HUB_IMPORTER_FLOOR })).toBe(true);
      expect(deliveryMechanic('hub').detect({ nodeId: 'mod:x', importerCount: () => HUB_IMPORTER_FLOOR - 1 })).toBe(false);
    });
  });
});
