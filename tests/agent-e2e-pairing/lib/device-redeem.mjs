import { createTunnelClient, tunnelRequest } from "@centraid/tunnel";

function log(...args) {
  console.error("[device-redeem]", ...args);
}

function parseTicket(raw) {
  const payload = JSON.parse(
    Buffer.from(raw.trim(), "base64url").toString("utf8")
  );
  if (payload.v !== 1 || payload.kind !== "centraid-gw-pair") {
    throw new Error(`not a centraid-gw-pair ticket: ${raw.slice(0, 40)}…`);
  }
  return payload;
}

function selectedPath(connection) {
  const paths = connection.paths();
  const selected = paths.find((p) => p.isSelected);
  if (!selected) {
    if (paths.length > 0) {
      log(
        `paths() returned ${paths.length} candidate(s) but none flagged isSelected: ` +
          JSON.stringify(
            paths.map((p) => ({ remoteAddr: p.remoteAddr, isRelay: p.isRelay }))
          )
      );
    }
    return null;
  }
  return {
    isRelay: selected.isRelay,
    isIp: selected.isIp,
    remoteAddr: selected.remoteAddr,
    rttMs: selected.rttMs,
  };
}

async function main() {
  const raw = process.env.PAIR_TICKET;
  if (!raw) throw new Error("PAIR_TICKET env var not set");
  const target = process.env.PROBE_TARGET ?? "/centraid/_vault/vaults";
  const payload = parseTicket(raw);
  log(
    `ticket parsed: vault "${payload.vaultName}", expires ${new Date(payload.exp).toISOString()}`
  );

  const device = await createTunnelClient();
  log(`device identity: ${device.endpointId}`);

  const out = {
    paired: false,
    endpointId: device.endpointId,
    vaultId: null,
    vaultName: null,
    probeStatus: null,
    enrollment: null,
    replayRefused: null,
    replayError: null,
    path: null,
  };

  try {
    const paired = await device.pairGateway(payload.gw, {
      ticketId: payload.t,
      secret: payload.s,
      deviceName: "agent-e2e cross-network device",
      platform: "agent-e2e-relay",
    });
    log("pairGateway →", JSON.stringify(paired));
    if (!paired.ok) {
      out.error = `redeem failed: ${JSON.stringify(paired)}`;
      console.log(JSON.stringify(out));
      return;
    }
    out.paired = true;
    out.vaultId = paired.vaultId;
    out.vaultName = paired.vaultName;

    const connection = await device.connect(payload.gw);
    try {
      const probe = await tunnelRequest(connection, { method: "GET", target });
      out.probeStatus = probe.status;
      log(`tunneled probe ${target} → ${probe.status}`);
      const roster = await tunnelRequest(connection, {
        method: "GET",
        target: "/centraid/_gateway/devices",
      });
      if (roster.status === 200) {
        const devices = JSON.parse(roster.body.toString("utf8")).devices ?? [];
        out.enrollment =
          devices.find((row) => row.endpointId === device.endpointId) ?? null;
      }
      log(`gateway.db roster → ${roster.status}`);
      out.path = selectedPath(connection);
      log("selected path:", JSON.stringify(out.path));
    } finally {
      connection.close(0n, []);
    }

    const replay = await device.pairGateway(payload.gw, {
      ticketId: payload.t,
      secret: payload.s,
      deviceName: "agent-e2e cross-network device (replay)",
      platform: "agent-e2e-relay",
    });
    out.replayRefused = !replay.ok;
    out.replayError = replay.ok ? null : (replay.error ?? "refused");
    log(`replay → ok=${replay.ok} refused=${out.replayRefused}`);
  } finally {
    await device.close().catch(() => {});
  }

  console.log(JSON.stringify(out));
}

main().catch((error) => {
  log("FATAL", error?.stack ?? String(error));
  console.log(
    JSON.stringify({ paired: false, error: String(error?.message ?? error) })
  );
  process.exitCode = 1;
});
