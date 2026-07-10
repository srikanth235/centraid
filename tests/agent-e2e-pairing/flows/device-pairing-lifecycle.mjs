// The full pairing ceremony, every component in its real process — see the
// .md next to this file for intent.
import { runFlow } from '../lib/harness.mjs';

await runFlow('device-pairing-lifecycle', async (ctx) => {
  // 1. A named vault to pair into (the daemon already bootstrapped a default).
  const created = JSON.parse(
    (await ctx.cli(['vault', 'create', '--name', 'Family'])).stdout.trim().split('\n').at(-1),
  );
  if (!created.vaultId)
    throw new Error(`vault create returned no vaultId: ${JSON.stringify(created)}`);
  ctx.note(`created vault Family (${created.vaultId})`);

  // 2. Mint the pasteable ticket for it.
  const { payload } = await ctx.mintTicket({ vault: 'Family' });
  if (payload.vaultName !== 'Family') throw new Error(`ticket names vault "${payload.vaultName}"`);
  if (payload.exp <= Date.now()) throw new Error('ticket minted already expired');
  if (!payload.gw || !payload.t || !payload.s) throw new Error('ticket missing gw/t/s');
  ctx.note(`minted ticket ${payload.t} (expires ${new Date(payload.exp).toISOString()})`);

  // 3. A never-seen device redeems it.
  const device = await ctx.newDevice();
  const paired = await device.pairGateway(payload.gw, {
    ticketId: payload.t,
    secret: payload.s,
    deviceName: 'agent-e2e laptop',
    platform: 'agent-e2e',
  });
  if (!paired.ok) throw new Error(`redeem failed: ${JSON.stringify(paired)}`);
  if (paired.vaultId !== created.vaultId || paired.vaultName !== 'Family') {
    throw new Error(`pair response names the wrong vault: ${JSON.stringify(paired)}`);
  }
  if (!paired.version || typeof paired.schemaEpoch !== 'number') {
    throw new Error(`pair response missing handshake material: ${JSON.stringify(paired)}`);
  }
  ctx.note(`device ${device.endpointId.slice(0, 10)}… enrolled (gateway v${paired.version})`);

  // 4. The enrollment is visible to the admin CLI and on disk.
  const listed = (await ctx.cli(['devices', 'list', '--vault', 'Family'])).stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (!listed.some((row) => row.endpointId === device.endpointId)) {
    throw new Error(`devices list does not show ${device.endpointId}`);
  }
  const onDisk = (await ctx.readJson('devices.json')).enrollments.find(
    (row) => row.endpointId === device.endpointId,
  );
  if (!onDisk || onDisk.vaultId !== created.vaultId || onDisk.platform !== 'agent-e2e') {
    throw new Error(`devices.json row wrong: ${JSON.stringify(onDisk)}`);
  }

  // 5. Enrollment admits the tunnel.
  const probe = await ctx.request(device, '/centraid/_vault/vaults');
  if (probe.status !== 200) throw new Error(`tunneled probe → ${probe.status}`);
  ctx.note('enrolled device tunnels: GET /centraid/_vault/vaults → 200');

  // 6. The ticket burned on success.
  const replay = await device.pairGateway(payload.gw, {
    ticketId: payload.t,
    secret: payload.s,
    deviceName: 'replay',
    platform: 'agent-e2e',
  });
  if (replay.ok) throw new Error('replayed ticket redeemed twice');
  ctx.note(`replay refused (${replay.error})`);

  // 7. Restart: permanent identity + persisted enrollment.
  const endpointBefore = ctx.gateway.endpointId;
  await ctx.restartGateway();
  if (ctx.gateway.endpointId !== endpointBefore) {
    throw new Error('gateway EndpointId changed across restart — identity is not permanent');
  }
  const probeAfter = await ctx.request(device, '/centraid/_vault/vaults');
  if (probeAfter.status !== 200) throw new Error(`post-restart probe → ${probeAfter.status}`);
  ctx.note('daemon restarted: same EndpointId, device still enrolled, tunnel works');

  // 8. Revocation shuts the door.
  await ctx.cli(['devices', 'revoke', device.endpointId]);
  await ctx.expectTunnelRefused(device);
  ctx.note('revoked device refused at the QUIC layer');

  return {
    pass: true,
    notes:
      'mint → redeem → enroll → tunnel → burn → restart-persist → revoke, all against real processes',
  };
});
