import type { PrunedDir } from '@repovine/plugin-sdk';
import type { LayoutSkip } from '../types.js';
import { compareCodeUnits } from '../platform/ordering.js';
import type { DeclarationCatalog } from '../plugin-host/declaration-catalog.js';

/**
 * What this build's layout table kept out, gathered from every producer that walked.
 *
 * Pruning decides which modules exist, and a skipped tree is otherwise indistinguishable from an
 * empty one: nothing downstream can tell a repository with no `node_modules` from one whose
 * `node_modules` was walked past. Producers report through `SourceDiscoveryOptions.onPruned`, the
 * engine's own walks report through the same sink, and the total is published on the snapshot.
 *
 * Aggregated by (name, reason), not kept per path: a large repository prunes tens of thousands of
 * directories, and the answer a reader wants is which table entry decided and how often.
 */
export class LayoutSkipCollector {
  private readonly counts = new Map<string, { name: string; reason: PrunedDir['reason']; stops: number }>();

  /** The sink handed to producers and to the engine's own walks. */
  readonly sink = (pruned: PrunedDir): void => {
    const key = `${pruned.reason}:${pruned.name}`;
    const entry = this.counts.get(key);
    if (entry) entry.stops++;
    else this.counts.set(key, { name: pruned.name, reason: pruned.reason, stops: 1 });
  };

  /**
   * The report, with each name's owner joined in from the declaration catalog.
   *
   * Ownership is resolved here rather than carried through the walk: the walk answers by name, and
   * who declared that name is a property of the build's plugin set, which the host holds.
   */
  summary(catalog: DeclarationCatalog | undefined): LayoutSkip[] {
    const owners = new Map<string, string[]>();
    for (const record of catalog?.dirs ?? []) {
      const name = record.key.slice('dir:'.length);
      if (!name) continue;
      owners.set(
        name,
        [...new Set(record.declarations.map(declaration => declaration.declaredBy.pluginId))]
          .sort(compareCodeUnits),
      );
    }
    return [...this.counts.values()]
      .sort((a, b) => compareCodeUnits(`${a.reason}:${a.name}`, `${b.reason}:${b.name}`))
      .map(entry => {
        const declaredBy = owners.get(entry.name);
        return {
          name: entry.name,
          reason: entry.reason,
          stops: entry.stops,
          ...(declaredBy === undefined || declaredBy.length === 0 ? {} : { declaredBy }),
        };
      });
  }
}
