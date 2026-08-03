// In-image worker probe: run by test/egress-smoke.docker.test.mjs INSIDE the
// hardened worker container (node:22-bookworm-slim, node builtins only — the image
// has no curl). Each check names the compose knob it proves. Any failure prints a
// per-check line and the process exits non-zero, so the smoke sees exactly which
// guarantee broke.
//
// The worker shares egress-gw's network namespace (compose.yaml network_mode:
// service:egress-gw), so the egress and DNS checks here exercise the gateway's
// allow-list and sinkhole from the worker's own side of the shared netns.
import fs from 'node:fs';
import dns from 'node:dns';

const failures = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`probe ok: ${name}`))
    .catch((err) => failures.push(`${name}: ${err.message}`));
}

// [1] Read-only rootfs (compose.yaml read_only:true). A write outside the workspace
// bind and tmpfs mounts must fail with EROFS.
await check('readonly rootfs (read_only:true)', () => {
  let threw;
  try {
    fs.writeFileSync('/probe-ro-check', 'x');
  } catch (err) {
    threw = err;
  }
  if (!threw) throw new Error('write to / succeeded — rootfs is not read-only');
  if (threw.code !== 'EROFS') throw new Error(`expected EROFS, got ${threw.code}`);
});

// [2] No docker socket reachable from the worker (no Docker-in-Docker).
await check('no docker.sock (write-only worker runs no containers)', () => {
  for (const p of ['/var/run/docker.sock', '/run/docker.sock']) {
    if (fs.existsSync(p)) throw new Error(`${p} exists in the worker`);
  }
});

// [3] cap_drop:[ALL] + non-root USER node → the effective capability set is empty.
await check('cap_drop ALL effective (CapEff==0)', () => {
  const status = fs.readFileSync('/proc/self/status', 'utf-8');
  const m = status.match(/^CapEff:\s*([0-9a-fA-F]+)/m);
  if (!m) throw new Error('CapEff not found in /proc/self/status');
  if (BigInt(`0x${m[1]}`) !== 0n) throw new Error(`CapEff is ${m[1]}, expected all zeros`);
});

// [4] no-new-privileges (security_opt) → the kernel flag is set.
await check('no-new-privileges (NoNewPrivs==1)', () => {
  const status = fs.readFileSync('/proc/self/status', 'utf-8');
  const m = status.match(/^NoNewPrivs:\s*(\d+)/m);
  if (!m) throw new Error('NoNewPrivs not found in /proc/self/status');
  if (m[1] !== '1') throw new Error(`NoNewPrivs is ${m[1]}, expected 1`);
});

// [5] Egress allow-list from the worker side of the shared netns: an allow-listed
// host connects (any HTTP status proves connectivity — no credentials sent), a
// non-allow-listed host is dropped (fetch rejects fast on the abort timeout).
await check('allow-listed egress connects (api.anthropic.com)', async () => {
  const res = await fetch('https://api.anthropic.com/', { signal: AbortSignal.timeout(10000) });
  if (!res.status) throw new Error('no HTTP status from allow-listed host');
});
await check('non-allow-listed egress blocked (example.com)', async () => {
  let reached = false;
  try {
    await fetch('https://example.com/', { signal: AbortSignal.timeout(4000) });
    reached = true;
  } catch {
    // expected: connection dropped at the IP layer or name sinkholed
  }
  if (reached) throw new Error('example.com was reachable — default-deny leaked');
});

// [6] DNS sinkhole visible from the worker (resolv.conf 127.0.0.11 → iptables
// REDIRECT → dnsmasq): an unlisted name resolves to 0.0.0.0.
await check('DNS: unlisted name has no routable address', async () => {
  // The invariant is that an unlisted name never resolves to a REACHABLE IP.
  // dnsmasq's `--address=/#/` answers the null address (0.0.0.0 for A, :: for
  // AAAA); glibc getaddrinfo then either returns that null address or rejects
  // it as ENOTFOUND. Both mean "not routable" and pass; only a real address is
  // a leak. (The egress-blocked check proves the firewall independently.)
  let all;
  try {
    all = await dns.promises.lookup('example.com', { all: true });
  } catch (e) {
    if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') return; // unresolvable = sinkholed
    throw e;
  }
  const routable = all.filter((a) => a.address !== '0.0.0.0' && a.address !== '::');
  if (routable.length) throw new Error(`example.com resolved to routable ${JSON.stringify(routable)}`);
});

if (failures.length) {
  console.error(`container-probe FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('container-probe: all checks passed');
