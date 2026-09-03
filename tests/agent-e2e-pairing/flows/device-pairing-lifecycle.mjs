import { runFlow } from "../lib/harness.mjs";

await runFlow("device-pairing-lifecycle", async (ctx) => {
  const { payload } = await ctx.mintTicket({ vault: "Personal" });
  if (payload.vaultName !== "Personal") {
    throw new Error(`ticket names vault "${payload.vaultName}"`);
  }
  if (payload.exp <= Date.now())
    throw new Error("ticket minted already expired");
  if (!payload.gw || !payload.t || !payload.s)
    throw new Error("ticket missing gw/t/s");
  ctx.note(
    `minted ticket ${payload.t} (expires ${new Date(payload.exp).toISOString()})`
  );

  const device = await ctx.newDevice();
  const paired = await device.pairGateway(payload.gw, {
    ticketId: payload.t,
    secret: payload.s,
    deviceName: "agent-e2e laptop",
    platform: "agent-e2e",
  });
  if (!paired.ok) throw new Error(`redeem failed: ${JSON.stringify(paired)}`);
  if (!paired.vaultId || paired.vaultName !== "Personal") {
    throw new Error(
      `pair response names the wrong vault: ${JSON.stringify(paired)}`
    );
  }
  if (!paired.version || typeof paired.protocolVersion !== "number") {
    throw new Error(
      `pair response missing handshake material: ${JSON.stringify(paired)}`
    );
  }
  ctx.note(
    `device ${device.endpointId.slice(0, 10)}… enrolled (gateway v${paired.version})`
  );

  const roster = await ctx.requestJson(
    device,
    "GET",
    "/centraid/_gateway/devices"
  );
  if (roster.response.status !== 200) {
    throw new Error(`devices roster returned ${roster.response.status}`);
  }
  const enrolled = roster.json.devices.find(
    (row) => row.endpointId === device.endpointId
  );
  if (
    !enrolled ||
    enrolled.vaultId !== paired.vaultId ||
    enrolled.platform !== "agent-e2e"
  ) {
    throw new Error(`devices list does not show ${device.endpointId}`);
  }

  const probe = await ctx.request(device, "/centraid/_vault/vaults");
  if (probe.status !== 200) throw new Error(`tunneled probe → ${probe.status}`);
  ctx.note("enrolled device tunnels: GET /centraid/_vault/vaults → 200");

  const replay = await device.pairGateway(payload.gw, {
    ticketId: payload.t,
    secret: payload.s,
    deviceName: "replay",
    platform: "agent-e2e",
  });
  if (replay.ok) throw new Error("replayed ticket redeemed twice");
  ctx.note(`replay refused (${replay.error})`);

  const endpointBefore = ctx.gateway.endpointId;
  await ctx.restartGateway();
  if (ctx.gateway.endpointId !== endpointBefore) {
    throw new Error(
      "gateway EndpointId changed across restart — identity is not permanent"
    );
  }
  const probeAfter = await ctx.request(device, "/centraid/_vault/vaults");
  if (probeAfter.status !== 200)
    throw new Error(`post-restart probe → ${probeAfter.status}`);
  ctx.note(
    "daemon restarted: same EndpointId, device still enrolled, tunnel works"
  );

  const revoked = await ctx.requestJson(
    device,
    "DELETE",
    `/centraid/_gateway/devices/${encodeURIComponent(enrolled.deviceId)}`
  );
  if (revoked.response.status !== 200 || revoked.json.removed !== true) {
    throw new Error(`self-revoke failed: ${JSON.stringify(revoked.json)}`);
  }
  await ctx.expectTunnelRefused(device);
  ctx.note("revoked device refused at the QUIC layer");

  return {
    pass: true,
    notes:
      "mint → redeem → enroll → tunnel → burn → restart-persist → revoke, all against real processes",
  };
});
