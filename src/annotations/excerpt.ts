/**
 * How much of an annotation a response quotes.
 *
 * One declaration, because one answer can quote the same annotation twice — a node reached both as
 * an affected node of a finding and as the subject of its `annotationContext` — and two budgets
 * there hand the agent the same text at two lengths with no way to tell which was the annotation.
 *
 * These budgets bound EXCERPTS, not the annotation. The primary delivery path does not cut: a risk
 * comes back whole from `inspect_node`, and the pointer register carries no annotation text at all.
 * Two secondary surfaces quote instead of deliver — the `annotationContext` packet of
 * `analyze_architecture` and the risk-scope candidate list of `get_annotation_status` — and both cut
 * to the same width, because the question they support is the same one: is this the entry I meant.
 *
 * The width is a decision about reach, not about style: on the published benchmark corpus every
 * boundary/consumer risk is longer than `entryChars`, so every quoted case is shortened. It is one
 * number rather than two so that the two surfaces cannot drift apart the way 150 and 180 did.
 */
export const ANNOTATION_EXCERPT = {
  /** Free-prose fields that carry a whole thought: `summary`, `stateShape`, `dataFlow`. */
  summaryChars: 200,
  /** One entry of a list field: an invariant, a risk, an assumption, a pattern. */
  entryChars: 150,
  /** Entries kept per list field. */
  listItems: 5,
  /** Entries kept from the `keyExports` / `envDependencies` maps. */
  mapEntries: 8,
  /** One value of those maps. */
  mapValueChars: 100,
  /** Nodes a single context packet describes. */
  nodesPerContext: 8,
} as const;
