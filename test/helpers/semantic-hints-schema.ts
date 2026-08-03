/**
 * The `semanticHints` zod schema, for tests only.
 *
 * The SDK publishes the version (`SEMANTIC_HINTS_VERSION`) and the verdict (`validateSemanticHints`),
 * not the schema behind them: an author branches on a verdict, and the schema stays free to change
 * shape. That is the same rule that kept the other raw zod schemas off the barrel.
 *
 * Tests still need the schema itself, for one reason the verdict cannot serve: the slot list. Several
 * laws are stated over "every slot the schema has" — that each is documented with its reach, that a
 * hand-kept list of frontend-only slots has not drifted onto a phantom field — and a verdict answers
 * about one value, never about the set of slots. So the schema is reached here, at the source path,
 * where reaching it is a statement about this repository rather than about the published surface.
 */
export {
  zSemanticHints,
  type ZSemanticHints,
} from '../../packages/plugin-sdk/src/source-plugin/semantic-hints-schema.js';
