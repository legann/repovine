// Actual-container egress smoke: builds the harness images, boots the egress
// gateway, and asserts the allow-list, default-deny rule order, IPv6 fail-closed
// branch, and worker hardening from INSIDE running containers. Unlike the
// render-only tests, this proves runtime behavior, not just the compose model.
//
// Gated behind HARNESS_DOCKER_SMOKE=1 and a reachable Docker daemon. Without both
// it named-skips (visible in TAP) so `npm test` and non-Docker CI stay fast. The
// dedicated `npm run test:egress-smoke` script sets the env var.
//
// Non-vacuity is enforced throughout: default-deny is asserted as the literal LAST
// OUTPUT rule with the allow-list ACCEPTs before it (a pass cannot come from an
// empty chain); the IPv6 leg hard-fails if the overlay applied but no global v6
// address appeared, and only NAMED-skips (with a stderr notice) when the daemon
// cannot create the enable_ipv6 network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEMO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.realpathSync(os.tmpdir());

const enabled = process.env.HARNESS_DOCKER_SMOKE === '1';
// Strict mode (set by the required CI job): a missing daemon or an unexercised
// IPv6 leg becomes a hard failure instead of a green named-skip, so the gate
// cannot claim a guarantee it did not verify.
const strict = process.env.HARNESS_SMOKE_STRICT === '1';
// When the flag is set the test RUNS; a daemon problem is asserted inside, so
// `HARNESS_DOCKER_SMOKE=1` with a broken daemon reddens the gate rather than
// skipping. Only the un-flagged case (plain `npm test`) named-skips.
const skip = enabled ? false : 'egress smoke not run: set HARNESS_DOCKER_SMOKE=1 with a Docker daemon available';

// ULA overlay makes the gateway hold a global IPv6 address so entrypoint.sh's
// strict ip6tables branch runs; the on-link gateway address the v6 leg dials.
const IPV6_OVERLAY = ['-f', 'compose.yaml', '-f', 'compose.ipv6.yaml', '--profile', 'cli'];
const IPV4_ONLY = ['-f', 'compose.yaml', '--profile', 'cli'];
const IPV6_GATEWAY_ADDR = 'fd42:7265:706f:7669::1';
const IPV6_NET_ERROR = /ipv6|ip6tables|inet6|enable_ipv6|address pool/i;

test('egress container smoke (actual container)', { skip }, async (t) => {
  // Flag set but daemon absent: fail, do not silently pass. The gate asked for
  // this smoke.
  assert.equal(
    spawnSync('docker', ['info'], { stdio: 'ignore' }).status, 0,
    'HARNESS_DOCKER_SMOKE=1 but the Docker daemon is not reachable (`docker info` failed)',
  );
  // Isolated workspace source so workspace-init's create_host_path:false bind has
  // a real dir without touching the repo checkout.
  const wsDir = fs.mkdtempSync(path.join(TMP, 'egress-ws-'));
  const env = { ...process.env, HARNESS_WORKSPACE_DIR: wsDir };
  let files = IPV6_OVERLAY;
  let ipv6Exercised = true;

  const dc = (args, opts = {}) => spawnSync('docker', ['compose', ...args], {
    cwd: DEMO_ROOT, encoding: 'utf-8', env, ...opts,
  });
  const gw = (script) => dc([...files, 'exec', '-T', 'egress-gw', 'sh', '-c', script]);

  const build = dc([...files, 'build']);
  assert.equal(build.status, 0, `image build failed:\n${build.stderr}`);

  let up = dc([...files, 'up', '-d', '--wait', 'egress-gw']);
  if (up.status !== 0 && IPV6_NET_ERROR.test(up.stderr)) {
    // The daemon cannot create an enable_ipv6 network (ip6tables management off,
    // or ipv6 disabled in-kernel). Downgrade to IPv4-only and mark the v6 leg
    // unexercised — never let this look like an egress failure.
    dc([...files, 'down', '-v', '--remove-orphans']);
    files = IPV4_ONLY;
    ipv6Exercised = false;
    up = dc([...files, 'up', '-d', '--wait', 'egress-gw']);
  }
  assert.equal(up.status, 0, `egress-gw failed to become healthy:\n${up.stderr}`);
  // Strict mode forbids the IPv6 downgrade: a required gate advertising the v6
  // fail-closed drop must actually exercise it, or go red for a human to fix
  // the runner's IPv6 support — never pass green with the branch unverified.
  assert.ok(
    ipv6Exercised || !strict,
    'HARNESS_SMOKE_STRICT=1 but the daemon could not create an enable_ipv6 network; the IPv6 fail-closed branch is unverified. Enable IPv6 on the runner or drop the strict flag.',
  );

  try {
    await t.test('default-deny is the last OUTPUT rule, allow-list ACCEPTs precede it', () => {
      // Non-vacuity: the allow-list ipsets must exist so an ACCEPT-before-DROP
      // ordering is meaningful and not a pass over an empty chain.
      assert.equal(gw('ipset list allowed >/dev/null').status, 0, 'allowed ipset exists');
      assert.equal(gw('ipset list allowed_cidrs >/dev/null').status, 0, 'allowed_cidrs ipset exists');

      const r = gw('iptables -S OUTPUT');
      assert.equal(r.status, 0, `iptables -S OUTPUT failed: ${r.stderr}`);
      const lines = r.stdout.trim().split('\n');
      assert.equal(lines[lines.length - 1], '-A OUTPUT -j DROP', 'DROP is the last OUTPUT rule');
      const dropIdx = lines.length - 1;
      const allowedIdx = lines.findIndex((l) => l.includes('--match-set allowed dst') && l.includes('-j ACCEPT'));
      const cidrsIdx = lines.findIndex((l) => l.includes('--match-set allowed_cidrs dst') && l.includes('-j ACCEPT'));
      assert.ok(allowedIdx >= 0 && allowedIdx < dropIdx, 'allowed set ACCEPT precedes DROP');
      assert.ok(cidrsIdx >= 0 && cidrsIdx < dropIdx, 'allowed_cidrs set ACCEPT precedes DROP');
    });

    await t.test('DNS: allow-listed name resolves, unlisted name gets no routable answer', () => {
      const allowed = gw('nslookup api.anthropic.com');
      assert.equal(allowed.status, 0, `nslookup api.anthropic.com failed: ${allowed.stderr}`);
      // The answer (after the Name: line) must be a real address, not a null one.
      const answer = allowed.stdout.split(/Name:/i)[1] || '';
      assert.ok(/Address:/i.test(answer), 'api.anthropic.com has an answer address');
      assert.ok(!/Address:\s*(0\.0\.0\.0|::)\s*$/im.test(answer), 'api.anthropic.com answer is routable');

      // dnsmasq's bare `--address=/#/` answers NXDOMAIN for unmatched names (an
      // IP argument would sinkhole to that IP instead). Accept either shape —
      // NXDOMAIN or a null address — and reject any routable answer.
      const blocked = gw('nslookup example.com');
      const blockedAnswer = blocked.stdout.split(/Name:/i)[1] || '';
      const routable = /Address:\s*(?!0\.0\.0\.0\s*$)(?!::\s*$)\S/im.test(blockedAnswer);
      assert.ok(!routable, `example.com must not get a routable answer, got:\n${blocked.stdout}`);
      assert.ok(
        blocked.status !== 0 || /0\.0\.0\.0|::|NXDOMAIN|can't find/i.test(blocked.stdout),
        `example.com lookup neither failed nor answered a null address:\n${blocked.stdout}`,
      );
    });

    await t.test('HTTPS: allow-listed host connects, non-allow-listed host is blocked', () => {
      const reach = gw('curl -sS -o /dev/null --connect-timeout 5 --max-time 10 https://api.anthropic.com/');
      assert.equal(reach.status, 0, `allow-listed HTTPS did not connect: ${reach.stderr}`);
      const block = gw('curl -sS -o /dev/null --connect-timeout 2 --max-time 4 https://example.com/');
      assert.notEqual(block.status, 0, 'non-allow-listed HTTPS must not connect');
    });

    await t.test('no docker.sock in the gateway', () => {
      assert.equal(gw('test ! -e /var/run/docker.sock').status, 0, '/var/run/docker.sock must be absent');
    });

    await t.test('IPv6 egress dropped (fail-closed branch)', {
      skip: ipv6Exercised ? false : 'IPv6 egress drop NOT exercised: daemon cannot create an enable_ipv6 network; v6 fail-closed branch unverified on this host',
    }, () => {
      // The overlay applied, so a global inet6 address MUST be present — otherwise
      // entrypoint.sh took the best-effort path and the strict branch is unproven.
      const v6 = gw('ip -6 addr show scope global');
      assert.match(v6.stdout, /inet6/, 'overlay applied but gateway has no global IPv6 — strict branch unverified');

      const rules = gw('ip6tables -S OUTPUT');
      assert.equal(rules.status, 0, `ip6tables -S OUTPUT failed: ${rules.stderr}`);
      const lines = rules.stdout.trim().split('\n');
      // The proof is that DROP terminates OUTPUT with no global-scope ACCEPT
      // before it: any v6 egress falls through to DROP. A connect attempt is
      // deliberately NOT asserted — a refused/timed-out dial cannot distinguish
      // the firewall from a closed port, so it would prove nothing.
      assert.equal(lines[lines.length - 1], '-A OUTPUT -j DROP', 'IPv6 DROP is the last OUTPUT rule');
      const v6Accept = lines.find((l) => l.includes('-j ACCEPT') && !l.includes('-o lo'));
      assert.equal(v6Accept, undefined, `no non-loopback IPv6 ACCEPT may precede DROP, found: ${v6Accept}`);
    });
    if (!ipv6Exercised) {
      console.error('egress-smoke: IPv6 leg NAMED-SKIPPED — daemon could not create the enable_ipv6 network; v6 fail-closed branch unverified on this host');
    }

    await t.test('worker container passes the in-image hardening probe', () => {
      const probe = dc([...files, 'run', '--rm', '--entrypoint', 'node', 'cli', 'test/fixtures/container-probe.mjs']);
      assert.equal(probe.status, 0, `worker probe failed:\n${probe.stdout}\n${probe.stderr}`);
    });
  } finally {
    dc([...files, 'down', '-v', '--remove-orphans']);
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});
