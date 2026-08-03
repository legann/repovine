import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Engine state written beside a fixture, never fixture content: the `.repovine/` artifacts dir,
 * annotation lock files (`*.lock`, `*.lock.takeover`, `*.lock.<pid>.<token>.tmp`) and atomic-write
 * temps (`*.tmp.<pid>.<uuid>`). A copied lock file is poison — it names a live pid from another
 * jest worker, so the copy's next annotation reload waits out the whole lock deadline and fails
 * with AnnotationFileLockTimeoutError instead of ever acquiring it.
 */
function isTransientEngineArtifact(name: string): boolean {
  return name === '.repovine' || /\.lock(\.|$)|\.tmp(\.|$)/.test(name);
}

/**
 * Copy a committed fixture tree into a test's own root. Skips transient engine artifacts, so the
 * copy equals the committed fixture content even while another test process is building against the
 * source tree in parallel.
 */
export function copyFixtureDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (isTransientEngineArtifact(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyFixtureDirSync(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}
