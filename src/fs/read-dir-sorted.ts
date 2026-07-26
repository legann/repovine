import * as fs from 'node:fs';

/**
 * Directory entries in a platform-independent order.
 *
 * `fs.readdirSync` returns whatever the filesystem enumerates. ext4 hands back hash order for large
 * directories; NTFS hands back its own case-insensitive Unicode collation, which orders `[`, `(`
 * and `+` AFTER letters where a code-unit comparison puts them before. Graph node insertion follows
 * discovery, so an unsorted read makes node order a property of the host filesystem: the same
 * repository projects differently on Windows and Linux, and a frozen golden captures one host.
 *
 * The comparison is by UTF-16 code unit, not `localeCompare` — collation is locale-dependent and
 * would reintroduce the difference it exists to remove.
 */
export function readDirSorted(dir: string): fs.Dirent[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
