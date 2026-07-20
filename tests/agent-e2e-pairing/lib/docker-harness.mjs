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
//   3. Isolation has to be enforced on TWO paths, not one, and proven on
//      both. The docker-internal path first: on at least one real Docker
//      installation (OrbStack — see the flow .md) user-defined bridge
//      networks do NOT isolate each other by default, so this harness does
//      not trust the driver and adds explicit DOCKER-USER DROP rules for
//      the two subnets. But that alone is NOT enough, as this flow's first
//      run on a GitHub-hosted runner showed: both containers NAT out
//      through the host's single public NIC, iroh's relay-observed address
//      for the gateway is therefore the HOST's public IP, and a dial to it
//      matches no subnet rule. So the harness also drops traffic from both
//      test subnets to every host address (DOCKER-USER *and* INPUT — see
//      the comment at the insert site for why both), and the pre-ceremony
//      probe now dials BOTH paths instead of only re-testing the rule it
//      just installed.

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
 * Raw cross-network TCP probes — isolation proven topologically, independent
 * of the app under test.
 *
 * TWO probes, because the original single probe was tautological: it dialed
 * only the peer's docker-internal IP, which is exactly and only the traffic
 * the subnet-to-subnet DROP rules block. It therefore re-tested the rule that
 * had just been installed and could not observe the host-routed path that
 * actually carried a direct connection on CI.
 *
 *   1. docker-internal — netB → netA container IP (the original probe).
 *   2. host-routed — netB → each host address, at a port published from the
 *      netA probe server. Publishing is what makes this reachable at all in
 *      the absence of the DROP rules, so it's a strictly harder test than the
 *      unpublished topology the ceremony itself runs on.
 *
 * Either probe getting through fails the flow, naming which path leaked.
 */
async function verifyNetworksIsolated(netA, netB, hostAddrs) {
  const probeServerName = `pairing-relay-isoprobe-${crypto.randomBytes(3).toString('hex')}`;
  // High random port so concurrent runs on one host don't collide; `docker
  // run` fails loudly rather than silently sharing if one is already bound.
  const hostPort = 30000 + Math.floor(Math.random() * 20000);
  await sh('docker', [
    'run',
    '-d',
    '--name',
    probeServerName,
    '--network',
    netA,
    '-p',
    `${hostPort}:8080`,
    NODE_IMAGE,
    'node',
    '-e',
    "require('http').createServer((_q,r)=>r.end('probe')).listen(8080,'0.0.0.0')",
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
    const { code, stdout } = await run('docker', [
      'run',
      '--rm',
      '--network',
      netB,
      NODE_IMAGE,
      'node',
      '-e',
      probeScript(targets),
    ]);
    let results;
    try {
      results = JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
    } catch {
      throw new Error(
        `isolation probe container printed no verdict JSON (exit ${code}): ${stdout.trim()}`,
      );
    }
    const leaked = results.filter((r) => r.verdict === 'REACHABLE');
    if (leaked.length > 0) {
      throw new Error(
        `network isolation NOT confirmed: a container on ${netB} reached ${netA} via ` +
          `${leaked.map((r) => r.label).join(', ')}. The DOCKER-USER/INPUT DROP rules didn't ` +
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
  // Each successfully-inserted DOCKER-USER rule gets its exact `-D` teardown
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
    const insertRule = async (chain, src, dst) => {
      const match = ['-s', src, '-d', dst, '-j', 'DROP'];
      const deleteArgs = ['exec', fwName, 'iptables', '-D', chain, ...match];
      await sh('docker', ['exec', fwName, 'iptables', '-I', chain, ...match]);
      // Recorded immediately after THIS insert succeeds, not after all of
      // them — so a throw partway through still leaves everything that
      // landed queued for teardown.
      firewallRulesInserted.push(deleteArgs);
    };
    // (a) Peer-subnet rules: the docker-internal path. DOCKER-USER is
    // Docker's documented hook chain for user firewall rules, evaluated
    // before Docker's own bridge rules, so this holds regardless of whether
    // the driver's own default isolation does.
    await insertRule('DOCKER-USER', state.subnetA, state.subnetB);
    await insertRule('DOCKER-USER', state.subnetB, state.subnetA);

    // (b) Host-address rules: the escape hatch that made this flow's first
    // run on a GitHub-hosted runner select a DIRECT path despite (a) being
    // in force. Both containers NAT out through the host's single public
    // NIC, so iroh's relay-observed public address for the gateway is the
    // HOST's public IP — a destination (a) doesn't match, since it isn't in
    // either test subnet.
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
        await insertRule('DOCKER-USER', subnet, hostAddr);
        await insertRule('INPUT', subnet, hostAddr);
      }
    }
    console.log(`  hostaddr: DROP ${hostAddrs.join(', ')} from both test subnets`);

    const isolationVerdict = await verifyNetworksIsolated(netA, netB, hostAddrs);
    notes.push(`network isolation verified before ceremony: ${isolationVerdict}`);
    console.log(`  isolate : ${isolationVerdict}`);

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
    // own chain, so a crash partway through the (a)/(b) rule sets above
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
