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
//   3. On at least one real Docker installation (OrbStack — see the flow
//      .md), user-defined bridge networks do NOT isolate each other by
//      default the way they do on a stock Linux Docker Engine (e.g. GitHub
//      Actions' ubuntu-latest): a container on network A could dial a
//      container on network B's IP directly. So this harness does not
//      trust the driver's default isolation — it adds explicit
//      DOCKER-USER DROP rules for the two networks' subnets (Docker's
//      documented user-hook chain, evaluated before Docker's own rules)
//      and then PROVES isolation with a real cross-network TCP probe
//      before running the ceremony. This is redundant-but-harmless on
//      hosts where the driver already isolates, and load-bearing on hosts
//      (like this one) where it doesn't.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ensureBuilt, parseTicket } from './harness.mjs';

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

function defaultRunId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
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

/** Raw cross-network TCP probe — proves isolation topologically, independent of the app under test. */
async function verifyNetworksIsolated(netA, netB) {
  const probeServerName = `pairing-relay-isoprobe-${crypto.randomBytes(3).toString('hex')}`;
  await sh('docker', [
    'run',
    '-d',
    '--name',
    probeServerName,
    '--network',
    netA,
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
    const probeScript = `
      const net = require('net');
      const s = net.createConnection({ host: '${ip}', port: 8080, timeout: 3000 });
      s.on('connect', () => { console.log('REACHABLE'); process.exit(1); });
      s.on('timeout', () => { console.log('ISOLATED (timeout)'); s.destroy(); process.exit(0); });
      s.on('error', (e) => { console.log('ISOLATED (' + e.code + ')'); process.exit(0); });
    `;
    const { code, stdout } = await run('docker', [
      'run',
      '--rm',
      '--network',
      netB,
      NODE_IMAGE,
      'node',
      '-e',
      probeScript,
    ]);
    if (code !== 0 || !stdout.includes('ISOLATED')) {
      throw new Error(
        `network isolation NOT confirmed: a container on ${netB} reached ${netA}'s container ` +
          `IP (${ip}) directly — probe said "${stdout.trim()}". The DOCKER-USER DROP rules ` +
          `didn't take effect; refusing to proceed since the flow's relay-path proof would be ` +
          `meaningless on a topology that isn't actually isolated.`,
      );
    }
    return stdout.trim();
  } finally {
    await shQuiet('docker', ['rm', '-f', probeServerName]);
  }
}

function renderVerdict({ slug, pass, error, notes, result, elapsedMs, state }) {
  const lines = [
    `# ${slug}`,
    '',
    `**${pass ? 'PASS' : 'FAIL'}** — ${elapsedMs}ms`,
    '',
    `- run dir: \`${state.runDir}\``,
    `- network A (gateway): \`${state.netA}\` (${state.subnetA ?? '?'})`,
    `- network B (device): \`${state.netB}\` (${state.subnetB ?? '?'})`,
    `- gateway container: \`${state.gwName}\``,
    `- gateway endpoint: \`${state.gateway?.endpointId ?? 'never became ready'}\``,
    '',
  ];
  if (error) {
    lines.push('## Error', '```', error.stack ?? String(error), '```', '');
  }
  if (notes.length) {
    lines.push('## Notes');
    for (const n of notes) lines.push(`- ${n}`);
    lines.push('');
  }
  if (result?.notes) {
    lines.push('## Result', String(result.notes), '');
  }
  return lines.join('\n');
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
      'apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq iptables >/dev/null 2>&1',
    ]);
    const insertRule = async (src, dst) => {
      const deleteArgs = [
        'exec',
        fwName,
        'iptables',
        '-D',
        'DOCKER-USER',
        '-s',
        src,
        '-d',
        dst,
        '-j',
        'DROP',
      ];
      await sh('docker', [
        'exec',
        fwName,
        'iptables',
        '-I',
        'DOCKER-USER',
        '-s',
        src,
        '-d',
        dst,
        '-j',
        'DROP',
      ]);
      // Recorded immediately after THIS insert succeeds, not after both —
      // so a throw on the second insert still leaves the first one queued
      // for teardown.
      firewallRulesInserted.push(deleteArgs);
    };
    await insertRule(state.subnetA, state.subnetB);
    await insertRule(state.subnetB, state.subnetA);

    const isolationVerdict = await verifyNetworksIsolated(netA, netB);
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
    // setup a failure happened — each entry is independent, so a crash
    // between the two `-I`s above still tears down the one that landed.
    for (const deleteArgs of firewallRulesInserted) {
      await shQuiet('docker', deleteArgs);
    }
    await shQuiet('docker', ['rm', '-f', fwName]);
    await shQuiet('docker', ['network', 'rm', netA]);
    await shQuiet('docker', ['network', 'rm', netB]);
  }

  const elapsedMs = Date.now() - t0;
  const pass = !error && result?.pass !== false;

  await fs.writeFile(
    path.join(runDir, 'verdict.md'),
    renderVerdict({ slug, pass, error, notes, result, elapsedMs, state }),
  );

  console.log(`[runFlow] ${slug} ${pass ? 'PASS' : 'FAIL'} in ${elapsedMs}ms`);
  console.log(`  verdict : ${path.relative(REPO_ROOT, path.join(runDir, 'verdict.md'))}`);
  if (!pass) {
    if (error) console.error(error);
    process.exit(1);
  }
}
