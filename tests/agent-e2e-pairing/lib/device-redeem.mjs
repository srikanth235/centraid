// Device-role script for the cross-network-relay flow (flows/cross-network-relay.mjs).
//
// Runs INSIDE the "device" Docker container, on a bridge network with no
// route to the gateway's container/network — see the flow file for why that
// topology forces `@centraid/tunnel` to actually negotiate iroh's real
// hole-punch/relay path instead of dialing a loopback address directly, the
// way the other two flows in this tier do (lib/harness.mjs's `newDevice()`
// passes `relays: 'disabled'`; this script deliberately does NOT).
//
// Talks to its parent process (the flow, running on the host) over stdout
// only: every diagnostic goes to stderr, and exactly one line of JSON is
// printed to stdout at the end, so `docker run` capture in the flow can
// `JSON.parse(stdout.trim())` without scraping log noise.
//
// Env in:
//   PAIR_TICKET   — the raw base64url `centraid-gw-pair` ticket (required)
//   PROBE_TARGET  — HTTP target for the one tunneled request
//                   (default: /centraid/_vault/vaults)
//
// JSON out (stdout, one line):
//   { paired, vaultId, vaultName, probeStatus, replayRefused, replayError,
//     path: { isRelay, isIp, remoteAddr, rttMs } | null, error? }

import { createTunnelClient, tunnelRequest } from '@centraid/tunnel';

function log(...args) {
  console.error('[device-redeem]', ...args);
}

/** Decode the pasteable one-line token — mirror of lib/harness.mjs's parseTicket
 * and pairing-store.ts's own decoder. Duplicated here (rather than imported)
 * so this script has exactly one dependency (`@centraid/tunnel`) and runs
 * standalone inside the container with nothing else on the module path. */
function parseTicket(raw) {
  const payload = JSON.parse(Buffer.from(raw.trim(), 'base64url').toString('utf8'));
  if (payload.v !== 1 || payload.kind !== 'centraid-gw-pair') {
    throw new Error(`not a centraid-gw-pair ticket: ${raw.slice(0, 40)}…`);
  }
  return payload;
}

function selectedPath(connection) {
  const paths = connection.paths();
  const selected = paths.find((p) => p.isSelected) ?? paths[0];
  if (!selected) return null;
  return {
    isRelay: selected.isRelay,
    isIp: selected.isIp,
    remoteAddr: selected.remoteAddr,
    rttMs: selected.rttMs,
  };
}

async function main() {
  const raw = process.env.PAIR_TICKET;
  if (!raw) throw new Error('PAIR_TICKET env var not set');
  const target = process.env.PROBE_TARGET ?? '/centraid/_vault/vaults';
  const payload = parseTicket(raw);
  log(
    `ticket parsed: vault "${payload.vaultName}", expires ${new Date(payload.exp).toISOString()}`,
  );

  // No `relays: 'disabled'` override — this is the whole point of the flow:
  // use whatever createTunnelClient's real default does (n0 production
  // preset, per packages/tunnel/src/client.ts).
  const device = await createTunnelClient();
  log(`device identity: ${device.endpointId}`);

  const out = {
    paired: false,
    endpointId: device.endpointId,
    vaultId: null,
    vaultName: null,
    probeStatus: null,
    replayRefused: null,
    replayError: null,
    path: null,
  };

  try {
    const paired = await device.pairGateway(payload.gw, {
      ticketId: payload.t,
      secret: payload.s,
      deviceName: 'agent-e2e cross-network device',
      platform: 'agent-e2e-relay',
    });
    log('pairGateway →', JSON.stringify(paired));
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
      const probe = await tunnelRequest(connection, { method: 'GET', target });
      out.probeStatus = probe.status;
      log(`tunneled probe ${target} → ${probe.status}`);
      // Read paths AFTER the request has actually round-tripped data, so
      // path selection (direct vs relay) has settled rather than reporting
      // a pre-handshake candidate.
      out.path = selectedPath(connection);
      log('selected path:', JSON.stringify(out.path));
    } finally {
      connection.close(0n, []);
    }

    const replay = await device.pairGateway(payload.gw, {
      ticketId: payload.t,
      secret: payload.s,
      deviceName: 'agent-e2e cross-network device (replay)',
      platform: 'agent-e2e-relay',
    });
    out.replayRefused = !replay.ok;
    out.replayError = replay.ok ? null : (replay.error ?? 'refused');
    log(`replay → ok=${replay.ok} refused=${out.replayRefused}`);
  } finally {
    await device.close().catch(() => {});
  }

  console.log(JSON.stringify(out));
}

main().catch((err) => {
  log('FATAL', err?.stack ?? String(err));
  console.log(JSON.stringify({ paired: false, error: String(err?.message ?? err) }));
  process.exitCode = 1;
});
