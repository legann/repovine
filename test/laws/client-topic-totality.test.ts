import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { doctorAgentAssets } from '../../src/cli/agent-doctor.js';
import { REQUIRED_CLIENT_TOPICS } from '../../src/cli/client-topics.js';
import { listCanonicalManagedAssets } from '../../src/cli/managed-setup-assets.js';
import { toolDefs } from '../../src/mcp/tool-defs.js';
import type { DoctorClient } from '../../src/cli/client-scope.js';

// Law: every topic on the pinned list reaches every client this repository ships assets for.
//
// The three clients read different file sets — Cursor exposes `.agents/skills` through its skills
// menu, while Codex and Claude have their own arrangements — so a topic can reach one agent and miss
// another while every rendered file matches its template byte for byte. A template comparison cannot
// see that.
//
// The list is pinned rather than derived on purpose: a derived list can become empty when its source
// moves, and an empty list passes every client silently.

const CLIENTS: DoctorClient[] = ['claude', 'cursor', 'codex'];
const TOOL_NAMES = toolDefs.map(def => def.name);
const REPO_ROOT = process.cwd();

// Floor of the pinned list, written out here instead of counted from the list itself. A count taken
// from the subject shrinks with it, so a topic silently dropped from the pin leaves both sides
// agreeing. Every id below has to keep reaching every client; taking one off the floor is an edit to
// this file and an argument in review.
const PINNED_TOPIC_IDS = [
  'mcp-first',
  'annotations-mcp-only',
  'refresh-after-edits',
  'build-status',
  'secrets',
  'orchestration',
  'domains-advisor',
  'decline-advisory',
  'context-session',
  'annotation-queue',
];

/** Write what `setup` would render for one client, with selected markers cut out of every file. */
function renderClient(
  repoRoot: string,
  client: DoctorClient,
  strip: readonly string[] = [],
): void {
  for (const asset of listCanonicalManagedAssets(REPO_ROOT, [client])) {
    const target = path.join(repoRoot, asset.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const body = strip.reduce(
      (text, marker) => text.replace(
        new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
        'xx',
      ),
      asset.expected,
    );
    fs.writeFileSync(target, body, 'utf-8');
  }
}

/** Uncovered-topic findings as "<surface set>: <message>", so a failure names the topic and the why. */
function uncoveredTopics(repoRoot: string, client: DoctorClient): string[] {
  return doctorAgentAssets({ repoRoot, validToolNames: TOOL_NAMES, client }).findings
    .filter(f => f.code === 'topic-not-covered')
    .map(f => `${f.file}: ${f.message}`);
}

describe('core-laws every pinned topic reaches every client', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-topic-totality-law-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('carries at least the topics named here, each able to fail', () => {
    // A short list, or a topic with no marker, passes every client without asking anything. The floor
    // is what keeps the law from thinning out one entry at a time.
    const ids = REQUIRED_CLIENT_TOPICS.map(t => t.id);
    expect(PINNED_TOPIC_IDS.filter(id => !ids.includes(id))).toEqual([]);

    const unaskable = REQUIRED_CLIENT_TOPICS
      .filter(t => t.markers.length === 0 || t.markers.some(m => !m.trim()) || !t.why.trim())
      .map(t => t.id);
    expect(unaskable).toEqual([]);

    const duplicated = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(duplicated).toEqual([]);
  });

  it.each(CLIENTS)('covers every topic on the %s surfaces this repository ships', client => {
    renderClient(repoRoot, client);

    expect(uncoveredTopics(repoRoot, client)).toEqual([]);
  });

  const negativeCases = CLIENTS.flatMap(client => (
    PINNED_TOPIC_IDS.map(topicId => ({ client, topicId }))
  ));

  it.each(negativeCases)(
    'reports $topicId when all of its markers are cut out of the $client surfaces',
    ({ client, topicId }) => {
      const topic = REQUIRED_CLIENT_TOPICS.find(t => t.id === topicId);
      expect(topic).toBeDefined();
      renderClient(repoRoot, client, topic!.markers);

      expect(uncoveredTopics(repoRoot, client).join(' ')).toContain(`"${topicId}"`);
    },
  );
});
