import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from '../fs/atomic.js';

/** Newest backups kept beside the annotations file; older ones are rotated away. */
export const MAX_ANNOTATION_BACKUPS = 5;

const BACKUP_PREFIX = 'annotations.backup.';
const BACKUP_SUFFIX = '.json';

function listBackups(dir: string): string[] {
  return fs.readdirSync(dir)
    .filter(f => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
    .sort()
    .reverse();
}

/** Path of a retained backup already holding exactly `data` (size check first, then bytes). */
function findIdenticalBackup(dir: string, data: Buffer): string | undefined {
  let names: string[];
  try {
    names = listBackups(dir).slice(0, MAX_ANNOTATION_BACKUPS);
  } catch {
    return undefined;
  }
  for (const name of names) {
    const backupPath = path.join(dir, name);
    try {
      if (fs.statSync(backupPath).size !== data.byteLength) continue;
      if (fs.readFileSync(backupPath).equals(data)) return backupPath;
    } catch {
      // An unreadable backup never suppresses creating a fresh one.
    }
  }
  return undefined;
}

function rotateBackups(dir: string): void {
  try {
    const backups = listBackups(dir);
    for (let i = MAX_ANNOTATION_BACKUPS; i < backups.length; i++) {
      fs.unlinkSync(path.join(dir, backups[i]));
    }
  } catch {
    // best-effort rotation
  }
}

export type AnnotationBackupResult =
  | { status: 'written'; backupPath: string }
  | { status: 'duplicate'; backupPath: string }
  | { status: 'failed'; error: string };

/**
 * Snapshot `data` as `annotations.backup.<timestamp>.json`, keeping the newest
 * {@link MAX_ANNOTATION_BACKUPS}. Content matching a retained backup reuses that backup: reload
 * cycles and fresh processes re-arm the same failed-load snapshot, and one copy per distinct
 * content is enough. Both `written` and `duplicate` name a path holding the data, so a caller
 * disclosing "your bytes are recoverable here" never loses the disclosure to deduplication.
 *
 * `dir` defaults to the annotations file's own directory (the store's long-standing location).
 * Callers whose snapshot must stay out of a commit pass a gitignored directory instead.
 */
export function writeAnnotationBackup(
  filePath: string,
  data: Buffer,
  options: { dir?: string } = {},
): AnnotationBackupResult {
  try {
    const dir = options.dir ?? path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const existing = findIdenticalBackup(dir, data);
    if (existing) return { status: 'duplicate', backupPath: existing };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // Timestamps resolve to the millisecond, so two distinct snapshots written in the same ms would
    // share a name and the second would overwrite the first. Identical bytes already returned above
    // as `duplicate`, so a clash here is genuinely different content — take the next free `-<n>`
    // suffix so distinct snapshots stay distinct backups.
    let backupPath = path.join(dir, `${BACKUP_PREFIX}${stamp}${BACKUP_SUFFIX}`);
    for (let seq = 1; fs.existsSync(backupPath); seq++) {
      backupPath = path.join(dir, `${BACKUP_PREFIX}${stamp}-${seq}${BACKUP_SUFFIX}`);
    }
    writeFileAtomicSync(backupPath, data);
    rotateBackups(dir);
    return { status: 'written', backupPath };
  } catch (e) {
    return { status: 'failed', error: (e as Error).message };
  }
}
