import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  defaultRunId,
  writeFlowVerdict,
} from "../../agent-e2e-shared/harness.ts";
import type { FlowResult } from "../../agent-e2e-shared/harness.ts";
import {
  ALLOWED_UDP_DPORTS,
  DEVICE_SCRIPT_REL,
  GATEWAY_CLI_REL,
  GW_DATA_DIR,
  NODE_IMAGE,
  PROBE_UDP_PORT,
  REPO_ROOT,
  RUNS_DIR,
  applyInOrder,
  dockerNetworkCreate,
  ensureNativeAddon,
  run,
  sh,
  shQuiet,
  waitForGatewayReady,
} from "./docker-exec.ts";
import type { CommandResult, GatewayReady } from "./docker-exec.ts";
import {
  hostAddresses,
  verifyNetworksIsolated,
  verifyProbeExceptionsRemoved,
} from "./docker-isolation.ts";
import { ensureBuilt, parseTicket } from "./harness.ts";

export interface DeviceRedeemResult {
  paired?: boolean;
  vaultId?: string;
  vaultName?: string;
  probeStatus?: number;
  enrollment?: unknown;
  replayRefused?: boolean;
  replayError?: string;
  path?: {
    isRelay?: boolean;
    isIp?: boolean;
    remoteAddr?: string;
    rttMs?: number;
  } | null;
  error?: string;
}

export interface DockerFlowCtx {
  readonly gateway: GatewayReady | undefined;
  netB: string;
  gatewayExec: (
    args: string[],
    opts?: { allowFailure?: boolean }
  ) => Promise<CommandResult>;
  mintTicket: (opts?: { vault?: string; ttlMinutes?: number }) => Promise<{
    raw: string;
    payload: unknown;
  }>;
  runDevice: (opts: {
    ticket: string;
    probeTarget?: string;
  }) => Promise<DeviceRedeemResult>;
  note: (message: string) => void;
}

export async function runFlow(
  slug: string,
  fn: (ctx: DockerFlowCtx) => Promise<FlowResult | void>
): Promise<void> {
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

  const state: {
    runId: string;
    runDir: string;
    netA: string;
    netB: string;
    gwName: string;
    subnetA?: string;
    subnetB?: string;
    gateway?: GatewayReady;
  } = {
    runId,
    runDir,
    netA,
    netB,
    gwName,
  };
  console.log(`[runFlow] ${slug}`);
  console.log(`  run dir : ${path.relative(REPO_ROOT, runDir)}`);
  console.log(
    `  networks: ${netA} (gateway) / ${netB} (device) — not interconnected`
  );

  const notes: string[] = [];
  let error: unknown;
  let result: FlowResult | void = undefined;
  // Each successfully-inserted DOCKER-USER/INPUT rule gets its exact `-D` teardown
  // args pushed here as it's inserted — NOT a single boolean flipped after
  // both inserts succeed. These rules land directly in the HOST's real
  // netfilter tables (the helper container runs --privileged --network
  // host), so if the first insert succeeds and the second throws, the first
  // must still be torn down; a single "both-or-nothing" flag would leak it.
  const firewallRulesInserted: string[][] = [];
  const t0 = Date.now();

  try {
    const subnetA = await dockerNetworkCreate(netA);
    const subnetB = await dockerNetworkCreate(netB);
    state.subnetA = subnetA;
    state.subnetB = subnetB;
    console.log(`  subnets : ${netA}=${subnetA} ${netB}=${subnetB}`);

    // Explicit isolation (see module docstring point 3) — DOCKER-USER is
    // Docker's documented hook chain for user firewall rules, evaluated
    // before Docker's own bridge rules, so this holds regardless of
    // whether the driver's own default isolation does.
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
    // Generic over the match: callers pass the full match-args array and the
    // -j target, so an address rule, a port-class DROP and its ACCEPT
    // exceptions all go through this one path rather than a parallel one.
    const insertRule = async (
      chain: string,
      matchArgs: string[],
      target: string
    ): Promise<string[]> => {
      const rule = [...matchArgs, "-j", target];
      const deleteArgs = ["exec", fwName, "iptables", "-D", chain, ...rule];
      await sh("docker", ["exec", fwName, "iptables", "-I", chain, ...rule]);
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
    await applyInOrder(["DOCKER-USER", "INPUT"], async (chain) => {
      await applyInOrder([subnetA, subnetB], async (subnet) => {
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

    // (b) Peer-subnet rules: the docker-internal path. DOCKER-USER is
    // Docker's documented hook chain for user firewall rules, evaluated
    // before Docker's own bridge rules, so this holds regardless of whether
    // the driver's own default isolation does.
    await insertRule("DOCKER-USER", ["-s", subnetA, "-d", subnetB], "DROP");
    await insertRule("DOCKER-USER", ["-s", subnetB, "-d", subnetA], "DROP");

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
        "no non-loopback, non-bridge host IPv4 address found — cannot install the " +
          "host-routed isolation rules, and without them a direct path can survive " +
          "the subnet rules (see flows/cross-network-relay.md)"
      );
    }
    await applyInOrder(hostAddrs, async (hostAddr) => {
      await applyInOrder([subnetA, subnetB], async (subnet) => {
        await insertRule("DOCKER-USER", ["-s", subnet, "-d", hostAddr], "DROP");
        await insertRule("INPUT", ["-s", subnet, "-d", hostAddr], "DROP");
      });
    });
    console.log(
      `  hostaddr: DROP ${hostAddrs.join(", ")} from both test subnets`
    );

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
    const probeExceptionRules: string[][] = [];
    await applyInOrder(["DOCKER-USER", "INPUT"], async (chain) => {
      await applyInOrder([subnetA, subnetB], async (subnet) => {
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

    // The probe is done, so its affordance goes away before the ceremony
    // starts. Bookkeeping is explicit rather than implicit: each rule is
    // spliced out of firewallRulesInserted only AFTER its `-D` actually
    // succeeded, so a failure here leaves the entry queued and the `finally`
    // retries it — and a success can't produce a double `-D`.
    await applyInOrder(probeExceptionRules, async (deleteArgs) => {
      await sh("docker", deleteArgs);
      const queued = firewallRulesInserted.indexOf(deleteArgs);
      if (queued >= 0) firewallRulesInserted.splice(queued, 1);
    });
    // Asserted, not assumed — and asserted the only way that's actually
    // falsifiable. A post-removal UDP re-probe would be worthless here: taking
    // the --sport ACCEPT away also removes the echo server's ability to reply
    // at all, so silence becomes guaranteed by construction whether or not the
    // DROP works, and the probe would no longer be self-validating. Reading
    // the live rule set back is cheap (two execs, no wall-clock to speak of)
    // and proves exactly the claim being made.
    if (!state.subnetA || !state.subnetB) {
      throw new Error("test subnets were not allocated");
    }
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
      gatewayExec: async (
        args: string[],
        { allowFailure = false }: { allowFailure?: boolean } = {}
      ) => {
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
      mintTicket: async ({
        vault,
        ttlMinutes,
      }: { vault?: string; ttlMinutes?: number } = {}) => {
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
      runDevice: async ({
        ticket,
        probeTarget,
      }: {
        ticket: string;
        probeTarget?: string;
      }) => {
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
        return parsed as DeviceRedeemResult;
      },
      note: (m: string) => {
        notes.push(m);
        console.log(`  note    : ${m}`);
      },
    };

    result = await fn(ctx);
  } catch (caughtError) {
    error = caughtError;
  } finally {
    // Best-effort teardown, all of it — a failed cleanup step must not mask
    // the flow's actual pass/fail result, and must not stop later cleanup
    // steps from running.
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
    // Sweep any device containers that survived a mid-run crash (docker run
    // --rm should already have cleaned these up on normal exit).
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
    // Remove exactly whatever was actually inserted, regardless of where in
    // setup a failure happened — each entry is independent and carries its
    // own chain, so a crash partway through the (a)/(b)/(c) rule sets above
    // still tears down every rule that landed. These live in the HOST's real
    // netfilter tables; leaking one would silently affect later jobs on the
    // same runner.
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
    result: result ?? undefined,
    metadata: {
      "network A (gateway)": `${state.netA} (${state.subnetA ?? "?"})`,
      "network B (device)": `${state.netB} (${state.subnetB ?? "?"})`,
      "gateway container": state.gwName,
      "gateway endpoint": state.gateway?.endpointId ?? "never became ready",
    },
    owner: `tests/agent-e2e-pairing/flows/${slug}.ts`,
  });

  if (!pass) {
    if (error) console.error(error);
    process.exit(1);
  }
}
