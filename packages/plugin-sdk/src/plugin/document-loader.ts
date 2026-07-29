import type { JsonValue } from './json.js';

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
  relativeFilePath: string;
  content: Uint8Array;
}

export interface LoadedDocument {
  /**
   * Deterministic key, unique within one file. A JSON or raw loader normally returns one document;
   * a YAML loader returns one per document, in source order.
   */
  documentKey: string;
  value: JsonValue;
}
