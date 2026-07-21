// Verify obligations from durable graph memory (READ-ONLY).
//
// The verify subAgent checks the claims THIS run declared; contracts recorded by
// PRIOR runs live in repovine.annots.json as invariants/risks/sideEffects on
// the touched modules. This helper assembles them deterministically, so
// verification does not depend on the current orient having re-declared every
// prior contract or feature interaction. At verify time the store still holds
// the PRE-sync state — exactly the prior runs' contracts. The annots store is
// never written here; the write path stays MCP-only.
import fs from 'node:fs';
import path from 'node:path';

function readAnnotations(repoRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, 'repovine.annots.json'), 'utf8'));
    const bucket = parsed?.annotations && typeof parsed.annotations === 'object' ? parsed.annotations : parsed;
    return bucket && typeof bucket === 'object' ? bucket : {};
  } catch {
    return {};
  }
}

/**
 * Run-start snapshot of the annotation store. Captured before any stage runs, so
 * obligations always reflect PRIOR runs' contracts even when a sub-agent writes
 * annotations mid-run (implementers may write_annotation while working).
 */
export function readAnnotationsSnapshot(repoRoot) {
  return readAnnotations(repoRoot);
}

const asText = (v) => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return String(v.text ?? v.description ?? JSON.stringify(v));
  return String(v ?? '');
};

/**
 * Contracts recorded on the given canonical node ids (subAgents' validated
 * `graphNodesTouched` — no graph lookup needed). Deduped, capped.
 */
export function collectAnnotationObligations(repoRoot, nodeIds = [], { maxItems = 24, snapshot = null } = {}) {
  const annotations = snapshot ?? readAnnotations(repoRoot);
  const out = [];
  const seen = new Set();
  for (const id of nodeIds) {
    const record = annotations[id];
    const a = record?.annotation ?? record;
    if (!a || typeof a !== 'object') continue;
    for (const [kind, list] of [['invariant', a.invariants], ['risk', a.risks], ['sideEffect', a.sideEffects]]) {
      for (const item of Array.isArray(list) ? list : []) {
        const text = asText(item).trim();
        if (!text) continue;
        const key = `${kind}:${text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ nodeId: id, kind, text });
        if (out.length >= maxItems) return out;
      }
    }
  }
  return out;
}

/** Task section for the verify subAgent: prior-run contracts it must judge explicitly. */
export function obligationsSection(obligations = []) {
  if (!obligations.length) return '';
  return [
    '',
    '## Graph memory obligations (contracts PRIOR runs recorded on the modules this run touched)',
    'These come from durable annotations, independently of the claims above — an interaction the claims did not declare still shows up here.',
    'For EACH item add a contractsChanged line: OBLIGATION: preserved|violated — <nodeId> — <reason>.',
    ...obligations.map((o) => `- [${o.kind}] ${o.nodeId}: ${o.text}`),
  ].join('\n');
}
