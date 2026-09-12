import crypto from "node:crypto";

import { NODE_IMAGE, PROBE_UDP_PORT, run, sh, shQuiet } from "./docker-exec.ts";
import type { ProbeTarget, ProbeVerdict } from "./docker-exec.ts";

export async function hostAddresses(fwName: string): Promise<string[]> {
  const out = await sh("docker", [
    "exec",
    fwName,
    "ip",
    "-4",
    "-o",
    "addr",
    "show",
  ]);
  const addrs: string[] = [];
  for (const line of out.split("\n")) {
    // "2: eth0    inet 10.1.0.4/16 brd 10.1.255.255 scope global eth0"
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

/** Probe script body: dial every target concurrently, report one verdict each. */
function probeScript(targets: ProbeTarget[]): string {
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
function udpProbeScript(targets: ProbeTarget[]): string {
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
async function runProbe(
  dockerArgs: string[],
  script: string,
  what: string
): Promise<ProbeVerdict[]> {
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
export async function verifyNetworksIsolated(
  netA: string,
  netB: string,
  hostAddrs: string[],
  fwName: string
): Promise<string> {
  const probeServerName = `pairing-relay-isoprobe-${crypto.randomBytes(3).toString("hex")}`;
  // High random ports so concurrent runs on one host don't collide; `docker
  // run` fails loudly rather than silently sharing if one is already bound.
  // This randomness is uniqueness across concurrent runs (like the
  // randomBytes container-name suffix above), not exploration — a seeded draw
  // would hand every concurrent run the same port, recreating the collision.
  // crypto.randomInt keeps it out of Math.random's determinism seam, and the
  // chosen port appears in every probe label this function reports.
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
    // The UDP targets mirror the TCP ones one-for-one: same two classes, same
    // server, so a leak on either transport is reported in the same shape.
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

    // CONTROL first — from the host-network helper, which our rules don't
    // match, so every one of these MUST come back. Anything silent here means
    // the probe itself is broken (server not listening, publish not wired up)
    // and the netB run below would be meaningless.
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
    // Honest status: the per-target reason is preserved rather than flattened
    // to a single word, so "blocked (timeout)" and "blocked (ECONNREFUSED)"
    // stay distinguishable in the log and the verdict file.
    return `ISOLATED — ${results.map((r) => `${r.label}: ${r.verdict}`).join("; ")}`;
  } finally {
    await shQuiet("docker", ["rm", "-f", probeServerName]);
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
export async function verifyProbeExceptionsRemoved(
  fwName: string,
  subnets: string[]
): Promise<string> {
  const survivors: string[] = [];
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
 *   ctx.runDevice(opts)         — run lib/device-redeem.ts in a fresh container on netB;
 *                                  opts: { ticket, probeTarget }; returns the parsed JSON line
 *   ctx.note(msg)                — observation preserved in verdict.md
 */
