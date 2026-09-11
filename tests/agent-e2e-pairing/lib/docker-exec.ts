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

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const __dirname = import.meta.dirname;

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ProbeTarget {
  label: string;
  host: string;
  port: number;
}

export interface ProbeVerdict {
  label: string;
  verdict: string;
}

export interface GatewayReady {
  url: string;
  endpointId: string;
}

export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
export const RUNS_DIR = path.join(__dirname, "..", "runs");
export const NODE_IMAGE = "node:22-bookworm-slim";
export const GATEWAY_CLI_REL = "packages/server/dist/cli/cli.js";
export const DEVICE_SCRIPT_REL = "tests/agent-e2e-pairing/lib/device-redeem.ts";
export const GW_DATA_DIR = "/tmp/gw-data";
export const ALLOWED_UDP_DPORTS = [53];
export const PROBE_UDP_PORT = 9999;

export function run(
  cmd: string,
  args: string[],
  opts: Record<string, unknown> = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer | string) => (stdout += c));
    child.stderr?.on("data", (c: Buffer | string) => (stderr += c));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

export async function sh(
  cmd: string,
  args: string[],
  opts: Record<string, unknown> = {}
): Promise<string> {
  const { code, stdout, stderr } = await run(cmd, args, opts);
  if (code !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`
    );
  }
  return stdout;
}

export async function shQuiet(
  cmd: string,
  args: string[],
  opts: Record<string, unknown> = {}
): Promise<void> {
  // Best-effort teardown step: never throw, just report.
  try {
    await sh(cmd, args, opts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  [teardown warning] ${cmd} ${args.join(" ")}: ${message}`);
  }
}

/** Firewall rules and teardown steps must settle in the exact supplied order. */
export function applyInOrder<T>(
  values: Iterable<T>,
  apply: (value: T, index: number) => Promise<unknown>
): Promise<unknown> {
  let index = 0;
  return Array.from(values).reduce<Promise<unknown>>(
    (sequence, value) => sequence.then(() => apply(value, index++)),
    Promise.resolve()
  );
}

/**
 * Confirm the container image can load @centraid/tunnel's native iroh
 * addon; fetch the missing linux platform package if the host's own `bun
 * install` (which only resolves optionalDependencies for the HOST platform)
 * didn't already provide it. Purely additive — writes a new sibling under
 * node_modules/@number0/, never touches the host's own platform package.
 */
export async function ensureNativeAddon() {
  const archMap: Record<string, string> = { arm64: "arm64", x64: "x64" };
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

  // Verified, not assumed: actually load @centraid/tunnel inside a
  // throwaway container and confirm the native addon resolves before
  // trusting the rest of the flow to it.
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

export async function dockerNetworkCreate(name: string): Promise<string> {
  // --ipv6=false matters beyond tidiness: on at least one host (OrbStack —
  // see the flow .md), containers get a REAL globally-routable IPv6 address
  // (NDP-proxied from the host's own WAN prefix, not a Docker-private ULA),
  // so two containers on "isolated" IPv4-only networks could still dial
  // each other directly over IPv6 and never touch the relay path this flow
  // exists to exercise. Forcing IPv4-only removes that escape hatch
  // entirely rather than trying to firewall an address range that varies
  // by host/ISP.
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
  // IPv4 + IPv6 subnets are both listed; take the IPv4 one (contains a dot).
  const subnet = inspectOut
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.includes("."));
  if (!subnet)
    throw new Error(`network ${name} has no IPv4 subnet in IPAM config`);
  return subnet;
}

/**
 * Poll `docker logs <name>` for the readiness lines lib/harness.mjs's
 * spawnDaemon waits for.
 *
 * The daemon no longer prints a loopback bearer (`token:`) to stdout
 * (issue #568 / cli.test.ts). This flow never dials the host HTTP surface —
 * mint/list go through `docker exec … pair/devices` against the container
 * data dir — so readiness is just listener + endpoint id. Pair tickets still
 * embed a live EndpointTicket because the CLI mints through the running
 * daemon once those lines appear.
 */
export async function waitForGatewayReady(
  containerName: string,
  logFile: string,
  { timeoutMs = 90000 }: { timeoutMs?: number } = {}
): Promise<GatewayReady> {
  const wanted: { url?: string; endpointId?: string } = {};
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
      return { url: wanted.url, endpointId: wanted.endpointId };
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
