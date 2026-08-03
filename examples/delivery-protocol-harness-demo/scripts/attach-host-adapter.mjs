// Host mount adapter for the attach launcher: enumerates the host mount table
// and proves the filesystem type under every bind source. Fail-closed: a table
// that cannot be enumerated (unreadable, empty, malformed) is a thrown
// PreflightError, never an empty result — "no mounts visible" is
// indistinguishable from "cannot see mounts", and docker must not run on an
// unproven mount topology.

import fs from 'node:fs';
import path from 'node:path';

export class PreflightError extends Error {
  constructor(check, detail) {
    super(`attach ${check}: ${detail}`);
    this.check = check;
  }
}

// True when `p` equals `parent` or lives under it. Both paths must already be
// canonical (realpath) — string containment only, no filesystem access.
// Case-SENSITIVE, byte-exact: mount points and bind sources are compared as
// the exact strings the kernel and preflight report; case-folding would let
// case-variant paths alias each other.
export function pathContains(parent, p) {
  const rel = path.relative(parent, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// /proc/self/mountinfo line format:
//   ID parentID major:minor root mountPoint options [optional fields…] - fsType source superOptions
// Returns [{ mountPoint, fsType }] with octal escapes decoded in the mount
// point (\040 space, \011 tab, \012 newline, \134 backslash). Only blank lines
// are skipped. ANY other line that fails to parse — too few fields, no '-'
// separator, no fs-type after it — poisons the WHOLE table: skipping an
// unparseable line could hide exactly the mount that matters, so the table
// counts as cannot-enumerate.
export function parseMountinfo(text) {
  const mounts = [];
  for (const line of String(text).split('\n')) {
    if (line.trim() === '') continue;
    const fields = line.split(' ');
    if (fields.length < 5) {
      throw new PreflightError('mount-table', `malformed mountinfo line (fewer than 5 fields): ${line}`);
    }
    // The separator is a lone '-' token after the six mandatory fields and any
    // optional tags (shared:N, master:N, …) — none of which is ever '-'.
    const sep = fields.indexOf('-', 6);
    if (sep < 0) {
      throw new PreflightError('mount-table', `malformed mountinfo line (no "-" separator): ${line}`);
    }
    const fsType = fields[sep + 1];
    if (!fsType) {
      throw new PreflightError('mount-table', `malformed mountinfo line (no fs-type after "-"): ${line}`);
    }
    mounts.push({
      mountPoint: fields[4].replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))),
      fsType,
    });
  }
  return mounts;
}

// Host mount table as { mounts: [{ mountPoint, fsType }] }. `mountinfoText`
// (test seam) takes priority over reading `path`. Every cannot-enumerate
// condition throws PreflightError('mount-table'): unreadable file, empty text,
// zero parsed mounts, malformed line. A parsed table with zero entries is
// cannot-enumerate — a Linux host always has mounts.
export function readHostMountTable({ mountinfoText, path: tablePath = '/proc/self/mountinfo' } = {}) {
  let text = mountinfoText;
  if (text === undefined) {
    try {
      text = fs.readFileSync(tablePath, 'utf-8');
    } catch (err) {
      throw new PreflightError(
        'mount-table',
        `cannot read ${tablePath} (${err.code || err.message}); attach requires a Linux host`,
      );
    }
  }
  if (String(text).trim() === '') {
    throw new PreflightError('mount-table', `mount table is empty (${tablePath}); cannot enumerate host mounts`);
  }
  const mounts = parseMountinfo(text);
  if (mounts.length === 0) {
    throw new PreflightError('mount-table', `no mounts parsed from ${tablePath}; cannot enumerate host mounts`);
  }
  return { mounts };
}

// The mount `p` lives on: longest-mountPoint-prefix match by case-sensitive
// containment. On EQUAL mount points the LATER table entry wins ('>='):
// mountinfo lists mounts in mount order, so the last line at a point is the
// overmount that path resolution actually sees — taking the first would report
// the shadowed filesystem and let an overmount defeat the fs-type check.
// No containing mount is cannot-enumerate — every real path lives on some
// mount, so an unmatched path means the table does not describe the namespace
// `p` was resolved in.
export function mountForPath(mounts, p) {
  let best = null;
  for (const m of mounts) {
    if (pathContains(m.mountPoint, p) && (best === null || m.mountPoint.length >= best.mountPoint.length)) {
      best = m;
    }
  }
  if (best === null) throw new PreflightError('mount-table', `no mount contains ${p}`);
  return best;
}

// Filesystem types whose mount topology cannot be proven from the host's own
// mount table: projection/network filesystems re-export a foreign namespace,
// so a mount visible on the far side never appears in /proc/self/mountinfo.
// Any 'fuse.*'-typed mount (sshfs and every FUSE passthrough) is rejected by
// prefix for the same reason, as is overlay (its layer dirs live outside the
// mount point the table reports).
const UNPROVABLE_FS_TYPES = new Set([
  '9p', 'drvfs', 'virtiofs',
  'nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', 'sshfs', 'fuse', 'overlay',
]);
const isUnprovableFsType = (t) => UNPROVABLE_FS_TYPES.has(t) || t.startsWith('fuse.');

// Every bind-source path must sit on a mount whose fs-type keeps the topology
// provable. Projection/network types are rejected on every host; on WSL the
// requirement tightens to ext4 (the native distro filesystem — the only type
// fully on the Linux side of the boundary). The decision is by fs-TYPE, never
// by path string: /mnt/c on a real ext4 mount passes, a native-looking path on
// 9p fails.
export function assertProvableFsType(mounts, paths, { wsl = false } = {}) {
  for (const p of paths) {
    const m = mountForPath(mounts, p);
    if (isUnprovableFsType(m.fsType)) {
      throw new PreflightError(
        'fs-type',
        `${p} is on a ${m.fsType} mount (${m.mountPoint}); projection/network filesystems make mount topology unprovable`,
      );
    }
    if (wsl && m.fsType !== 'ext4') {
      throw new PreflightError('fs-type', `WSL attach requires an ext4 checkout, got ${m.fsType} for ${p}`);
    }
  }
}

// WSL host detection: /proc/version (or injected text) matching /microsoft/i,
// or WSL_DISTRO_NAME set in the environment. A read failure reports false —
// non-WSL Linux stays unaffected, and a missed WSL host is still safe because
// the unprovable fs-types (9p/drvfs/virtiofs) are denied on every host.
export function isWslHost({ procVersionText, path: versionPath = '/proc/version', env = process.env } = {}) {
  if (env.WSL_DISTRO_NAME) return true;
  let text = procVersionText;
  if (text === undefined) {
    try {
      text = fs.readFileSync(versionPath, 'utf-8');
    } catch {
      return false;
    }
  }
  return /microsoft/i.test(String(text));
}
