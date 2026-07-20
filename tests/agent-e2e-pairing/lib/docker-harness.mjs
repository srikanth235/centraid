// governance: allow-repo-hygiene file-size-limit (#363) single Docker-orchestration harness for the pairing e2e rig; the network/boot/exec/teardown surface is one cohesive unit
// Docker-backed harness for the cross-network-relay flow — see
// flows/cross-network-relay.mjs / .md for the ceremony itself. This module
// only knows how to stand up two non-interconnected Docker networks, boot
// the real daemon in one of them, and run the device role in the other; the
// mint/redeem/assert logic stays in the flow file, same split as
// lib/harness.mjs vs flows/*.mjs.
//
// Three things this file had to prove empirically before any of the above
// was worth writing (see the flow's .md for the full writeup):
//
//   1. The container needs the LINUX build of @number0/iroh's native
//      addon. The host's `bun install` only fetches the optional platform
//      package matching the HOST (e.g. darwin-arm64 on a Mac) — the
//      container (linux, whatever arch `docker run` defaults to, which
//      matches the Docker daemon's host, not necessarily the CI runner
//      unless they're the same machine) needs its own
//      `@number0/iroh-linux-<arch>-gnu`. ensureNativeAddon() detects and
//      fetches it additively (a new node_modules/@number0/* sibling,
//      nothing removed) if missing.
//   2. The gateway daemon shells out to a real `git` binary
//      (worktree-store/git.ts) on boot; node:22-bookworm-slim doesn't ship
//      one. apt-get installed once per gateway container start.
//   3. Isolation has to be enforced on THREE fronts, not one, and proven on
//      all of them. The docker-internal path first: on at least one real
//      Docker installation (OrbStack — see the flow .md) user-defined
//      bridge networks do NOT isolate each other by default, so this
//      harness does not trust the driver and adds explicit DOCKER-USER DROP
//      rules for the two subnets. But that alone is NOT enough, as this
//      flow's first run on a GitHub-hosted runner showed: both containers
//      NAT out through the host's single public NIC, iroh's relay-observed
//      address for the gateway is therefore the HOST's public IP, and a
//      dial to it matches no subnet rule. So the harness also drops traffic
//      from both test subnets to every host address (DOCKER-USER *and*
//      INPUT — see the comment at the insert site for why both).
//
//      And THAT still wasn't enough, which is the finding that produced the
//      third front. On an Azure-hosted GitHub runner (CI run 29733737906)
//      the flow reported ISOLATED and then selected a DIRECT path to
//      20.116.79.56:64512. That address is the runner's PUBLIC, NAT-mapped
//      address — the one the n0 relay observes and hands out as the peer's
//      direct candidate. It exists on NO local interface (Azure NATs it
//      upstream), so hostAddresses() — which enumerates `ip -4 -o addr
//      show` — structurally cannot see it and no address-based DROP rule
//      could ever have covered it. Discovering it would need an external
//      lookup service and would vary per runner; a moving target is not a
//      foundation for a hard gate. So the third front blocks by TRANSPORT
//      instead, which is host-independent: every direct path iroh can build
//      is QUIC over UDP, whereas the n0 relay's data path is a WebSocket
//      over TLS over TCP 443 (iroh-relay 1.0.2's client.rs rewrites the
//      relay URL's scheme to `wss` and dials with TcpStream::connect — there
//      is no QUIC in the relay transport at all). Both test subnets
//      therefore DROP all UDP except dport 53 (DNS), which leaves the relay
//      entirely untouched and every direct candidate — enumerable or not —
//      with nowhere to land. That asymmetry is the whole trick, and it's why
//      this degrades correctly: these rules cannot break the connection,
//      only its directness.
//
//      Deliberately NOT allowed: iroh's QUIC address discovery on UDP 7842
//      (DEFAULT_RELAY_QUIC_PORT, iroh-relay/src/defaults.rs). QAD is how a
//      peer learns its own public NAT-mapped address — the very mechanism
//      that produced 20.116.79.56 above — so blocking it attacks the failure
//      at its source rather than only blocking the dial that follows.
//
//      All three fronts are proven before the ceremony runs, by probes that
//      dial each path rather than re-testing the rule just installed: raw
//      TCP for the two address-based fronts, and a self-validating UDP echo
//      probe (control datagram first, so silence is evidence of blocking
//      rather than of a probe server that never came up) for the port-class
//      front. The one ACCEPT that probe needs — the echo server's replies
//      come FROM a test subnet, so our own DROP rules would eat them — is
//      scoped to the probe and deleted before the ceremony starts, with its
//      absence read back out of `iptables -S`. The ceremony must not run with
//      a probe-shaped hole in the very block it exists to prove closed.
//
//      That ACCEPT has to outrank the HOST-ADDRESS drops, not just the
//      port-class one, and getting this wrong is the third correction this
//      design has needed. CI run 29743139605 failed the control because the
//      exception was inserted inside the port-class block and therefore landed
//      BELOW the host-address DROPs: the control dials a host address, so the
//      echo server's reply carries src=<test subnet>, dst=<that host address>,
//      which is exactly what those DROPs match. The blocked packet was the
//      REPLY, not the request — "the control comes from the host, which no
//      rule matches" is true only of the outbound direction. The exception is
//      therefore inserted LAST of all (block (d)), so it evaluates FIRST. It
//      does not weaken the test: it matches --sport 9999, while every probe
//      REQUEST leaves from an ephemeral port, so the requests still fall
//      through to the DROPs they exist to exercise.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ensureBuilt, parseTicket } from './harness.mjs';
import { defaultRunId, writeFlowVerdict } from '../../agent-e2e-shared/harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNS_DIR = path.join(__dirname, '..', 'runs');
const NODE_IMAGE = 'node:22-bookworm-slim';
const GATEWAY_CLI_REL = 'packages/gateway/dist/cli/cli.js';
const DEVICE_SCRIPT_REL = 'tests/agent-e2e-pairing/lib/device-redeem.mjs';
const GW_DATA_DIR = '/tmp/gw-data';
// The ONLY UDP destination port anything here legitimately needs: 53, or the
// containers can't resolve the relay hostnames at all.
//
// Notably NOT 443, and the reason matters enough to write down, because the
// intuitive guess ("QUIC, so UDP 443") is wrong and an earlier revision of
// this file encoded that guess as a firewall rule. In iroh 1.0.2 /
// iroh-relay 1.0.2 (the versions all three of this repo's lockfiles pin) the
// relay-carried DATA path is a WebSocket over TLS over TCP 443:
// iroh-relay/src/client.rs rewrites the relay URL's `https` scheme to `wss`
// and dials with TcpStream::connect, and the production relay URLs
// (https://use1-1.relay.n0.iroh.link etc.) carry no explicit port. There is
// no QUIC in the relay data transport at all. So these rules — which touch
// only UDP — cannot break the relay, and that is precisely why the flow
// degrades correctly: block every UDP escape and the relay still carries the
// connection over TCP.
//
// The only UDP the relay speaks is QUIC address discovery (QAD), on
// DEFAULT_RELAY_QUIC_PORT = 7842 (iroh-relay/src/defaults.rs), driven by the
// QadIpv4/QadIpv6 probes in net_report/reportgen.rs. That is deliberately NOT
// allowed: QAD is the mechanism by which a peer learns its own public
// NAT-mapped address, i.e. the exact mechanism that produced the
// 20.116.79.56 direct candidate which defeated the previous fix. Blocking it
// attacks the failure at its source rather than only blocking the dial it
// leads to. (STUN/3478 does not appear here either — it's gone in iroh 1.0.x;
// the surviving `re_stun` identifiers are vestigial names that now drive QAD.)
const ALLOWED_UDP_DPORTS = [53];
// In-container port the isolation probe's UDP echo server listens on. Named
// here because the port-class rules need to know it: see the ACCEPT carved for
// its replies at the insert site.
const PROBE_UDP_PORT = 9999;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => (stdout += c));
    child.stderr?.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

async function sh(cmd, args, opts = {}) {
  const { code, stdout, stderr } = await run(cmd, args, opts);
  if (code !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim() || stdout.trim()}`);
  }
  return stdout;
}

async function shQuiet(cmd, args, opts = {}) {
  // Best-effort teardown step: never throw, just report.
  try {
    await sh(cmd, args, opts);
  } catch (e) {
    console.error(`  [teardown warning] ${cmd} ${args.join(' ')}: ${e.message}`);
  }
}

/**
 * Confirm the container image can load @centraid/tunnel's native iroh
 * addon; fetch the missing linux platform package if the host's own `bun
 * install` (which only resolves optionalDependencies for the HOST platform)
 * didn't already provide it. Purely additive — writes a new sibling under
 * node_modules/@number0/, never touches the host's own platform package.
 */
async function ensureNativeAddon() {
  const archMap = { arm64: 'arm64', x64: 'x64' };
  const arch = archMap[process.arch];
  if (!arch) {
    throw new Error(
      `cross-network-relay: unsupported host arch "${process.arch}" — only arm64/x64 have ` +
        `published @number0/iroh-linux-*-gnu packages`,
    );
  }
  const pkgName = `iroh-linux-${arch}-gnu`;
  const pkgDir = path.join(REPO_ROOT, 'node_modules', '@number0', pkgName);
  const addonFile = path.join(pkgDir, `iroh.linux-${arch}-gnu.node`);
  try {
    await fs.access(addonFile);
    console.log(`[docker-harness] @number0/${pkgName} already present`);
  } catch {
    const irohPkgJson = JSON.parse(
      await fs.readFile(
        path.join(REPO_ROOT, 'node_modules', '@number0', 'iroh', 'package.json'),
        'utf8',
      ),
    );
    const version = irohPkgJson.version;
    console.log(
      `[docker-harness] @number0/${pkgName}@${version} missing — the host's bun install only ` +
        `fetched the host-platform optional dep; fetching the linux one additively for the container…`,
    );
    const script = [
      'set -e',
      'cd /tmp',
      `npm pack @number0/${pkgName}@${version} --silent >/dev/null`,
      `tar xzf number0-${pkgName}-${version}.tgz`,
      `mkdir -p /repo/node_modules/@number0/${pkgName}`,
      `cp -r package/* /repo/node_modules/@number0/${pkgName}/`,
    ].join(' && ');
    await sh('docker', [
      'run',
      '--rm',
      '-v',
      `${REPO_ROOT}:/repo`,
      NODE_IMAGE,
      'bash',
      '-c',
      script,
    ]);
  }

  // Verified, not assumed: actually load @centraid/tunnel inside a
  // throwaway container and confirm the native addon resolves before
  // trusting the rest of the flow to it.
  const { code, stdout, stderr } = await run('docker', [
    'run',
    '--rm',
    '-v',
    `${REPO_ROOT}:/repo`,
    '-w',
    '/repo',
    NODE_IMAGE,
    'node',
    '-e',
    "try { require('@centraid/tunnel'); console.log('OK'); } " +
      'catch (e) { console.error(e.message); process.exit(1); }',
  ]);
  if (code !== 0 || !stdout.includes('OK')) {
    throw new Error(
      `cross-network-relay: @centraid/tunnel's native addon does not load inside ${NODE_IMAGE} ` +
        `even after fetching @number0/${pkgName} — ${stderr.trim() || stdout.trim()}`,
    );
  }
  console.log(
    '[docker-harness] @centraid/tunnel native addon loads inside the container — confirmed',
  );
}

async function dockerNetworkCreate(name) {
  // --ipv6=false matters beyond tidiness: on at least one host (OrbStack —
  // see the flow .md), containers get a REAL globally-routable IPv6 address
  // (NDP-proxied from the host's own WAN prefix, not a Docker-private ULA),
  // so two containers on "isolated" IPv4-only networks could still dial
  // each other directly over IPv6 and never touch the relay path this flow
  // exists to exercise. Forcing IPv4-only removes that escape hatch
  // entirely rather than trying to firewall an address range that varies
  // by host/ISP.
  await sh('docker', ['network', 'create', '--driver', 'bridge', '--ipv6=false', name]);
  const inspectOut = await sh('docker', [
    'network',
    'inspect',
    name,
    '--format',
    '{{range .IPAM.Config}}{{.Subnet}}\n{{end}}',
  ]);
  // IPv4 + IPv6 subnets are both listed; take the IPv4 one (contains a dot).
  const subnet = inspectOut
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.includes('.'));
  if (!subnet) throw new Error(`network ${name} has no IPv4 subnet in IPAM config`);
  return subnet;
}

/** Poll `docker logs <name>` for the same readiness lines lib/harness.mjs's spawnDaemon waits for. */
async function waitForGatewayReady(containerName, logFile, { timeoutMs = 90000 } = {}) {
  const wanted = { url: undefined, token: undefined, endpointId: undefined };
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { code: inspectCode, stdout: statusOut } = await run('docker', [
      'inspect',
      containerName,
      '--format',
      '{{.State.Status}}',
    ]);
    const logs = await sh('docker', ['logs', containerName]);
    wanted.url ??= logs.match(/listening on (http:\/\/[^\s]+)/)?.[1];
    wanted.token ??= logs.match(/token: ([0-9a-f]+)/)?.[1];
    wanted.endpointId ??= logs.match(/endpoint: ([0-9a-f]{64})/)?.[1];
    if (wanted.url && wanted.token && wanted.endpointId) {
      await fs.writeFile(logFile, logs);
      return wanted;
    }
    if (inspectCode === 0 && statusOut.trim() === 'exited') {
      await fs.writeFile(logFile, logs);
      throw new Error(`gateway container ${containerName} exited before ready — see ${logFile}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const logs = await sh('docker', ['logs', containerName]).catch(() => '(logs unavailable)');
  await fs.writeFile(logFile, logs);
  throw new Error(
    `gateway container ${containerName} not ready in ${timeoutMs}ms (url=${wanted.url} ` +
      `endpoint=${wanted.endpointId}) — see ${logFile}`,
  );
}

/**
 * Host IPv4 addresses a container could route to INSTEAD of the peer's
 * docker-internal IP — the escape hatch that made this flow's first
 * GitHub-Actions run report a direct path (see the flow .md). Enumerated at
 * run time inside the privileged host-network helper, because the set is
 * host-specific (an Azure runner has one public NIC address; a laptop has
 * several).
 *
 * Interfaces deliberately skipped:
 *   - `lo`: never a cross-container path.
 *   - `docker0` / `br-*`: these ARE the bridge gateways the test networks use
 *     as their next hop. Dropping traffic *to* them would cut the containers'
 *     legitimate internet egress (apt-get, the n0 relays) along with the
 *     escape hatch — and they're not an escape hatch anyway, since anything
 *     forwarded through them toward the peer subnet is already covered by the
 *     subnet-to-subnet rules.
 *   - `veth*`: the host-side halves of container pairs, same reasoning.
 */
async function hostAddresses(fwName) {
  const out = await sh('docker', ['exec', fwName, 'ip', '-4', '-o', 'addr', 'show']);
  const addrs = [];
  for (const line of out.split('\n')) {
    // "2: eth0    inet 10.1.0.4/16 brd 10.1.255.255 scope global eth0"
    const m = line.match(/^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)\//);
    if (!m) continue;
    const [, iface, addr] = m;
    if (
      iface === 'lo' ||
      iface === 'docker0' ||
      iface.startsWith('br-') ||
      iface.startsWith('veth')
    ) {
      continue;
    }
    if (!addrs.includes(addr)) addrs.push(addr);
  }
  return addrs;
}

/** Probe script body: dial every target concurrently, report one verdict each. */
function probeScript(targets) {
  return `
    const net = require('net');
    const targets = ${JSON.stringify(targets)};
    const results = [];
    let pending = targets.length;
    for (const t of targets) {
      const s = net.createConnection({ host: t.host, port: t.port, timeout: 4000 });
      let settled = false;
      const done = (verdict) => {
        if (settled) return;
        settled = true;
        s.destroy();
        results.push({ label: t.label, verdict });
        if (--pending === 0) { console.log(JSON.stringify(results)); process.exit(0); }
      };
      s.on('connect', () => done('REACHABLE'));
      s.on('timeout', () => done('blocked (timeout)'));
      s.on('error', (e) => done('blocked (' + e.code + ')'));
    }
  `;
}

/**
 * UDP counterpart of probeScript: send one datagram per target and wait for
 * the echo server to send it back. UDP has no connect handshake, so the ONLY
 * positive signal available is a reply actually coming back — which is why
 * every caller of this has to establish a control first (see
 * verifyNetworksIsolated). Silence on its own means "no reply", and "no reply"
 * is only evidence of blocking once something has proven a reply was possible.
 */
function udpProbeScript(targets) {
  return `
    const dgram = require('dgram');
    const targets = ${JSON.stringify(targets)};
    const results = [];
    let pending = targets.length;
    for (const t of targets) {
      const s = dgram.createSocket('udp4');
      let settled = false;
      const done = (verdict) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { s.close(); } catch {}
        results.push({ label: t.label, verdict });
        if (--pending === 0) { console.log(JSON.stringify(results)); process.exit(0); }
      };
      const timer = setTimeout(() => done('blocked (no reply in 4000ms)'), 4000);
      s.on('message', () => done('REACHABLE'));
      s.on('error', (e) => done('blocked (' + (e.code || e.message) + ')'));
      s.send(Buffer.from('probe'), t.port, t.host, (e) => {
        if (e) done('blocked (' + (e.code || e.message) + ')');
      });
    }
  `;
}

/** Run one probe container/exec and parse its single JSON verdict line. */
async function runProbe(dockerArgs, script, what) {
  const { code, stdout } = await run('docker', [...dockerArgs, 'node', '-e', script]);
  try {
    return JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
  } catch {
    throw new Error(`${what} printed no verdict JSON (exit ${code}): ${stdout.trim()}`);
  }
}

/**
 * Raw cross-network probes — isolation proven topologically, independent of
 * the app under test.
 *
 * FOUR classes of probe, because each one covers a front the others structurally
 * cannot, and because the original single probe was tautological: it dialed
 * only the peer's docker-internal IP, which is exactly and only the traffic
 * the subnet-to-subnet DROP rules block. It therefore re-tested the rule that
 * had just been installed and could not observe the host-routed path that
 * actually carried a direct connection on CI.
 *
 *   1. TCP docker-internal — netB → netA container IP (the original probe).
 *   2. TCP host-routed — netB → each host address, at a port published from the
 *      netA probe server. Publishing is what makes this reachable at all in
 *      the absence of the DROP rules, so it's a strictly harder test than the
 *      unpublished topology the ceremony itself runs on.
 *   3/4. The UDP counterparts of both, at a published UDP port on the same
 *      probe server. These are what actually exercise the port-class DROP
 *      rules, and they matter because the escape that broke this flow on an
 *      Azure runner was QUIC/UDP to an address no rule of class (1)/(2) could
 *      ever have named (see the module docstring). "The TCP probe was blocked"
 *      was only ever evidence for, not proof of, "no UDP path exists"; now the
 *      UDP path is measured directly.
 *
 * Any probe getting through fails the flow, naming which path leaked.
 *
 * The UDP probes are self-validating, because a UDP probe on its own cannot
 * tell "blocked" from "the echo server never came up" — both look like
 * silence, and a silently-broken probe would report ISOLATED for entirely the
 * wrong reason. So a CONTROL runs first, from the privileged host-network
 * helper: it sends the same datagrams to the same two target classes and
 * REQUIRES replies. Only once the server has demonstrably answered is silence
 * from netB treated as evidence of blocking; if the control is silent, this
 * throws instead of reporting isolation it hasn't earned.
 *
 * What makes the control work is NOT that its source address is the host and
 * therefore matches no rule of ours. That is true of the control's outbound
 * datagram and false of the reply, which is the packet that actually has to
 * survive: the echo server sits on netA, so its reply carries src=<subnetA>
 * and dst=<the host address the control dialed> — matching the (c) host-address
 * DROP head-on. CI run 29743139605 failed the control on exactly that. The
 * control works only because the probe's `--sport` ACCEPT is inserted AFTER
 * blocks (b) and (c) and so outranks them; see block (d) at the insert site.
 * That ACCEPT is the caller's to retire the moment this returns — see the
 * removal right after the call site. Nothing in here should be relied on to
 * still be in force once the ceremony starts.
 */
async function verifyNetworksIsolated(netA, netB, hostAddrs, fwName) {
  const probeServerName = `pairing-relay-isoprobe-${crypto.randomBytes(3).toString('hex')}`;
  // High random ports so concurrent runs on one host don't collide; `docker
  // run` fails loudly rather than silently sharing if one is already bound.
  const hostPort = 30000 + Math.floor(Math.random() * 20000);
  const udpHostPort = 30000 + Math.floor(Math.random() * 20000);
  await sh('docker', [
    'run',
    '-d',
    '--name',
    probeServerName,
    '--network',
    netA,
    '-p',
    `${hostPort}:8080`,
    '-p',
    `${udpHostPort}:${PROBE_UDP_PORT}/udp`,
    NODE_IMAGE,
    'node',
    '-e',
    "require('http').createServer((_q,r)=>r.end('probe')).listen(8080,'0.0.0.0');" +
      "const d=require('dgram').createSocket('udp4');" +
      "d.on('message',(m,ri)=>d.send(m,ri.port,ri.address));" +
      `d.bind(${PROBE_UDP_PORT},'0.0.0.0');`,
  ]);
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const ip = (
      await sh('docker', [
        'inspect',
        probeServerName,
        '--format',
        `{{(index .NetworkSettings.Networks "${netA}").IPAddress}}`,
      ])
    ).trim();
    const targets = [
      { label: `docker-internal ${ip}:8080`, host: ip, port: 8080 },
      ...hostAddrs.map((h) => ({ label: `host-routed ${h}:${hostPort}`, host: h, port: hostPort })),
    ];
    // The UDP targets mirror the TCP ones one-for-one: same two classes, same
    // server, so a leak on either transport is reported in the same shape.
    const udpTargets = [
      { label: `udp docker-internal ${ip}:${PROBE_UDP_PORT}`, host: ip, port: PROBE_UDP_PORT },
      ...hostAddrs.map((h) => ({
        label: `udp host-routed ${h}:${udpHostPort}`,
        host: h,
        port: udpHostPort,
      })),
    ];

    // CONTROL first — from the host-network helper, which our rules don't
    // match, so every one of these MUST come back. Anything silent here means
    // the probe itself is broken (server not listening, publish not wired up)
    // and the netB run below would be meaningless.
    const control = await runProbe(
      ['exec', fwName],
      udpProbeScript(udpTargets),
      'UDP control probe',
    );
    const deadControls = control.filter((r) => r.verdict !== 'REACHABLE');
    if (deadControls.length > 0) {
      throw new Error(
        `UDP isolation probe is not trustworthy: the control run (from the host network) got no ` +
          `reply from ${deadControls.map((r) => `${r.label}: ${r.verdict}`).join('; ')}. Either ` +
          `the echo server / its port publishing is broken, or one of our own DROP rules is ` +
          `eating the server's REPLY (it leaves netA for the dialed host address, so the (c) ` +
          `host-address DROP matches it unless the probe's --sport ACCEPT outranks (c) — see ` +
          `block (d) in this file). Silence from ${netB} would prove nothing either way — ` +
          `refusing to report isolation this probe hasn't actually established.`,
      );
    }

    const results = [
      ...(await runProbe(
        ['run', '--rm', '--network', netB, NODE_IMAGE],
        probeScript(targets),
        'TCP isolation probe container',
      )),
      ...(await runProbe(
        ['run', '--rm', '--network', netB, NODE_IMAGE],
        udpProbeScript(udpTargets),
        'UDP isolation probe container',
      )),
    ];
    const leaked = results.filter((r) => r.verdict === 'REACHABLE');
    if (leaked.length > 0) {
      throw new Error(
        `network isolation NOT confirmed: a container on ${netB} reached ${netA} via ` +
          `${leaked.map((r) => r.label).join(', ')}. The DOCKER-USER/INPUT address and ` +
          `port-class DROP rules didn't ` +
          `take effect on ${leaked.length === results.length ? 'any' : 'that'} path; refusing ` +
          `to proceed since the flow's relay-path proof would be meaningless on a topology ` +
          `that isn't actually isolated.`,
      );
    }
    // Honest status: the per-target reason is preserved rather than flattened
    // to a single word, so "blocked (timeout)" and "blocked (ECONNREFUSED)"
    // stay distinguishable in the log and the verdict file.
    return `ISOLATED — ${results.map((r) => `${r.label}: ${r.verdict}`).join('; ')}`;
  } finally {
    await shQuiet('docker', ['rm', '-f', probeServerName]);
  }
}

/**
 * Read the live rule set back and confirm the probe's `--sport` ACCEPT
 * exceptions are gone, so the ceremony runs with no probe-shaped hole in the
 * port-class block.
 *
 * `iptables -S` renders the rules it would need to recreate the chain, so a
 * surviving exception shows up verbatim as `--sport <PROBE_UDP_PORT>`. Any
 * ACCEPT still matching that is reported with the chain and the full rule
 * text, since the failure mode this guards against — the removal silently not
 * happening — would otherwise be invisible.
 *
 * Scoped to THIS run's subnets, so an unrelated pre-existing host rule that
 * happens to mention the same port can't fail the flow.
 */
async function verifyProbeExceptionsRemoved(fwName, subnets) {
  const survivors = [];
  for (const chain of ['DOCKER-USER', 'INPUT']) {
    const dump = await sh('docker', ['exec', fwName, 'iptables', '-S', chain]);
    for (const line of dump.split('\n')) {
      if (!line.includes(`--sport ${PROBE_UDP_PORT}`)) continue;
      if (!subnets.some((s) => line.includes(s))) continue;
      survivors.push(`${chain}: ${line.trim()}`);
    }
  }
  if (survivors.length > 0) {
    throw new Error(
      `the isolation probe's UDP ACCEPT exception outlived the probe — still present as ` +
        `${survivors.join('; ')}. The ceremony would run with a UDP hole in exactly the ` +
        `port-class block it is meant to prove closed; refusing to proceed rather than ` +
        `producing a relay-path verdict with a known exception open.`,
    );
  }
  return `no --sport ${PROBE_UDP_PORT} ACCEPT remains in DOCKER-USER or INPUT (iptables -S read back)`;
}

/**
 * Run the cross-network-relay flow: build → native-addon preflight →
 * isolated networks (+ proof) → gateway container boot → exec the flow body
 * → verdict → teardown (containers, firewall rules, networks — all
 * best-effort in a `finally`, run-scoped names so concurrent runs never
 * collide).
 *
 * ctx surface:
 *   ctx.gateway                 — { url, token, endpointId } of the live daemon
 *   ctx.netB                    — the device-side network name (for docker run --network)
 *   ctx.gatewayExec(args)       — run the admin CLI inside the gateway container
 *   ctx.mintTicket(opts)        — pair → { raw, payload }
 *   ctx.runDevice(opts)         — run lib/device-redeem.mjs in a fresh container on netB;
 *                                  opts: { ticket, probeTarget }; returns the parsed JSON line
 *   ctx.readGatewayFile(rel)    — parse a JSON file under the gateway's data dir
 *   ctx.note(msg)                — observation preserved in verdict.md
 */
export async function runFlow(slug, fn) {
  await ensureBuilt();
  await ensureNativeAddon();

  const runId = `${slug}-${defaultRunId()}`;
  const runDir = path.join(RUNS_DIR, runId);
  await fs.mkdir(runDir, { recursive: true });

  const suffix = crypto.randomBytes(4).toString('hex');
  const netA = `pairing-relay-a-${suffix}`;
  const netB = `pairing-relay-b-${suffix}`;
  const gwName = `pairing-relay-gw-${suffix}`;
  const fwName = `pairing-relay-fw-${suffix}`;
  let deviceRunCount = 0;

  const state = {
    runId,
    runDir,
    netA,
    netB,
    gwName,
    subnetA: undefined,
    subnetB: undefined,
    gateway: undefined,
  };
  console.log(`[runFlow] ${slug}`);
  console.log(`  run dir : ${path.relative(REPO_ROOT, runDir)}`);
  console.log(`  networks: ${netA} (gateway) / ${netB} (device) — not interconnected`);

  const notes = [];
  let error, result;
  // Each successfully-inserted DOCKER-USER/INPUT rule gets its exact `-D` teardown
  // args pushed here as it's inserted — NOT a single boolean flipped after
  // both inserts succeed. These rules land directly in the HOST's real
  // netfilter tables (the helper container runs --privileged --network
  // host), so if the first insert succeeds and the second throws, the first
  // must still be torn down; a single "both-or-nothing" flag would leak it.
  const firewallRulesInserted = [];
  const t0 = Date.now();

  try {
    state.subnetA = await dockerNetworkCreate(netA);
    state.subnetB = await dockerNetworkCreate(netB);
    console.log(`  subnets : ${netA}=${state.subnetA} ${netB}=${state.subnetB}`);

    // Explicit isolation (see module docstring point 3) — DOCKER-USER is
    // Docker's documented hook chain for user firewall rules, evaluated
    // before Docker's own bridge rules, so this holds regardless of
    // whether the driver's own default isolation does.
    await sh('docker', [
      'run',
      '-d',
      '--name',
      fwName,
      '--privileged',
      '--network',
      'host',
      NODE_IMAGE,
      'sleep',
      'infinity',
    ]);
    await sh('docker', [
      'exec',
      fwName,
      'bash',
      '-c',
      'apt-get update -qq >/dev/null 2>&1 && ' +
        'apt-get install -y -qq iptables iproute2 >/dev/null 2>&1',
    ]);
    // Generic over the match: callers pass the full match-args array and the
    // -j target, so an address rule, a port-class DROP and its ACCEPT
    // exceptions all go through this one path rather than a parallel one.
    const insertRule = async (chain, matchArgs, target) => {
      const rule = [...matchArgs, '-j', target];
      const deleteArgs = ['exec', fwName, 'iptables', '-D', chain, ...rule];
      await sh('docker', ['exec', fwName, 'iptables', '-I', chain, ...rule]);
      // Recorded immediately after THIS insert succeeds, not after all of
      // them — so a throw partway through still leaves everything that
      // landed queued for teardown.
      firewallRulesInserted.push(deleteArgs);
      // Returned so a caller can retire a rule EARLY (see the probe-exception
      // removal below); the returned array is the same object that's queued
      // for teardown, so removing it from the queue is an identity check.
      return deleteArgs;
    };

    // (a) Port-class rules: the front that address-based rules structurally
    // cannot cover. See the module docstring — the direct path that survived
    // (b) and (c) on an Azure runner went to the runner's PUBLIC, NAT-mapped
    // address, which appears on no local interface and so can never be
    // enumerated by (c). Rather than chase an address that varies per runner
    // and needs an external lookup to discover, block by TRANSPORT, which is
    // host-independent. Everything iroh does to reach a peer DIRECTLY is
    // QUIC over UDP; the n0 relay's data path is a WebSocket over TLS over
    // TCP 443 (see ALLOWED_UDP_DPORTS for the sources). So the policy is
    // simply: DROP all UDP out of each test subnet except DNS. TCP is
    // untouched, so apt-get and — crucially — the relay itself keep working.
    // Blocking UDP wholesale also blocks iroh's QUIC address discovery on
    // 7842, which is intended: that is how a peer learns the public
    // NAT-mapped address that defeated the previous fix.
    //
    // ORDER, which silently inverts if you get it wrong: `iptables -I` inserts
    // at position 1, so the LAST rule inserted is the FIRST evaluated. The
    // catch-all DROP therefore has to be inserted BEFORE its ACCEPT
    // exception, so that the ACCEPT ends up ahead of it. Resulting evaluation
    // order within this block, top-first: ACCEPT dport 53, DROP udp.
    //
    // This whole block is also inserted before (b) and (c) for the same
    // reason at a larger scale: those address-based DROP rules must land
    // nearer position 1 than the ACCEPT exception here, so an address (c)
    // covers stays covered rather than being let through by this ACCEPT.
    //
    // The probe's own ACCEPT exception is NOT here — it has to outrank (c) as
    // well, so it is inserted after (c). See the block below (c) for why.
    //
    // Both chains, for the same two-fates reason spelled out at (c).
    for (const chain of ['DOCKER-USER', 'INPUT']) {
      for (const subnet of [state.subnetA, state.subnetB]) {
        await insertRule(chain, ['-s', subnet, '-p', 'udp'], 'DROP');
        for (const port of ALLOWED_UDP_DPORTS) {
          await insertRule(chain, ['-s', subnet, '-p', 'udp', '--dport', String(port)], 'ACCEPT');
        }
      }
    }
    console.log(
      `  udpclass: DROP all UDP from both test subnets except dport ` +
        `${ALLOWED_UDP_DPORTS.join('/')} (relay is TCP 443, so it is unaffected)`,
    );

    // (b) Peer-subnet rules: the docker-internal path. DOCKER-USER is
    // Docker's documented hook chain for user firewall rules, evaluated
    // before Docker's own bridge rules, so this holds regardless of whether
    // the driver's own default isolation does.
    await insertRule('DOCKER-USER', ['-s', state.subnetA, '-d', state.subnetB], 'DROP');
    await insertRule('DOCKER-USER', ['-s', state.subnetB, '-d', state.subnetA], 'DROP');

    // (c) Host-address rules: the escape hatch that made this flow's first
    // run on a GitHub-hosted runner select a DIRECT path despite (b) being
    // in force. Both containers NAT out through the host's single public
    // NIC, so iroh's relay-observed public address for the gateway is the
    // HOST's public IP — a destination (b) doesn't match, since it isn't in
    // either test subnet. (This covers only host addresses that actually
    // appear on a local interface; the ones that don't are what (a) is for.)
    //
    // Installed into BOTH chains on purpose, because a packet a container
    // sends to a host address has two possible fates and only one of them
    // reaches DOCKER-USER:
    //   - un-NAT'd/hairpinned back toward a container → routed as FORWARD →
    //     DOCKER-USER (and, with the destination already rewritten to the
    //     peer's container IP by then, (a) catches it too);
    //   - delivered to the host itself → routed as INPUT, which DOCKER-USER
    //     never sees. Hence the INPUT copy.
    // Between them the two chains cover both outcomes by construction rather
    // than by assuming which one a given host's netfilter path produces.
    // No `-p`, so TCP and UDP (i.e. QUIC) alike.
    const hostAddrs = await hostAddresses(fwName);
    if (hostAddrs.length === 0) {
      throw new Error(
        'no non-loopback, non-bridge host IPv4 address found — cannot install the ' +
          'host-routed isolation rules, and without them a direct path can survive ' +
          'the subnet rules (see flows/cross-network-relay.md)',
      );
    }
    for (const hostAddr of hostAddrs) {
      for (const subnet of [state.subnetA, state.subnetB]) {
        await insertRule('DOCKER-USER', ['-s', subnet, '-d', hostAddr], 'DROP');
        await insertRule('INPUT', ['-s', subnet, '-d', hostAddr], 'DROP');
      }
    }
    console.log(`  hostaddr: DROP ${hostAddrs.join(', ')} from both test subnets`);

    // (d) The probe's ONE exception, inserted LAST so it evaluates FIRST —
    // ahead of (c), (b) and (a) alike. It is not part of the relay path; it
    // belongs to the PROBE, and it is retired the moment the probe is done
    // (see the removal after verifyNetworksIsolated). It exists because the
    // isolation probe's UDP echo server lives on netA, so its REPLY datagrams
    // originate from a test subnet and our own DROP rules would eat them — the
    // control run would then be silent for reasons that have nothing to do
    // with isolation, i.e. exactly the false-ISOLATED failure mode the control
    // exists to rule out.
    //
    // It sits above (c) rather than merely above (a), and that placement is
    // the whole point of this block being here instead of up there. An earlier
    // revision inserted it inside (a), which put it BELOW (c), and CI run
    // 29743139605 failed the control on precisely that: the control dials a
    // HOST address, so the echo server's reply carries src=<subnetA>
    // sport=9999 and dst=<hostAddr> — which is exactly what (c) drops
    // (`-s <subnet> -d <hostAddr> -j DROP`, in both chains). The reply, not
    // the request, was the packet being blocked; the error message's premise
    // ("from the host network, which no isolation rule matches") was true of
    // the outbound datagram and false of the return one. The docker-internal
    // control leg passed in that same run and is the tell: its reply goes to
    // the bridge address 172.x.0.1, which hostAddresses() deliberately skips,
    // so no (c) rule named it.
    //
    // Why this does NOT defeat the test it exists to enable:
    //   - The netB host-routed UDP probe sends from an EPHEMERAL source port
    //     (Linux 32768-60999, so never 9999) to the published dport. It
    //     therefore does not match `--sport 9999`, falls through to (c)'s
    //     `-s <subnetB> -d <hostAddr>` DROP, and is still blocked. The probe
    //     still proves exactly what it claims.
    //   - The netB docker-internal UDP probe likewise carries dport 9999, not
    //     sport 9999, so it falls through to (b)'s subnet-to-subnet DROP.
    //   - Both TCP probes are untouched: this rule is `-p udp`.
    //   - The only packet the exemption admits is the echo server's reply, and
    //     the exemption is retired before the ceremony starts, with its absence
    //     read back out of `iptables -S` (verifyProbeExceptionsRemoved).
    //
    // The netB copy of the rule is dead weight — no echo server ever runs on
    // netB — but it is kept for symmetry with every other rule here and is
    // retired on the same schedule, so it is never open during the ceremony.
    //
    // These stay in firewallRulesInserted until they are actually removed, so
    // the failure path needs no second teardown.
    const probeExceptionRules = [];
    for (const chain of ['DOCKER-USER', 'INPUT']) {
      for (const subnet of [state.subnetA, state.subnetB]) {
        probeExceptionRules.push(
          await insertRule(
            chain,
            ['-s', subnet, '-p', 'udp', '--sport', String(PROBE_UDP_PORT)],
            'ACCEPT',
          ),
        );
      }
    }

    const isolationVerdict = await verifyNetworksIsolated(netA, netB, hostAddrs, fwName);
    notes.push(`network isolation verified before ceremony: ${isolationVerdict}`);
    console.log(`  isolate : ${isolationVerdict}`);

    // The probe is done, so its affordance goes away before the ceremony
    // starts. Bookkeeping is explicit rather than implicit: each rule is
    // spliced out of firewallRulesInserted only AFTER its `-D` actually
    // succeeded, so a failure here leaves the entry queued and the `finally`
    // retries it — and a success can't produce a double `-D`.
    for (const deleteArgs of probeExceptionRules) {
      await sh('docker', deleteArgs);
      const queued = firewallRulesInserted.indexOf(deleteArgs);
      if (queued >= 0) firewallRulesInserted.splice(queued, 1);
    }
    // Asserted, not assumed — and asserted the only way that's actually
    // falsifiable. A post-removal UDP re-probe would be worthless here: taking
    // the --sport ACCEPT away also removes the echo server's ability to reply
    // at all, so silence becomes guaranteed by construction whether or not the
    // DROP works, and the probe would no longer be self-validating. Reading
    // the live rule set back is cheap (two execs, no wall-clock to speak of)
    // and proves exactly the claim being made.
    const closedVerdict = await verifyProbeExceptionsRemoved(fwName, [
      state.subnetA,
      state.subnetB,
    ]);
    notes.push(`ceremony ran with the port-class UDP block fully closed: ${closedVerdict}`);
    console.log(`  udpshut : ${closedVerdict}`);

    await sh('docker', [
      'run',
      '-d',
      '--name',
      gwName,
      '--network',
      netA,
      '-v',
      `${REPO_ROOT}:/repo`,
      '-w',
      '/repo',
      NODE_IMAGE,
      'bash',
      '-c',
      `apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq git >/dev/null 2>&1 && ` +
        `exec node ${GATEWAY_CLI_REL} serve --data-dir ${GW_DATA_DIR}`,
    ]);
    state.gateway = await waitForGatewayReady(gwName, path.join(runDir, 'gateway.log'));
    console.log(
      `  gateway : endpoint=${state.gateway.endpointId.slice(0, 10)}… (container ${gwName}, net ${netA})`,
    );

    const ctx = {
      get gateway() {
        return state.gateway;
      },
      netB,
      gatewayExec: async (args, { allowFailure = false } = {}) => {
        const { code, stdout, stderr } = await run('docker', [
          'exec',
          gwName,
          'node',
          GATEWAY_CLI_REL,
          ...args,
          '--data-dir',
          GW_DATA_DIR,
        ]);
        if (code !== 0 && !allowFailure) {
          throw new Error(`gateway exec ${args.join(' ')} exited ${code}: ${stderr.trim()}`);
        }
        return { code, stdout, stderr };
      },
      mintTicket: async ({ vault, ttlMinutes } = {}) => {
        const args = ['pair'];
        if (vault) args.push('--vault', vault);
        if (ttlMinutes !== undefined) args.push('--ttl-minutes', String(ttlMinutes));
        const { stdout } = await ctx.gatewayExec(args);
        const raw = stdout.match(/^(ey[A-Za-z0-9_-]{40,})$/m)?.[1];
        if (!raw) throw new Error(`pair printed no ticket token:\n${stdout}`);
        return { raw, payload: parseTicket(raw) };
      },
      runDevice: async ({ ticket, probeTarget }) => {
        deviceRunCount += 1;
        const containerName = `pairing-relay-device-${suffix}-${deviceRunCount}`;
        const { code, stdout, stderr } = await run('docker', [
          'run',
          '--rm',
          '--name',
          containerName,
          '--network',
          netB,
          '-e',
          `PAIR_TICKET=${ticket}`,
          ...(probeTarget ? ['-e', `PROBE_TARGET=${probeTarget}`] : []),
          '-v',
          `${REPO_ROOT}:/repo`,
          '-w',
          '/repo',
          NODE_IMAGE,
          'node',
          DEVICE_SCRIPT_REL,
        ]);
        await fs.writeFile(path.join(runDir, `device-${deviceRunCount}.stderr.log`), stderr);
        const lines = stdout.trim().split('\n');
        const jsonLine = lines.toReversed().find((line) => line.trim().length > 0);
        if (!jsonLine) {
          throw new Error(
            `device container printed no JSON line (exit ${code}) — see ` +
              `${path.relative(REPO_ROOT, path.join(runDir, `device-${deviceRunCount}.stderr.log`))}`,
          );
        }
        let parsed;
        try {
          parsed = JSON.parse(jsonLine);
        } catch {
          throw new Error(`device container stdout wasn't valid JSON: ${jsonLine}`);
        }
        return parsed;
      },
      readGatewayFile: async (rel) => {
        const stdout = await sh('docker', ['exec', gwName, 'cat', `${GW_DATA_DIR}/${rel}`]);
        return JSON.parse(stdout);
      },
      note: (m) => {
        notes.push(m);
        console.log(`  note    : ${m}`);
      },
    };

    result = await fn(ctx);
  } catch (e) {
    error = e;
  } finally {
    // Best-effort teardown, all of it — a failed cleanup step must not mask
    // the flow's actual pass/fail result, and must not stop later cleanup
    // steps from running.
    const { stdout: finalLogs } = await run('docker', ['logs', gwName]);
    if (finalLogs) await fs.writeFile(path.join(runDir, 'gateway.log'), finalLogs).catch(() => {});
    if (error) {
      for (const rel of ['devices.json', 'pairing-tickets.json', 'endpoint.json']) {
        const { code, stdout } = await run('docker', [
          'exec',
          gwName,
          'cat',
          `${GW_DATA_DIR}/${rel}`,
        ]);
        if (code === 0) {
          await fs.mkdir(path.join(runDir, 'workspace'), { recursive: true }).catch(() => {});
          await fs.writeFile(path.join(runDir, 'workspace', rel), stdout).catch(() => {});
        }
      }
    }
    await shQuiet('docker', ['rm', '-f', gwName]);
    // Sweep any device containers that survived a mid-run crash (docker run
    // --rm should already have cleaned these up on normal exit).
    const { stdout: strayList } = await run('docker', [
      'ps',
      '-a',
      '--filter',
      `name=pairing-relay-device-${suffix}-`,
      '--format',
      '{{.Names}}',
    ]);
    for (const name of strayList
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)) {
      await shQuiet('docker', ['rm', '-f', name]);
    }
    // Remove exactly whatever was actually inserted, regardless of where in
    // setup a failure happened — each entry is independent and carries its
    // own chain, so a crash partway through the (a)/(b)/(c) rule sets above
    // still tears down every rule that landed. These live in the HOST's real
    // netfilter tables; leaking one would silently affect later jobs on the
    // same runner.
    for (const deleteArgs of firewallRulesInserted) {
      await shQuiet('docker', deleteArgs);
    }
    await shQuiet('docker', ['rm', '-f', fwName]);
    await shQuiet('docker', ['network', 'rm', netA]);
    await shQuiet('docker', ['network', 'rm', netB]);
  }

  const elapsedMs = Date.now() - t0;
  const pass = !error && result?.pass !== false;

  await writeFlowVerdict({
    repoRoot: REPO_ROOT,
    slug,
    runDir,
    elapsedMs,
    error,
    notes,
    result,
    metadata: {
      'network A (gateway)': `${state.netA} (${state.subnetA ?? '?'})`,
      'network B (device)': `${state.netB} (${state.subnetB ?? '?'})`,
      'gateway container': state.gwName,
      'gateway endpoint': state.gateway?.endpointId ?? 'never became ready',
    },
    owner: `tests/agent-e2e-pairing/flows/${slug}.mjs`,
  });

  if (!pass) {
    if (error) console.error(error);
    process.exit(1);
  }
}
