import { runFlow } from "../lib/docker-harness.mjs";

await runFlow("cross-network-relay", async (ctx) => {
  const { raw, payload } = await ctx.mintTicket({ vault: "Personal" });
  if (payload.vaultName !== "Personal")
    throw new Error(`ticket names vault "${payload.vaultName}"`);
  if (payload.exp <= Date.now())
    throw new Error("ticket minted already expired");
  if (!payload.gw || !payload.t || !payload.s)
    throw new Error("ticket missing gw/t/s");
  ctx.note(
    `minted ticket ${payload.t} (expires ${new Date(payload.exp).toISOString()})`
  );

  const device = await ctx.runDevice({
    ticket: raw,
    probeTarget: "/centraid/_vault/vaults",
  });
  if (device.error && !device.paired) {
    throw new Error(`device container reported a fatal error: ${device.error}`);
  }
  if (!device.paired)
    throw new Error(`redeem failed: ${JSON.stringify(device)}`);
  if (!device.vaultId || device.vaultName !== "Personal") {
    throw new Error(
      `pair response names the wrong vault: ${JSON.stringify(device)}`
    );
  }
  ctx.note(
    `device ${device.endpointId.slice(0, 10)}… (container on ${ctx.netB}) enrolled across the network boundary`
  );

  if (device.probeStatus !== 200) {
    throw new Error(
      `tunneled probe from the isolated device container → ${device.probeStatus}`
    );
  }
  ctx.note("cross-network tunneled probe: GET /centraid/_vault/vaults → 200");

  if (!device.replayRefused) {
    throw new Error(
      `replayed ticket redeemed twice across the network boundary: ${JSON.stringify(device)}`
    );
  }
  ctx.note(`replay refused (${device.replayError})`);

  if (
    !device.enrollment ||
    device.enrollment.endpointId !== device.endpointId ||
    device.enrollment.vaultId !== device.vaultId
  ) {
    throw new Error(
      `gateway.db-backed roster does not show device: ${JSON.stringify(device)}`
    );
  }
  ctx.note(
    "gateway.db enrollment is visible through devices list on the gateway side"
  );

  if (!device.path) {
    throw new Error(
      "device reported no selected path — cannot confirm relay traversal; check " +
        "device-redeem.mjs's paths() call and its stdout JSON contract"
    );
  }
  if (!device.path.isRelay) {
    throw new Error(
      `network isolation didn't force the relay path as expected — selected path reports ` +
        `isIp=${device.path.isIp} isRelay=${device.path.isRelay} (${device.path.remoteAddr}) ` +
        "despite the two networks having no route between them. This means the DOCKER-USER " +
        "firewall rules are not actually blocking direct routes, or OrbStack/Docker networking " +
        'changed — see the .md "What this does NOT prove" section.'
    );
  }
  ctx.note(
    `CONFIRMED at the QUIC layer: selected path is a RELAY (${device.path.remoteAddr}, ` +
      `rtt=${device.path.rttMs}ms) — this run exercised the real n0 relay fallback, not a lucky direct route.`
  );

  return {
    pass: true,
    notes:
      "mint (gateway container) → redeem/tunnel/burn (device container, separate non-routable " +
      "network) all held, with real DOCKER-USER-enforced network isolation proven before the " +
      "ceremony ran, AND the QUIC connection confirmed on the real relay path",
  };
});
