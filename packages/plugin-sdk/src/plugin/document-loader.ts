/**
 * A document loader turns file bytes into structured documents.
 *
 * The host reads the file; the loader receives content. Loading a format is therefore a pure
 * decoding step and never a second filesystem authority beside the scanner.
 *
 * `id` is what a parser names to say how its files must be decoded, which is what lets a new format
 * arrive as a plugin instead of a new member on a host-owned format union.
 */
export interface DocumentLoader {
  id: string;
  load(input: DocumentLoadInput): readonly LoadedDocument[];
}

export interface DocumentLoadInput {
  /** Repo-root-relative POSIX path of the file being decoded. */
  repoRelPath: RepoRelPath;
  content: Uint8Array;
}

export interface LoadedDocument {
  /**
   * Deterministic key, unique within one file. A JSON or raw loader normally returns one document;
   * a YAML loader returns one per document, in source order.
   */
  documentKey: string;
  /**
   * The decoded document, in whatever shape its format yields.
   *
   * The type is `unknown` rather than a JSON value because a decoder is not free to reshape what it
   * read: YAML alone yields timestamps, binary and unresolved tags, and narrowing them to JSON at
   * this boundary would rewrite a document before the parser that asked for it ever sees it. The
   * host does not read, store or forward this value — it hands it to the `supports`/`parse` pair of
   * the parser that named the loader, and those already take `unknown` and narrow it themselves.
   */
  value: unknown;
}
import type { RepoRelPath } from '../path-contract.js';
