/**
 * Delivery totality (L1).
 *
 * No orphan channel on either side: a mechanic declares no channel that has no surface, and no
 * surface carries a mechanic's signal without the mechanic declaring it.
 *
 * The invariance law fixes what a node with a primitive emits. This one fixes the vocabulary the two
 * halves share. Before it, `channels` was documentation — nothing read the field, so six of the seven
 * records disagreed with what the surfaces actually delivered, and the carrier channel shipped five
 * mechanics that never named it.
 *
 * Both directions are walked over an explicit list. A check that derived "all channels" from what the
 * registry happens to declare would pass a channel with no mechanic by having nothing to walk — the
 * vacuous-list failure the path-label law was rewritten for.
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CHANNEL_SURFACES,
  DELIVERY_MECHANICS,
  DELIVERY_MECHANIC_PRIORITY,
  mechanicsForChannel,
} from '../../src/mechanics/registry.js';
import { CHANNELS, type Channel } from '../../src/mechanics/types.js';
import { codeFiles, codeLines, repoRoot } from './graph-law-helpers.js';

/** The vocabulary, spelled out. A list derived from the registry would make totality vacuous. */
const SPELLED_CHANNELS: Channel[] = ['pull-self', 'pull-neighbor', 'pull-carrier', 'push', 'advisory'];

/** Every tag the registry knows, spelled out for the same reason. */
const SPELLED_TAGS = ['risk', 'boundary', 'effect', 'unannotated', 'wiring', 'co-change', 'hub'];

describe('core-laws delivery-totality (L1)', () => {
  it('walks a non-empty, exhaustive channel vocabulary', () => {
    expect(SPELLED_CHANNELS.length).toBeGreaterThan(0);
    expect([...CHANNELS].sort()).toEqual([...SPELLED_CHANNELS].sort());
    expect(DELIVERY_MECHANICS.map(m => m.id)).toEqual(SPELLED_TAGS);
    expect([...DELIVERY_MECHANIC_PRIORITY]).toEqual(SPELLED_TAGS);
  });

  // ── Direction 1: every declared channel has a surface that produces it ──

  it('gives every channel a declared surface with a producer and a field', () => {
    expect(Object.keys(CHANNEL_SURFACES).sort()).toEqual([...SPELLED_CHANNELS].sort());
    for (const channel of SPELLED_CHANNELS) {
      const surface = CHANNEL_SURFACES[channel];
      expect(surface.producers.length).toBeGreaterThan(0);
      expect(surface.field.length).toBeGreaterThan(0);
    }
  });

  it('names producers that exist in the tree', () => {
    for (const channel of SPELLED_CHANNELS) {
      for (const producer of CHANNEL_SURFACES[channel].producers) {
        const [relPath, symbol] = producer.split(':');
        const abs = path.join(repoRoot(), 'src', relPath);
        expect(fs.existsSync(abs)).toBe(true);
        expect(fs.readFileSync(abs, 'utf-8')).toContain(symbol);
      }
    }
  });

  it('leaves no channel without a mechanic', () => {
    for (const channel of SPELLED_CHANNELS) {
      expect({ channel, carries: mechanicsForChannel(channel).map(m => m.id) }).toEqual({
        channel,
        carries: expect.arrayContaining([expect.any(String)]),
      });
    }
  });

  // ── Direction 2: every mechanic's declaration matches what the surfaces carry ──

  it('carries exactly the mechanics each channel declares', () => {
    const byChannel = Object.fromEntries(
      SPELLED_CHANNELS.map(channel => [channel, mechanicsForChannel(channel).map(m => m.id)]),
    );
    expect(byChannel).toEqual({
      'pull-self': ['boundary', 'wiring'],
      'pull-neighbor': ['risk', 'boundary', 'effect', 'wiring', 'co-change', 'hub'],
      'pull-carrier': ['risk', 'boundary', 'effect', 'wiring', 'co-change', 'hub'],
      push: ['boundary'],
      advisory: ['risk', 'boundary'],
    });
  });

  it('reserves exactly one mechanic with no channel, and it detects nothing', () => {
    const silent = DELIVERY_MECHANICS.filter(m => m.channels.length === 0);
    expect(silent.map(m => m.id)).toEqual(['unannotated']);
    // The slot holds its place in the priority order; a record that declares no channel must not be
    // able to fire, or it would be a signal with nowhere to go.
    for (const m of silent) expect(m.detect({ nodeId: 'mod:x' })).toBe(false);
  });

  // ── The declaration is load-bearing, not documentation ──

  it('dispatches ref tagging from the channel rather than the whole registry', () => {
    // Walking `DELIVERY_MECHANICS` to tag a ref is what let the carrier channel deliver five
    // mechanics that never declared it: the loop tagged by whatever detected.
    const offenders = codeLines(['mechanics/registry.ts'])
      .filter(line => /for\s*\(\s*const\s+\w+\s+of\s+DELIVERY_MECHANICS\s*\)/.test(line.text));
    expect(offenders).toEqual([]);
  });

  it('keeps the channel vocabulary out of hand-written literals outside the registry', () => {
    // A surface that spells a channel name into a literal set has a second declaration of channel
    // membership. The registry and this law are the only places the names are written.
    const offenders = codeLines(['mechanics/registry.ts', 'mechanics/types.ts'])
      // A call site naming the channel it delivers on is the point; an array literal of channel
      // names outside the registry is a second declaration of membership, however short.
      .filter(line => /\[[^\]]*'(?:pull-self|pull-neighbor|pull-carrier)'/.test(line.text));
    expect(offenders).toEqual([]);
  });

  it('reads the boundary risk scope through one function', () => {
    // `push` used to spell `risk.scope === 'boundary'` out again to collect the texts, so a change to
    // what counts as boundary-scoped would have moved the tag and left the index behind.
    const offenders = codeLines(['annotations/format.ts'])
      .filter(line => /\.scope\s*===\s*'boundary'/.test(line.text));
    expect(offenders).toEqual([]);
  });

  it('holds the guards above over a non-empty file set', () => {
    // A text guard that scanned nothing would pass every check above.
    expect(codeFiles([]).length).toBeGreaterThan(200);
  });
});
