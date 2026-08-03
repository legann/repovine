/**
 * Topics every client's instruction surface must carry, pinned as a list.
 *
 * Cursor exposes the generated `.agents/skills` entries through its skills menu, while Codex and
 * Claude read different file sets: a topic can therefore reach one agent and miss another while every
 * rendered file matches its template byte for byte. Drift like that is invisible to a template
 * comparison, which is why the requirement is pinned rather than derived from one client surface —
 * a derivation can become empty when its source moves, and an empty list passes silently.
 *
 * A topic is covered when ANY of its markers appears in the client's surfaces. Markers are literal and
 * lowercase-compared: a rendered phrase or a public tool name, never a path or a platform token.
 */
export interface ClientTopic {
  id: string;
  markers: readonly string[];
  /** Why an agent on this client is worse off without it. */
  why: string;
}

export const REQUIRED_CLIENT_TOPICS: readonly ClientTopic[] = [
  {
    id: 'mcp-first',
    markers: ['search_context', 'map_context'],
    why: 'Without the orientation tools the agent greps first and works without structure.',
  },
  {
    id: 'annotations-mcp-only',
    markers: ['write_annotation'],
    why: 'Hand-editing the annotation file corrupts shared memory that other sessions read.',
  },
  {
    id: 'refresh-after-edits',
    markers: ['refresh_context'],
    why: 'Structural navigation after an edit answers from a stale index.',
  },
  {
    id: 'build-status',
    markers: ['get_build_status'],
    why: 'A building graph answers with a successful envelope, so an agent without this polls or misreads it as failure.',
  },
  {
    id: 'secrets',
    markers: ['never store secrets', 'never write secrets into annotations'],
    why: 'Annotations are committed; a credential value written into one is published.',
  },
  {
    id: 'orchestration',
    markers: ['delegation policy', 'delegate by', 'project-subagent-sample'],
    why: 'The delegation surface differs per client, and an agent that cannot find it does the work inline.',
  },
  {
    id: 'domains-advisor',
    markers: ['suggest_domains_config'],
    why: 'Domain suggestions are advisory and must never be auto-applied; an agent unaware of the tool cannot offer the choice.',
  },
  {
    id: 'decline-advisory',
    markers: ['decline_advisory'],
    why: 'Without the decline channel a rejected advisory returns every session.',
  },
  {
    id: 'context-session',
    markers: ['contextsessionid'],
    why: 'Session threading is what ties a written annotation to the reading that grounds it.',
  },
  {
    id: 'annotation-queue',
    markers: ['needswork'],
    why: 'The queue metric and the coverage metric answer different questions; an agent that knows only one reports the wrong number.',
  },
];
