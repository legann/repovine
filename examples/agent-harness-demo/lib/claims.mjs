// Structured claims for the repovine-native harness process.
import { extractUserTask, stripPriorRunBlock } from './task-user.mjs';

/** @typedef {{ id: string, text: string, graphNodes?: string[], status?: 'pending'|'covered'|'gap', verifyReason?: string }} Claim */

const CLAIM_PREFIX = /^CLAIM:\s*/i;
const VERIFY_PREFIX = /^VERIFY:\s*/i;
// Claim ids contain hyphens, so the em dash the prompt asks for is the field
// separator; a spaced hyphen is accepted for models that normalize the dash away.
const VERIFY_SEP = /\s*(?:—|–|\s-\s)\s*/;

/** Stable id from claim text (short slug). */
export function claimIdFromText(text, index = 0) {
  const slug = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return slug ? `c-${slug}` : `c-${index + 1}`;
}

/** Parse CLAIM: lines from contractsChanged or free text blocks. */
export function parseClaimsFromContracts(contracts = []) {
  /** @type {Claim[]} */
  const out = [];
  for (const raw of contracts) {
    const line = String(raw).trim();
    if (!line || !CLAIM_PREFIX.test(line)) continue;
    const text = line.replace(CLAIM_PREFIX, '').trim();
    if (!text) continue;
    const id = claimIdFromText(text, out.length);
    if (!out.some((c) => c.id === id)) {
      out.push({ id, text, status: 'pending' });
    }
  }
  return out;
}

/** Build default claims from the user task when orient did not emit explicit CLAIM lines. */
export function inferClaimsFromTask(taskOrText = '') {
  const t = typeof taskOrText === 'object'
    ? extractUserTask(taskOrText)
    : stripPriorRunBlock(String(taskOrText ?? '')).trim();
  if (!t) return [];
  return [{ id: 'c-user-request', text: t.slice(0, 480), status: 'pending' }];
}

/** Merge orient claims with user task fallback; dedupe by id. */
export function mergeClaims(primary = [], fallback = []) {
  const byId = new Map();
  for (const c of [...primary, ...fallback]) {
    if (!c?.text) continue;
    const id = c.id || claimIdFromText(c.text, byId.size);
    if (byId.has(id)) continue;
    byId.set(id, {
      ...c,
      id,
      status: c.status ?? 'pending',
    });
  }
  return [...byId.values()];
}

/** Parse `VERIFY: covered|gap — <claim id> — <reason>` lines the verify sub-agent emits. */
export function parseVerifyOutcomes(contracts = []) {
  const out = [];
  for (const raw of contracts) {
    const line = String(raw ?? '').trim();
    if (!line || !VERIFY_PREFIX.test(line)) continue;
    const parts = line
      .replace(VERIFY_PREFIX, '')
      .split(VERIFY_SEP)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length < 2) continue;
    const status = parts[0].toLowerCase();
    if (status !== 'covered' && status !== 'gap') continue;
    const reason = parts.slice(2).join(' — ').trim();
    out.push({ id: parts[1], status, ...(reason ? { reason } : {}) });
  }
  return out;
}

/**
 * Apply verify outcomes onto claims. A claim the verifier never named keeps its
 * prior status, so `pending` after verify means "not judged" — never "covered".
 */
export function applyVerifyOutcomes(claims = [], contracts = []) {
  const outcomes = parseVerifyOutcomes(contracts);
  if (!outcomes.length) return claims;
  const lookup = new Map();
  for (const o of outcomes) {
    lookup.set(claimIdFromText(o.id), o);
    lookup.set(claimIdFromText(`c-${o.id}`), o); // model dropped the c- prefix
  }
  return claims.map((c) => {
    const hit = lookup.get(claimIdFromText(c.id)) ?? lookup.get(claimIdFromText(c.text));
    if (!hit) return c;
    return { ...c, status: hit.status, ...(hit.reason ? { verifyReason: hit.reason } : {}) };
  });
}

/** Suggested implement scopes from graph node ids (pkg/backend/frontend/infra). */
export function scopesFromGraphNodes(nodeIds = []) {
  const scopes = new Set();
  for (const id of nodeIds) {
    if (!id || typeof id !== 'string') continue;
    const kind = id.split(':')[0];
    const tail = id.slice(id.indexOf(':') + 1);
    if (kind === 'infra' || (kind === 'domain' && tail.startsWith('infra-'))) {
      scopes.add('infra');
    } else if (kind === 'mod' || kind === 'pkg') {
      const slash = tail.indexOf('/');
      if (slash > 0) scopes.add(tail.slice(0, slash));
    }
  }
  if (!scopes.size) return [];
  return [...scopes];
}

/** Compact orient trail for assignment injection and human reply. */
export function buildOrientTrail(orientSubAgent, claims = []) {
  const result = orientSubAgent?.result ?? {};
  const nodes = (result.graphNodesTouched ?? []).filter(Boolean);
  const scopes = scopesFromGraphNodes(nodes);
  const mcp = orientSubAgent?.mcp?.byTool ?? {};
  return {
    query: orientSubAgent?.orientQuery ?? null,
    summary: result.summary ?? '',
    graphNodes: nodes,
    suggestedScopes: scopes,
    claims,
    mcpTools: Object.keys(mcp).sort(),
    contextSessionId: result.contextSessionId ?? orientSubAgent?.mcp?.contextSessionId ?? null,
  };
}
