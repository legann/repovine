import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SemanticIndex, semanticIndexFilePath } from '../../../src/semantic/store.js';
import type { Embedder } from '../../../src/semantic/embedder.js';

function tempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `repovine-${label}-`));
}

/** Deterministic stub: vector derived from text length so distinct cards get distinct vectors. */
function stubEmbedder(id = 'local:test', dims = 4): Embedder {
  return {
    id,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(t => Array.from({ length: dims }, (_, d) => (t.length % 7) + d + 1));
    },
  };
}

describe('SemanticIndex persistence (streamed save)', () => {
  it('persists entries and round-trips through load with searchable vectors', async () => {
    const filePath = semanticIndexFilePath(tempDir('semantic'));
    const embedder = stubEmbedder();
    const index = new SemanticIndex(filePath, embedder, 8);

    const report = await index.sync(new Map([
      ['nodeB', 'beta card text'],
      ['nodeA', 'alpha card text longer'],
    ]));
    expect(report.embedded).toBe(2);
    expect(fs.existsSync(filePath)).toBe(true);

    // On-disk shape: { version, embedder, dims, entries: { nodeId: { hash, vector } } }, entries sorted.
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(raw.version).toBe(1);
    expect(raw.embedder).toBe(embedder.id);
    expect(raw.dims).toBe(4);
    expect(Object.keys(raw.entries)).toEqual(['nodeA', 'nodeB']); // localeCompare-sorted
    expect(typeof raw.entries.nodeA.hash).toBe('string');
    expect(typeof raw.entries.nodeA.vector).toBe('string'); // base64 Float32

    const reloaded = await SemanticIndex.load(filePath, embedder, 8);
    expect(reloaded.size).toBe(2);
    const q = await reloaded.embedQuery('alpha card text longer');
    expect(reloaded.query(q, 1)[0].id).toBe('nodeA');
  });

  it('writes valid JSON and leaves no stray temp file', async () => {
    const dir = tempDir('semantic');
    const filePath = semanticIndexFilePath(dir);
    await new SemanticIndex(filePath, stubEmbedder(), 8).sync(new Map([['n1', 'one']]));
    expect(() => JSON.parse(fs.readFileSync(filePath, 'utf-8'))).not.toThrow();
    expect(fs.readdirSync(dir).filter(n => n.includes('.tmp.'))).toEqual([]);
  });
});
