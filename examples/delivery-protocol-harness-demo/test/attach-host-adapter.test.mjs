// Host mount adapter contract: fail-closed mount-table enumeration, fs-type
// enforcement, WSL detection. Pure functions — no git, docker, or host mounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
  PreflightError,
  assertProvableFsType,
  isWslHost,
  mountForPath,
  parseMountinfo,
  pathContains,
  readHostMountTable,
} from '../scripts/attach-host-adapter.mjs';
import { PreflightError as LauncherPreflightError } from '../scripts/attach-launcher.mjs';

const line = (mp, fsType = 'ext4', tags = 'shared:1') => `36 35 98:0 / ${mp} rw ${tags} - ${fsType} /dev/sda1 rw`;

const rejects = (fn, check, re) =>
  assert.throws(
    fn,
    (err) => err instanceof PreflightError && err.check === check && re.test(err.message),
    `expected PreflightError check=${check} matching ${re}`,
  );

test('PreflightError: stable shape, one identity across launcher and adapter', () => {
  const e = new PreflightError('fs-type', 'detail');
  assert.ok(e instanceof Error);
  assert.equal(e.check, 'fs-type');
  assert.equal(e.message, 'attach fs-type: detail');
  assert.equal(PreflightError, LauncherPreflightError, 'launcher re-exports the same class');
});

test('parseMountinfo: extracts fsType after the "-" separator', () => {
  assert.deepEqual(parseMountinfo('36 35 98:0 / / rw shared:1 - ext4 /dev/sda1 rw'), [
    { mountPoint: '/', fsType: 'ext4' },
  ]);
});

test('parseMountinfo: multiple optional tags before the separator', () => {
  const text = '52 35 0:41 / /mnt/pool rw,relatime shared:2 master:1 propagate_from:3 - btrfs /dev/sdb1 rw';
  assert.deepEqual(parseMountinfo(text), [{ mountPoint: '/mnt/pool', fsType: 'btrfs' }]);
});

test('parseMountinfo: octal escapes decoded in the mount point', () => {
  assert.deepEqual(parseMountinfo(line('/c\\040d', 'xfs')), [{ mountPoint: '/c d', fsType: 'xfs' }]);
});

test('parseMountinfo: a malformed line poisons the whole table', () => {
  // Mandatory fields present, no '-' separator.
  rejects(() => parseMountinfo(`${line('/')}\n37 35 98:0 / /x rw\n`), 'mount-table', /no "-" separator/);
  // Separator present, nothing after it.
  rejects(() => parseMountinfo('37 35 98:0 / /x rw shared:1 -'), 'mount-table', /no fs-type/);
});

test('readHostMountTable: every cannot-enumerate condition throws mount-table', () => {
  rejects(() => readHostMountTable({ mountinfoText: '' }), 'mount-table', /empty/);
  rejects(() => readHostMountTable({ mountinfoText: '\n \n' }), 'mount-table', /empty/);
  // A non-blank line with too few fields poisons the table outright.
  rejects(() => readHostMountTable({ mountinfoText: 'x y\n' }), 'mount-table', /fewer than 5 fields/);
  rejects(() => readHostMountTable({ mountinfoText: `${line('/')}\nx y\n` }), 'mount-table', /fewer than 5 fields/);
  rejects(() => readHostMountTable({ mountinfoText: `${line('/')}\n37 35 98:0 / /x rw\n` }), 'mount-table', /separator/);
  rejects(
    () => readHostMountTable({ path: path.join(os.tmpdir(), 'no-such-mountinfo') }),
    'mount-table',
    /cannot read/,
  );
});

test('readHostMountTable: injected text takes priority over the file path', () => {
  const r = readHostMountTable({ mountinfoText: `${line('/')}\n`, path: '/no/such/file' });
  assert.deepEqual(r.mounts, [{ mountPoint: '/', fsType: 'ext4' }]);
});

test('mountForPath: longest mount-point prefix wins; unmatched path throws', () => {
  const mounts = parseMountinfo(`${line('/')}\n${line('/home', 'xfs')}\n${line('/home/u/wt', 'btrfs')}\n`);
  assert.equal(mountForPath(mounts, '/home/u/wt/file').fsType, 'btrfs');
  assert.equal(mountForPath(mounts, '/home/u/wt').fsType, 'btrfs');
  assert.equal(mountForPath(mounts, '/home/u').fsType, 'xfs');
  assert.equal(mountForPath(mounts, '/etc/x').fsType, 'ext4');
  rejects(() => mountForPath(parseMountinfo(`${line('/data')}\n`), '/etc/x'), 'mount-table', /no mount contains/);
  // Case-variant mount points do not contain the path — byte-exact matching.
  rejects(() => mountForPath(parseMountinfo(`${line('/x/Repo')}\n`), '/x/repo/f'), 'mount-table', /no mount contains/);
});

test('pathContains: case-sensitive, byte-exact', () => {
  assert.equal(pathContains('/x/Repo', '/x/repo/f'), false);
  assert.equal(pathContains('/x/repo', '/x/repo/f'), true);
});

test('assertProvableFsType: 9p/drvfs/virtiofs denied on every host', () => {
  for (const fsType of ['9p', 'drvfs', 'virtiofs']) {
    // The path string looks native; the fs-type says projection — rejected.
    const mounts = parseMountinfo(`${line('/')}\n${line('/home/u/wt', fsType)}\n`);
    rejects(() => assertProvableFsType(mounts, ['/home/u/wt'], { wsl: false }), 'fs-type', /unprovable/);
    rejects(() => assertProvableFsType(mounts, ['/home/u/wt'], { wsl: true }), 'fs-type', /unprovable/);
  }
});

test('assertProvableFsType: WSL requires ext4 by TYPE — the path string is irrelevant', () => {
  // A /mnt/c-looking path on a real ext4 mount passes under wsl.
  const ext4MntC = parseMountinfo(`${line('/')}\n${line('/mnt/c')}\n`);
  assertProvableFsType(ext4MntC, ['/mnt/c/proj'], { wsl: true });
  // A native non-ext4 type is rejected under wsl…
  const btrfs = parseMountinfo(`${line('/')}\n${line('/home/u/wt', 'btrfs')}\n`);
  rejects(
    () => assertProvableFsType(btrfs, ['/home/u/wt'], { wsl: true }),
    'fs-type',
    /WSL attach requires an ext4 checkout, got btrfs for \/home\/u\/wt/,
  );
  // …and fine on plain Linux.
  assertProvableFsType(btrfs, ['/home/u/wt'], { wsl: false });
});

test('assertProvableFsType: checks every path, not just the first', () => {
  const mounts = parseMountinfo(`${line('/')}\n${line('/state', '9p')}\n`);
  rejects(() => assertProvableFsType(mounts, ['/home/u/wt', '/state/run'], { wsl: false }), 'fs-type', /9p/);
});

test('assertProvableFsType: network and FUSE filesystems denied on every host', () => {
  for (const fsType of ['nfs', 'nfs4', 'cifs', 'smb3', 'sshfs', 'overlay', 'fuse.sshfs', 'fuse.rclone']) {
    const mounts = parseMountinfo(`${line('/')}\n${line('/home/u/wt', fsType)}\n`);
    rejects(() => assertProvableFsType(mounts, ['/home/u/wt'], { wsl: false }), 'fs-type', /unprovable/);
  }
});

test('mountForPath: overmount at the same mount point wins (last table entry)', () => {
  // mountinfo lists mounts in mount order: the LATER line at a point is the
  // filesystem path resolution actually sees. The shadowed first entry must
  // not satisfy the fs-type proof.
  const overmounted = parseMountinfo(`${line('/')}\n${line('/home/u/wt', 'ext4')}\n${line('/home/u/wt', '9p')}\n`);
  assert.equal(mountForPath(overmounted, '/home/u/wt').fsType, '9p');
  rejects(() => assertProvableFsType(overmounted, ['/home/u/wt'], { wsl: false }), 'fs-type', /9p/);
  // The inverse order — 9p shadowed by a later ext4 overmount — passes.
  const remounted = parseMountinfo(`${line('/')}\n${line('/home/u/wt', '9p')}\n${line('/home/u/wt', 'ext4')}\n`);
  assert.equal(mountForPath(remounted, '/home/u/wt').fsType, 'ext4');
  assertProvableFsType(remounted, ['/home/u/wt'], { wsl: true });
});

test('isWslHost: /proc/version match, env var, read failure', () => {
  assert.equal(isWslHost({ procVersionText: 'Linux version 5.15.90.1-microsoft-standard-WSL2', env: {} }), true);
  assert.equal(isWslHost({ procVersionText: 'Linux version 5.15.0-generic', env: {} }), false);
  assert.equal(isWslHost({ procVersionText: '5.15.0-generic', env: { WSL_DISTRO_NAME: 'Ubuntu' } }), true);
  assert.equal(isWslHost({ path: '/no/such/proc-version', env: {} }), false, 'read failure reports false');
});
