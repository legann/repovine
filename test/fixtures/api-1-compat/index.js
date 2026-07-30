// FROZEN API-1 PLUGIN — do not regenerate, reformat, or modernise.
//
// This file stands in for a plugin that was published against `apiVersion: 1` and is never rebuilt.
// Every other gate in this repository compiles its plugin against the SDK of the same commit, so a
// breaking change to the contract gets fixed in the fixture inside the same diff and the gate stays
// green. These bytes cannot be fixed that way: what is checked in is what an installed plugin looks
// like. If loading this file stops working, every already-published plugin stops working.
//
// Written with the smallest possible slice of the contract, on purpose. It uses no SDK helper and no
// factory — a helper that changed shape would make this fixture fail for a reason that is not the one
// it exists to detect. What it exercises is only what the host itself must keep honouring:
//
//   - the descriptor is the default export, and is a plain object;
//   - `id` agrees with the manifest;
//   - `capabilities.iac.parsers[]` carries a parser with `kind`, `loaderId`, `fileMatch`,
//     `supports()` and `parse()`;
//   - `parse()` returns infra semantics only: `kind` plus `resources`, each with an
//     `identity: { namespace, localKey }` and a producer-owned `contentHash`;
//   - the manifest's `declarations` teach the host a resource kind and a trigger type as data.
//
// Plain JS, no imports at all, no build step, no devDependencies.

const KIND = 'legacy-stack';

/** A fixed-width digest over the resource payload, computed here so the fixture needs no SDK call. */
function digest(value) {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `legacy1-${hash.toString(16).padStart(8, '0')}`;
}

const legacyParser = {
  kind: KIND,
  loaderId: 'json',
  fileMatch: { fileNames: ['legacy-stack.json'] },

  supports(_absPath, doc) {
    return !!doc && typeof doc === 'object' && Array.isArray(doc.workers);
  },

  parse(_absPath, _repoRelPath, doc) {
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.workers)) return null;
    const resources = [];
    for (const worker of doc.workers) {
      if (!worker || typeof worker !== 'object' || typeof worker.name !== 'string') continue;
      resources.push({
        id: worker.name,
        kind: 'legacy-worker',
        provider: 'legacy',
        identity: { namespace: 'legacy', localKey: worker.name },
        contentHash: digest(worker),
        attributes: { handler: typeof worker.handler === 'string' ? worker.handler : undefined },
        triggers: [{ name: `${worker.name}-tick`, type: 'legacy-tick' }],
      });
    }
    return { kind: KIND, resources };
  },
};

export default {
  id: 'legacy-api-1',
  capabilities: { iac: { parsers: [legacyParser] } },
};
