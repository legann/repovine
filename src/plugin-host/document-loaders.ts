import yaml from 'js-yaml';
import type { DocumentLoader, LoadedDocument } from '@repovine/plugin-sdk';

/**
 * The document loaders the host provides.
 *
 * Decoding a serialisation format is not ecosystem knowledge: the same three decoders serve every
 * plugin that writes its infrastructure in YAML, JSON or plain text, and a plugin that needs a
 * fourth registers it with its descriptor. A parser names one of these ids and receives the decoded
 * document; it never reads the file itself.
 */

/**
 * YAML schema that resolves an unknown local tag to its payload instead of throwing.
 *
 * Local tags are how a YAML dialect extends the language — `!Ref`, `!Sub` and `!If` in one
 * ecosystem, something else in the next. Refusing them would drop the whole document, including the
 * parts every parser can read, so the tag is discarded and the value underneath is kept. Which tags
 * exist is the parser's business; the loader only declines to fail on them.
 */
export const TAG_TOLERANT_YAML_SCHEMA = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('!', {
    kind: 'scalar',
    multi: true,
    resolve: () => true,
    construct: (data: unknown) => data,
  }),
  new yaml.Type('!', {
    kind: 'sequence',
    multi: true,
    resolve: () => true,
    construct: (data: unknown) => data,
  }),
  new yaml.Type('!', {
    kind: 'mapping',
    multi: true,
    resolve: () => true,
    construct: (data: unknown) => data,
  }),
]);

const decoder = new TextDecoder('utf-8');

/** Documents in source order, keyed by position — the one key a multi-document file can promise. */
function positional(values: readonly unknown[]): LoadedDocument[] {
  return values.map((value, index) => ({ documentKey: String(index), value }));
}

const yamlLoader: DocumentLoader = {
  id: 'yaml',
  load({ content }) {
    return positional(
      yaml.loadAll(decoder.decode(content), null, { schema: TAG_TOLERANT_YAML_SCHEMA })
        .filter((doc): doc is NonNullable<unknown> => doc != null),
    );
  },
};

const jsonLoader: DocumentLoader = {
  id: 'json',
  load({ content }) {
    return positional([JSON.parse(decoder.decode(content))]);
  },
};

/** Undecoded text, for formats a parser reads itself (Dockerfile, HCL, anything line-oriented). */
const textLoader: DocumentLoader = {
  id: 'text',
  load({ content }) {
    return positional([decoder.decode(content)]);
  },
};

export const HOST_DOCUMENT_LOADERS: readonly DocumentLoader[] = [yamlLoader, jsonLoader, textLoader];
