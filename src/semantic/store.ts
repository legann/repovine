/**
 * SemanticIndex: a local, file-backed semantic search embedding index over graph-node cards.
 *
 * No vector database on purpose — the corpus is graph nodes (thousands), not
 * text chunks (millions), so brute-force cosine over normalized Float32Arrays
 * is milliseconds. Vectors persist in the engine cache dir (`.repovine/.cache`)
 * as base64 Float32 payloads keyed by card-text hash; sync() re-embeds only
 * changed cards and prunes nodes that left the graph.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as fsPromises from 'node:fs/promises';
import { writeJsonObjectStreamed } from '../fs/atomic.js';
import type { Embedder } from './embedder.js';
import { compareCodeUnits } from '../platform/ordering.js';

export const SEMANTIC_INDEX_FILENAME = 'semantic-index.json';

interface SemanticIndexFile {
  version: 1;
  embedder: string;
  dims: number;
  entries: Record<string, { hash: string; vector: string }>;
}

export interface SemanticSyncReport {
  embedded: number;
  reused: number;
  removed: number;
  total: number;
}

export interface SemanticSyncOptions {
  /** Called with cards embedded so far and total pending embed count (0..total). */
  onProgress?: (done: number, total: number) => void;
}

export interface SemanticHit {
  id: string;
  /** Cosine similarity in [-1, 1]; entries are L2-normalized so this is a dot product. */
  score: number;
}

export interface SemanticQueryReport {
  hits: SemanticHit[];
  indexed: number;
  compared: number;
  dimensionMismatches: number;
}

function normalize(vector: number[]): Float32Array {
  let sumSquares = 0;
  for (const v of vector) sumSquares += v * v;
  const norm = Math.sqrt(sumSquares) || 1;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
  return out;
}

function encodeVector(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
}

function decodeVector(encoded: string): Float32Array {
  const buf = Buffer.from(encoded, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

export function cardHash(embedderId: string, cardText: string): string {
  return crypto.createHash('sha256').update(embedderId).update('\0').update(cardText).digest('hex');
}

export class SemanticIndex {
  private readonly filePath: string;
  private readonly embedder: Embedder;
  private readonly batchSize: number;
  private entries = new Map<string, { hash: string; vector: Float32Array }>();
  private dims = 0;

  constructor(filePath: string, embedder: Embedder, batchSize: number) {
    this.filePath = filePath;
    this.embedder = embedder;
    this.batchSize = Math.max(1, batchSize);
  }

  get size(): number {
    return this.entries.size;
  }

  get embedderId(): string {
    return this.embedder.id;
  }

  /** Load persisted vectors; entries from a different embedder/model are discarded wholesale. */
  static async load(filePath: string, embedder: Embedder, batchSize: number): Promise<SemanticIndex> {
    const index = new SemanticIndex(filePath, embedder, batchSize);
    try {
      const raw = JSON.parse(await fsPromises.readFile(filePath, 'utf-8')) as SemanticIndexFile;
      if (raw.version === 1 && raw.embedder === embedder.id && raw.entries) {
        index.dims = raw.dims;
        for (const [nodeId, entry] of Object.entries(raw.entries)) {
          index.entries.set(nodeId, { hash: entry.hash, vector: decodeVector(entry.vector) });
        }
      }
    } catch {
      // Missing or unreadable index file — start empty; sync() rebuilds it.
    }
    return index;
  }

  /** Cards whose text hash differs from the persisted index and would be embedded on sync(). */
  countPendingEmbed(cards: Map<string, string>): number {
    let pending = 0;
    for (const [nodeId, text] of cards) {
      const hash = cardHash(this.embedder.id, text);
      if (this.entries.get(nodeId)?.hash !== hash) pending++;
    }
    return pending;
  }

  /**
   * Bring the index in line with the current corpus: embed new/changed cards,
   * drop entries for nodes no longer present. Throws if the embedder fails —
   * the caller decides whether a stale index is still acceptable.
   */
  async sync(cards: Map<string, string>, options?: SemanticSyncOptions): Promise<SemanticSyncReport> {
    let removed = 0;
    for (const nodeId of [...this.entries.keys()]) {
      if (!cards.has(nodeId)) {
        this.entries.delete(nodeId);
        removed++;
      }
    }

    const pending: Array<{ nodeId: string; hash: string; text: string }> = [];
    for (const [nodeId, text] of cards) {
      const hash = cardHash(this.embedder.id, text);
      if (this.entries.get(nodeId)?.hash !== hash) {
        pending.push({ nodeId, hash, text });
      }
    }

    if (pending.length > 0) {
      options?.onProgress?.(0, pending.length);
    }

    for (let i = 0; i < pending.length; i += this.batchSize) {
      const batch = pending.slice(i, i + this.batchSize);
      const vectors = await this.embedder.embed(batch.map(item => item.text));
      for (let j = 0; j < batch.length; j++) {
        const vector = normalize(vectors[j]);
        this.dims = vector.length;
        this.entries.set(batch[j].nodeId, { hash: batch[j].hash, vector });
      }
      options?.onProgress?.(Math.min(i + batch.length, pending.length), pending.length);
    }

    if (pending.length > 0 || removed > 0) {
      await this.save();
    }
    return { embedded: pending.length, reused: cards.size - pending.length, removed, total: this.entries.size };
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [vector] = await this.embedder.embed([text]);
    return normalize(vector);
  }

  /** Brute-force cosine top-k plus visibility into entries skipped during a dimension migration. */
  queryDetailed(queryVector: Float32Array, k: number): SemanticQueryReport {
    const hits: SemanticHit[] = [];
    let dimensionMismatches = 0;
    for (const [nodeId, entry] of this.entries) {
      if (entry.vector.length !== queryVector.length) {
        dimensionMismatches++;
        continue;
      }
      let dot = 0;
      for (let i = 0; i < queryVector.length; i++) dot += queryVector[i] * entry.vector[i];
      hits.push({ id: nodeId, score: dot });
    }
    hits.sort((a, b) => b.score - a.score);
    return {
      hits: hits.slice(0, Math.max(0, k)),
      indexed: this.entries.size,
      compared: hits.length,
      dimensionMismatches,
    };
  }

  /** Backward-compatible hit-only view used by callers that do not need diagnostics. */
  query(queryVector: Float32Array, k: number): SemanticHit[] {
    return this.queryDetailed(queryVector, k).hits;
  }

  private async save(): Promise<void> {
    // Stream entries off the main loop. base64 Float32 vectors make this the second-largest artifact;
    // a single JSON.stringify would both stall the loop and risk V8's ~512 MB string cap. The header
    // (`{ version, embedder, dims, entries }`) keeps its key order; `entries` is rendered one
    // `"nodeId":{hash,vector}` pair at a time, byte-for-byte identical to the previous whole-file form.
    const sorted = [...this.entries.entries()].sort(([a], [b]) => compareCodeUnits(a, b));
    const members = (function* (): Generator<string> {
      for (const [nodeId, entry] of sorted) {
        const value = { hash: entry.hash, vector: encodeVector(entry.vector) };
        yield `${JSON.stringify(nodeId)}:${JSON.stringify(value)}`;
      }
    })();
    await writeJsonObjectStreamed(
      this.filePath,
      { version: 1, embedder: this.embedder.id, dims: this.dims, entries: undefined },
      { key: 'entries', kind: 'record', members },
    );
  }
}

export function semanticIndexFilePath(cacheDir: string): string {
  return path.join(cacheDir, SEMANTIC_INDEX_FILENAME);
}

/** Sync helper for tests/CLI checks: does an index file exist for this cache dir? */
export function semanticIndexFileExists(cacheDir: string): boolean {
  return fs.existsSync(semanticIndexFilePath(cacheDir));
}
