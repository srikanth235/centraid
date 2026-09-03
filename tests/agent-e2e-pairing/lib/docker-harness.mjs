// governance: allow-repo-hygiene file-size-limit (#363) single Docker-orchestration harness for the pairing e2e rig; the network/boot/exec/teardown surface is one cohesive unit

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  defaultRunId,
  writeFlowVerdict,
} from "../../agent-e2e-shared/harness.mjs";
import { ensureBuilt, parseTicket } from "./harness.mjs";

const __dirname = import.meta.dirname;
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const RUNS_DIR = path.join(__dirname, "..", "runs");
const NODE_IMAGE = "node:22-bookworm-slim";
const GATEWAY_CLI_REL = "packages/server/dist/cli/cli.js";
const DEVICE_SCRIPT_REL = "tests/agent-e2e-pairing/lib/device-redeem.mjs";
const GW_DATA_DIR = "/tmp/gw-data";
const ALLOWED_UDP_DPORTS = [53];
const PROBE_UDP_PORT = 9999;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += c));
    child.stderr?.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function sh(cmd, args, opts = {}) {
  const { code, stdout, stderr } = await run(cmd, args, opts);
  if (code !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`
    );
  }
  return stdout;
}

async function shQuiet(cmd, args, opts = {}) {
  try {
    await sh(cmd, args, opts);
  } catch (error) {
    console.error(
      `  [teardown warning] ${cmd} ${args.join(" ")}: ${error.message}`
    );
  }
}

function applyInOrder(values, apply) {
  let index = 0;
  return Array.from(values).reduce(
    (sequence, value) => sequence.then(() => apply(value, index++)),
    Promise.resolve()
  );
}

async function ensureNativeAddon() {
  const archMap = { arm64: "arm64", x64: "x64" };
  const arch = archMap[process.arch];
  if (!arch) {
    throw new Error(
      `cross-network-relay: unsupported host arch "${process.arch}" — only arm64/x64 have ` +
        `published @number0/iroh-linux-*-gnu packages`
    );
  }
  const pkgName = `iroh-linux-${arch}-gnu`;
  const pkgDir = path.join(REPO_ROOT, "node_modules", "@number0", pkgName);
  const addonFile = path.join(pkgDir, `iroh.linux-${arch}-gnu.node`);
  try {
    await fs.access(addonFile);
    console.log(`[docker-harness] @number0/${pkgName} already present`);
  } catch {
    const irohPkgJson = JSON.parse(
      await fs.readFile(
        path.join(
          REPO_ROOT,
          "node_modules",
          "@number0",
          "iroh",
          "package.json"
        ),
        "utf8"
      )
    );
    const version = irohPkgJson.version;
    console.log(
      `[docker-harness] @number0/${pkgName}@${version} missing — the host's bun install only ` +
        `fetched the host-platform optional dep; fetching the linux one additively for the container…`
    );
    const script = [
      "set -e",
      "cd /tmp",
      `npm pack @number0/${pkgName}@${version} --silent >/dev/null`,
      `tar xzf number0-${pkgName}-${version}.tgz`,
      `mkdir -p /repo/node_modules/@number0/${pkgName}`,
      `cp -r package/* /repo/node_modules/@number0/${pkgName}/`,
    ].join(" && ");
    await sh("docker", [
      "run",
      "--rm",
      "-v",
      `${REPO_ROOT}:/repo`,
      NODE_IMAGE,
      "bash",
      "-c",
      script,
    ]);
  }

  const { code, stdout, stderr } = await run("docker", [
    "run",
    "--rm",
    "-v",
    `${REPO_ROOT}:/repo`,
    "-w",
    "/repo",
    NODE_IMAGE,
    "node",
    "-e",
    "try { require('@centraid/tunnel'); console.log('OK'); } " +
      "catch (e) { console.error(e.message); process.exit(1); }",
  ]);
  if (code !== 0 || !stdout.includes("OK")) {
    throw new Error(
      `cross-network-relay: @centraid/tunnel's native addon does not load inside ${NODE_IMAGE} ` +
        `even after fetching @number0/${pkgName} — ${stderr.trim() || stdout.trim()}`
    );
  }
  console.log(
    "[docker-harness] @centraid/tunnel native addon loads inside the container — confirmed"
  );
}

async function dockerNetworkCreate(name) {
  await sh("docker", [
    "network",
    "create",
    "--driver",
    "bridge",
    "--ipv6=false",
    name,
  ]);
  const inspectOut = await sh("docker", [
    "network",
    "inspect",
    name,
    "--format",
    "{{range .IPAM.Config}}{{.Subnet}}\n{{end}}",
  ]);
  const subnet = inspectOut
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.includes("."));
  if (!subnet)
    throw new Error(`network ${name} has no IPv4 subnet in IPAM config`);
  return subnet;
}

async function waitForGatewayReady(
  containerName,
  logFile,
  { timeoutMs = 90000 } = {}
) {
  const wanted = { url: undefined, endpointId: undefined };
  const start = Date.now();
  const waitForNextReadinessCheck = async () => {
    if (Date.now() - start >= timeoutMs) {
      const logs = await sh("docker", ["logs", containerName]).catch(
        () => "(logs unavailable)"
      );
      await fs.writeFile(logFile, logs);
      throw new Error(
        `gateway container ${containerName} not ready in ${timeoutMs}ms (url=${wanted.url} ` +
          `endpoint=${wanted.endpointId}) — see ${logFile}`
      );
    }
    const { code: inspectCode, stdout: statusOut } = await run("docker", [
      "inspect",
      containerName,
      "--format",
      "{{.State.Status}}",
    ]);
    const logs = await sh("docker", ["logs", containerName]);
    wanted.url ??= logs.match(
      /listening on (?<url>http:\/\/[^\s]+)/u
    )?.groups?.url;
    wanted.endpointId ??= logs.match(
      /endpoint: (?<endpointId>[0-9a-f]{64})/u
    )?.groups?.endpointId;
    if (wanted.url && wanted.endpointId) {
      await fs.writeFile(logFile, logs);
      return wanted;
    }
    if (inspectCode === 0 && statusOut.trim() === "exited") {
      await fs.writeFile(logFile, logs);
      throw new Error(
        `gateway container ${containerName} exited before ready — see ${logFile}`
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    return waitForNextReadinessCheck();
  };
  return waitForNextReadinessCheck();
}

async function hostAddresses(fwName) {
  const out = await sh("docker", [
    "exec",
    fwName,
    "ip",
    "-4",
    "-o",
    "addr",
    "show",
  ]);
  const addrs = [];
  for (const line of out.split("\n")) {
    const m = line.match(
      /^\d+:\s+(?<iface>\S+)\s+inet\s+(?<addr>\d+\.\d+\.\d+\.\d+)\//u
    );
    if (!m?.groups) continue;
    const iface = m.groups.iface ?? "";
    const addr = m.groups.addr ?? "";
    if (
      iface === "lo" ||
      iface === "docker0" ||
      iface.startsWith("br-") ||
      iface.startsWith("veth")
    ) {
      continue;
    }
    if (!addrs.includes(addr)) addrs.push(addr);
  }
  return addrs;
}

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

async function runProbe(dockerArgs, script, what) {
  const { code, stdout } = await run("docker", [
    ...dockerArgs,
    "node",
    "-e",
    script,
  ]);
  try {
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    throw new Error(
      `${what} printed no verdict JSON (exit ${code}): ${stdout.trim()}`
    );
  }
}

async function verifyNetworksIsolated(netA, netB, hostAddrs, fwName) {
  const probeServerName = `pairing-relay-isoprobe-${crypto.randomBytes(3).toString("hex")}`;
  const hostPort = crypto.randomInt(30000, 50000);
  const udpHostPort = crypto.randomInt(30000, 50000);
  await sh("docker", [
    "run",
    "-d",
    "--name",
    probeServerName,
    "--network",
    netA,
    "-p",
    `${hostPort}:8080`,
    "-p",
    `${udpHostPort}:${PROBE_UDP_PORT}/udp`,
    NODE_IMAGE,
    "node",
    "-e",
    "require('http').createServer((_q,r)=>r.end('probe')).listen(8080,'0.0.0.0');" +
      "const d=require('dgram').createSocket('udp4');" +
      "d.on('message',(m,ri)=>d.send(m,ri.port,ri.address));" +
      `d.bind(${PROBE_UDP_PORT},'0.0.0.0');`,
  ]);
  try {
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
    const ip = (
      await sh("docker", [
        "inspect",
        probeServerName,
        "--format",
        `{{(index .NetworkSettings.Networks "${netA}").IPAddress}}`,
      ])
    ).trim();
    const targets = [
      { label: `docker-internal ${ip}:8080`, host: ip, port: 8080 },
      ...hostAddrs.map((h) => ({
        label: `host-routed ${h}:${hostPort}`,
        host: h,
        port: hostPort,
      })),
    ];
    const udpTargets = [
      {
        label: `udp docker-internal ${ip}:${PROBE_UDP_PORT}`,
        host: ip,
        port: PROBE_UDP_PORT,
      },
      ...hostAddrs.map((h) => ({
        label: `udp host-routed ${h}:${udpHostPort}`,
        host: h,
        port: udpHostPort,
      })),
    ];

    const control = await runProbe(
      ["exec", fwName],
      udpProbeScript(udpTargets),
      "UDP control probe"
    );
    const deadControls = control.filter((r) => r.verdict !== "REACHABLE");
    if (deadControls.length > 0) {
      throw new Error(
        `UDP isolation probe is not trustworthy: the control run (from the host network) got no ` +
          `reply from ${deadControls.map((r) => `${r.label}: ${r.verdict}`).join("; ")}. Either ` +
          `the echo server / its port publishing is broken, or one of our own DROP rules is ` +
          `eating the server's REPLY (it leaves netA for the dialed host address, so the (c) ` +
          `host-address DROP matches it unless the probe's --sport ACCEPT outranks (c) — see ` +
          `block (d) in this file). Silence from ${netB} would prove nothing either way — ` +
          `refusing to report isolation this probe hasn't actually established.`
      );
    }

    const results = [
      ...(await runProbe(
        ["run", "--rm", "--network", netB, NODE_IMAGE],
        probeScript(targets),
        "TCP isolation probe container"
      )),
      ...(await runProbe(
        ["run", "--rm", "--network", netB, NODE_IMAGE],
        udpProbeScript(udpTargets),
        "UDP isolation probe container"
      )),
    ];
    const leaked = results.filter((r) => r.verdict === "REACHABLE");
    if (leaked.length > 0) {
      throw new Error(
        `network isolation NOT confirmed: a container on ${netB} reached ${netA} via ` +
          `${leaked.map((r) => r.label).join(", ")}. The DOCKER-USER/INPUT address and ` +
          `port-class DROP rules didn't ` +
          `take effect on ${leaked.length === results.length ? "any" : "that"} path; refusing ` +
          `to proceed since the flow's relay-path proof would be meaningless on a topology ` +
          `that isn't actually isolated.`
      );
    }
    return `ISOLATED — ${results.map((r) => `${r.label}: ${r.verdict}`).join("; ")}`;
  } finally {
    await shQuiet("docker", ["rm", "-f", probeServerName]);
  }
}

async function verifyProbeExceptionsRemoved(fwName, subnets) {
  const survivors = [];
  await Promise.all(
    ["DOCKER-USER", "INPUT"].map(async (chain) => {
      const dump = await sh("docker", [
        "exec",
        fwName,
        "iptables",
        "-S",
        chain,
      ]);
      for (const line of dump.split("\n")) {
        if (!line.includes(`--sport ${PROBE_UDP_PORT}`)) continue;
        if (!subnets.some((s) => line.includes(s))) continue;
        survivors.push(`${chain}: ${line.trim()}`);
      }
    })
  );
  if (survivors.length > 0) {
    throw new Error(
      `the isolation probe's UDP ACCEPT exception outlived the probe — still present as ` +
        `${survivors.join("; ")}. The ceremony would run with a UDP hole in exactly the ` +
        `port-class block it is meant to prove closed; refusing to proceed rather than ` +
        `producing a relay-path verdict with a known exception open.`
    );
  }
  return `no --sport ${PROBE_UDP_PORT} ACCEPT remains in DOCKER-USER or INPUT (iptables -S read back)`;
}

export async function runFlow(slug, fn) {
  await ensureBuilt();
  await ensureNativeAddon();

  const runId = `${slug}-${defaultRunId()}`;
  const runDir = path.join(RUNS_DIR, runId);
  await fs.mkdir(runDir, { recursive: true });

  const suffix = crypto.randomBytes(4).toString("hex");
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
  console.log(
    `  networks: ${netA} (gateway) / ${netB} (device) — not interconnected`
  );

  const notes = [];
  let error, result;
  const firewallRulesInserted = [];
  const t0 = Date.now();

  try {
    state.subnetA = await dockerNetworkCreate(netA);
    state.subnetB = await dockerNetworkCreate(netB);
    console.log(
      `  subnets : ${netA}=${state.subnetA} ${netB}=${state.subnetB}`
    );

    await sh("docker", [
      "run",
      "-d",
      "--name",
      fwName,
      "--privileged",
      "--network",
      "host",
      NODE_IMAGE,
      "sleep",
      "infinity",
    ]);
    await sh("docker", [
      "exec",
      fwName,
      "bash",
      "-c",
      "apt-get update -qq >/dev/null 2>&1 && " +
        "apt-get install -y -qq iptables iproute2 >/dev/null 2>&1",
    ]);
    const insertRule = async (chain, matchArgs, target) => {
      const rule = [...matchArgs, "-j", target];
      const deleteArgs = ["exec", fwName, "iptables", "-D", chain, ...rule];
      await sh("docker", ["exec", fwName, "iptables", "-I", chain, ...rule]);
      firewallRulesInserted.push(deleteArgs);
      return deleteArgs;
    };

    await applyInOrder(["DOCKER-USER", "INPUT"], async (chain) => {
      await applyInOrder([state.subnetA, state.subnetB], async (subnet) => {
        await insertRule(chain, ["-s", subnet, "-p", "udp"], "DROP");
        await applyInOrder(ALLOWED_UDP_DPORTS, async (port) => {
          await insertRule(
            chain,
            ["-s", subnet, "-p", "udp", "--dport", String(port)],
            "ACCEPT"
          );
        });
      });
    });
    console.log(
      `  udpclass: DROP all UDP from both test subnets except dport ` +
        `${ALLOWED_UDP_DPORTS.join("/")} (relay is TCP 443, so it is unaffected)`
    );

    await insertRule(
      "DOCKER-USER",
      ["-s", state.subnetA, "-d", state.subnetB],
      "DROP"
    );
    await insertRule(
      "DOCKER-USER",
      ["-s", state.subnetB, "-d", state.subnetA],
      "DROP"
    );

    const hostAddrs = await hostAddresses(fwName);
    if (hostAddrs.length === 0) {
      throw new Error(
        "no non-loopback, non-bridge host IPv4 address found — cannot install the " +
          "host-routed isolation rules, and without them a direct path can survive " +
          "the subnet rules (see flows/cross-network-relay.md)"
      );
    }
    await applyInOrder(hostAddrs, async (hostAddr) => {
      await applyInOrder([state.subnetA, state.subnetB], async (subnet) => {
        await insertRule("DOCKER-USER", ["-s", subnet, "-d", hostAddr], "DROP");
        await insertRule("INPUT", ["-s", subnet, "-d", hostAddr], "DROP");
      });
    });
    console.log(
      `  hostaddr: DROP ${hostAddrs.join(", ")} from both test subnets`
    );

    const probeExceptionRules = [];
    await applyInOrder(["DOCKER-USER", "INPUT"], async (chain) => {
      await applyInOrder([state.subnetA, state.subnetB], async (subnet) => {
        probeExceptionRules.push(
          await insertRule(
            chain,
            ["-s", subnet, "-p", "udp", "--sport", String(PROBE_UDP_PORT)],
            "ACCEPT"
          )
        );
      });
    });

    const isolationVerdict = await verifyNetworksIsolated(
      netA,
      netB,
      hostAddrs,
      fwName
    );
    notes.push(
      `network isolation verified before ceremony: ${isolationVerdict}`
    );
    console.log(`  isolate : ${isolationVerdict}`);

    await applyInOrder(probeExceptionRules, async (deleteArgs) => {
      await sh("docker", deleteArgs);
      const queued = firewallRulesInserted.indexOf(deleteArgs);
      if (queued >= 0) firewallRulesInserted.splice(queued, 1);
    });
    const closedVerdict = await verifyProbeExceptionsRemoved(fwName, [
      state.subnetA,
      state.subnetB,
    ]);
    notes.push(
      `ceremony ran with the port-class UDP block fully closed: ${closedVerdict}`
    );
    console.log(`  udpshut : ${closedVerdict}`);

    await sh("docker", [
      "run",
      "-d",
      "--name",
      gwName,
      "--network",
      netA,
      "-v",
      `${REPO_ROOT}:/repo`,
      "-w",
      "/repo",
      NODE_IMAGE,
      "bash",
      "-c",
      `apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq git >/dev/null 2>&1 && ` +
        `exec node ${GATEWAY_CLI_REL} serve --data-dir ${GW_DATA_DIR}`,
    ]);
    state.gateway = await waitForGatewayReady(
      gwName,
      path.join(runDir, "gateway.log")
    );
    console.log(
      `  gateway : endpoint=${state.gateway.endpointId.slice(0, 10)}… (container ${gwName}, net ${netA})`
    );

    const ctx = {
      get gateway() {
        return state.gateway;
      },
      netB,
      gatewayExec: async (args, { allowFailure = false } = {}) => {
        const { code, stdout, stderr } = await run("docker", [
          "exec",
          gwName,
          "node",
          GATEWAY_CLI_REL,
          ...args,
          "--data-dir",
          GW_DATA_DIR,
        ]);
        if (code !== 0 && !allowFailure) {
          throw new Error(
            `gateway exec ${args.join(" ")} exited ${code}: ${stderr.trim()}`
          );
        }
        return { code, stdout, stderr };
      },
      mintTicket: async ({ vault, ttlMinutes } = {}) => {
        const args = ["pair"];
        if (vault) args.push("--vault", vault);
        if (ttlMinutes !== undefined)
          args.push("--ttl-minutes", String(ttlMinutes));
        const { stdout } = await ctx.gatewayExec(args);
        const raw = stdout.match(/^(?<ticket>ey[A-Za-z0-9_-]{40,})$/mu)?.groups
          ?.ticket;
        if (!raw) throw new Error(`pair printed no ticket token:\n${stdout}`);
        return { raw, payload: parseTicket(raw) };
      },
      runDevice: async ({ ticket, probeTarget }) => {
        deviceRunCount += 1;
        const containerName = `pairing-relay-device-${suffix}-${deviceRunCount}`;
        const { code, stdout, stderr } = await run("docker", [
          "run",
          "--rm",
          "--name",
          containerName,
          "--network",
          netB,
          "-e",
          `PAIR_TICKET=${ticket}`,
          ...(probeTarget ? ["-e", `PROBE_TARGET=${probeTarget}`] : []),
          "-v",
          `${REPO_ROOT}:/repo`,
          "-w",
          "/repo",
          NODE_IMAGE,
          "node",
          DEVICE_SCRIPT_REL,
        ]);
        await fs.writeFile(
          path.join(runDir, `device-${deviceRunCount}.stderr.log`),
          stderr
        );
        const lines = stdout.trim().split("\n");
        const jsonLine = lines
          .toReversed()
          .find((line) => line.trim().length > 0);
        if (!jsonLine) {
          throw new Error(
            `device container printed no JSON line (exit ${code}) — see ` +
              `${path.relative(REPO_ROOT, path.join(runDir, `device-${deviceRunCount}.stderr.log`))}`
          );
        }
        let parsed;
        try {
          parsed = JSON.parse(jsonLine);
        } catch {
          throw new Error(
            `device container stdout wasn't valid JSON: ${jsonLine}`
          );
        }
        return parsed;
      },
      note: (m) => {
        notes.push(m);
        console.log(`  note    : ${m}`);
      },
    };

    result = await fn(ctx);
  } catch (caughtError) {
    error = caughtError;
  } finally {
    const { stdout: finalLogs } = await run("docker", ["logs", gwName]);
    if (finalLogs)
      await fs
        .writeFile(path.join(runDir, "gateway.log"), finalLogs)
        .catch(() => {});
    if (error) {
      await fs
        .mkdir(path.join(runDir, "workspace"), { recursive: true })
        .catch(() => {});
      await run("docker", [
        "cp",
        `${gwName}:${GW_DATA_DIR}/gateway.db`,
        path.join(runDir, "workspace", "gateway.db"),
      ]);
    }
    await shQuiet("docker", ["rm", "-f", gwName]);
    const { stdout: strayList } = await run("docker", [
      "ps",
      "-a",
      "--filter",
      `name=pairing-relay-device-${suffix}-`,
      "--format",
      "{{.Names}}",
    ]);
    await applyInOrder(
      strayList
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      async (name) => shQuiet("docker", ["rm", "-f", name])
    );
    await applyInOrder(firewallRulesInserted, async (deleteArgs) =>
      shQuiet("docker", deleteArgs)
    );
    await shQuiet("docker", ["rm", "-f", fwName]);
    await shQuiet("docker", ["network", "rm", netA]);
    await shQuiet("docker", ["network", "rm", netB]);
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
      "network A (gateway)": `${state.netA} (${state.subnetA ?? "?"})`,
      "network B (device)": `${state.netB} (${state.subnetB ?? "?"})`,
      "gateway container": state.gwName,
      "gateway endpoint": state.gateway?.endpointId ?? "never became ready",
    },
    owner: `tests/agent-e2e-pairing/flows/${slug}.mjs`,
  });

  if (!pass) {
    if (error) console.error(error);
    process.exit(1);
  }
}
