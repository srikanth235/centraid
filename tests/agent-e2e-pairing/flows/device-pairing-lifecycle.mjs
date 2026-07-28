// The full pairing ceremony, every component in its real process — see the
// .md next to this file for intent.
import { runFlow } from '../lib/harness.mjs';

await runFlow('device-pairing-lifecycle', async (ctx) => {
  // 1. A fresh daemon auto-founds Shared + Personal (#603); tickets default to Shared.
  // Mint the pasteable ticket for it through the live daemon.
  const { payload } = await ctx.mintTicket({ vault: 'Shared' });
  if (payload.vaultName !== 'Shared') {
    throw new Error(`ticket names vault "${payload.vaultName}"`);
  }
  if (payload.exp <= Date.now()) throw new Error('ticket minted already expired');
  if (!payload.gw || !payload.t || !payload.s) throw new Error('ticket missing gw/t/s');
  ctx.note(`minted ticket ${payload.t} (expires ${new Date(payload.exp).toISOString()})`);

  // 2. A never-seen device redeems it.
  const device = await ctx.newDevice();
  const paired = await device.pairGateway(payload.gw, {
    ticketId: payload.t,
    secret: payload.s,
    deviceName: 'agent-e2e laptop',
    platform: 'agent-e2e',
  });
  if (!paired.ok) throw new Error(`redeem failed: ${JSON.stringify(paired)}`);
  if (!paired.vaultId || paired.vaultName !== 'Shared') {
    throw new Error(`pair response names the wrong vault: ${JSON.stringify(paired)}`);
  }
  if (!paired.version || typeof paired.schemaEpoch !== 'number') {
    throw new Error(`pair response missing handshake material: ${JSON.stringify(paired)}`);
  }
  ctx.note(`device ${device.endpointId.slice(0, 10)}… enrolled (gateway v${paired.version})`);

  // 3. The durable gateway.db enrollment is visible to the admin CLI.
  const roster = await ctx.requestJson(device, 'GET', '/centraid/_gateway/devices');
  if (roster.response.status !== 200) {
    throw new Error(`devices roster returned ${roster.response.status}`);
  }
  const enrolled = roster.json.devices.find((row) => row.endpointId === device.endpointId);
  if (!enrolled || enrolled.vaultId !== paired.vaultId || enrolled.platform !== 'agent-e2e') {
    throw new Error(`devices list does not show ${device.endpointId}`);
  }

  // 4. Enrollment admits the tunnel.
  const probe = await ctx.request(device, '/centraid/_vault/vaults');
  if (probe.status !== 200) throw new Error(`tunneled probe → ${probe.status}`);
  ctx.note('enrolled device tunnels: GET /centraid/_vault/vaults → 200');

  // 5. The ticket burned on success.
  const replay = await device.pairGateway(payload.gw, {
    ticketId: payload.t,
    secret: payload.s,
    deviceName: 'replay',
    platform: 'agent-e2e',
  });
  if (replay.ok) throw new Error('replayed ticket redeemed twice');
  ctx.note(`replay refused (${replay.error})`);

  // 6. Restart: permanent identity + persisted enrollment.
  const endpointBefore = ctx.gateway.endpointId;
  await ctx.restartGateway();
  if (ctx.gateway.endpointId !== endpointBefore) {
    throw new Error('gateway EndpointId changed across restart — identity is not permanent');
  }
  const probeAfter = await ctx.request(device, '/centraid/_vault/vaults');
  if (probeAfter.status !== 200) throw new Error(`post-restart probe → ${probeAfter.status}`);
  ctx.note('daemon restarted: same EndpointId, device still enrolled, tunnel works');

  // 7. Revocation shuts the door.
  const revoked = await ctx.requestJson(
    device,
    'DELETE',
    `/centraid/_gateway/devices/${encodeURIComponent(enrolled.deviceId)}`,
  );
  if (revoked.response.status !== 200 || revoked.json.removed !== true) {
    throw new Error(`self-revoke failed: ${JSON.stringify(revoked.json)}`);
  }
  await ctx.expectTunnelRefused(device);
  ctx.note('revoked device refused at the QUIC layer');

  return {
    pass: true,
    notes:
      'mint → redeem → enroll → tunnel → burn → restart-persist → revoke, all against real processes',
  };
});
