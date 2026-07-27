import * as fs from 'node:fs';
import { compareCodeUnits } from '../platform/ordering.js';

/**
 * Directory entries in a platform-independent order.
 *
 * `fs.readdirSync` returns whatever the filesystem enumerates. ext4 hands back hash order for large
 * directories; NTFS hands back its own case-insensitive Unicode collation, which orders `[`, `(`
 * and `+` AFTER letters where a code-unit comparison puts them before. Graph node insertion follows
 * discovery, so an unsorted read makes node order a property of the host filesystem: the same
 * repository projects differently on Windows and Linux, and a frozen golden captures one host.
 *
 * The comparison is `compareCodeUnits`; see its rationale for why collation stays out of the
 * discovery path. Callers that re-sort this output use the same comparator.
 */
export function readDirSorted(dir: string): fs.Dirent[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.sort((a, b) => compareCodeUnits(a.name, b.name));
}
