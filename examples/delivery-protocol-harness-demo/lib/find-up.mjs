// Walk parent directories looking for a marker, instead of counting "../.." by
// hand. Fixed-depth path.resolve(HERE, '..','..','..') breaks the moment the demo
// is relocated to a different nesting depth; an upward marker search does not.
//
// Returns the DIRECTORY that contains `marker` (a relative file/dir path), or
// null if no ancestor has it. Never throws.
import fs from 'node:fs';
import path from 'node:path';

export function findUp(startDir, marker) {
  let dir = startDir;
  for (;;) {
    try {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    } catch {
      /* unreadable ancestor — keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}
