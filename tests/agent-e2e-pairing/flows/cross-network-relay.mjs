// The pairing ceremony over the REAL iroh relay/hole-punch path — see the
// .md next to this file for why the other two flows in this tier can't
// reach it (they run gateway + device on the same host with device relays
// explicitly disabled) and how this one forces it (two Docker containers on
// two non-interconnected bridge networks).
import { runFlow } from '../lib/docker-harness.mjs';

await runFlow('cross-network-relay', async (ctx) => {
  // 1. A named vault to pair into, created inside the gateway's own container.
  const createOut = await ctx.gatewayExec(['vault', 'create', '--name', 'CrossNet']);
  const created = JSON.parse(createOut.stdout.trim().split('\n').at(-1));
  if (!created.vaultId)
    throw new Error(`vault create returned no vaultId: ${JSON.stringify(created)}`);
  ctx.note(
    `created vault CrossNet (${created.vaultId}) inside ${ctx.gateway.endpointId.slice(0, 10)}…'s container`,
  );

  // 2. Mint the pasteable ticket — still minted inside the gateway container;
  // only the redemption crosses the network boundary.
  const { raw, payload } = await ctx.mintTicket({ vault: 'CrossNet' });
  if (payload.vaultName !== 'CrossNet')
    throw new Error(`ticket names vault "${payload.vaultName}"`);
  if (payload.exp <= Date.now()) throw new Error('ticket minted already expired');
  if (!payload.gw || !payload.t || !payload.s) throw new Error('ticket missing gw/t/s');
  ctx.note(`minted ticket ${payload.t} (expires ${new Date(payload.exp).toISOString()})`);

  // 3. Redeem it from a container on the OTHER network — no shared route to
  // the gateway's container, no relay override. Whatever createTunnelClient's
  // real default does (n0 production preset — confirmed by reading
  // packages/tunnel/src/client.ts, not assumed) is what runs here.
  const device = await ctx.runDevice({ ticket: raw, probeTarget: '/centraid/_vault/vaults' });
  if (device.error && !device.paired) {
    throw new Error(`device container reported a fatal error: ${device.error}`);
  }
  if (!device.paired) throw new Error(`redeem failed: ${JSON.stringify(device)}`);
  if (device.vaultId !== created.vaultId || device.vaultName !== 'CrossNet') {
    throw new Error(`pair response names the wrong vault: ${JSON.stringify(device)}`);
  }
  ctx.note(
    `device ${device.endpointId.slice(0, 10)}… (container on ${ctx.netB}) enrolled across the network boundary`,
  );

  // 4. The tunneled probe crossed the same boundary and got a real response.
  if (device.probeStatus !== 200) {
    throw new Error(`tunneled probe from the isolated device container → ${device.probeStatus}`);
  }
  ctx.note('cross-network tunneled probe: GET /centraid/_vault/vaults → 200');

  // 5. The replay attempt (same container run, second pairGateway call)
  // must have been refused — the ticket burns on first success same as the
  // loopback flow.
  if (!device.replayRefused) {
    throw new Error(
      `replayed ticket redeemed twice across the network boundary: ${JSON.stringify(device)}`,
    );
  }
  ctx.note(`replay refused (${device.replayError})`);

  // 6. Visible to the admin CLI on the gateway side, same as the loopback flow.
  const listOut = await ctx.gatewayExec(['devices', 'list', '--vault', 'CrossNet']);
  const listed = listOut.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (!listed.some((row) => row.endpointId === device.endpointId)) {
    throw new Error(`devices list does not show ${device.endpointId}`);
  }
  const onDisk = (await ctx.readGatewayFile('devices.json')).enrollments.find(
    (row) => row.endpointId === device.endpointId,
  );
  if (!onDisk || onDisk.vaultId !== created.vaultId) {
    throw new Error(`devices.json row wrong: ${JSON.stringify(onDisk)}`);
  }
  ctx.note('enrollment visible in devices list + devices.json from the gateway side');

  // 7. Path confirmation — the ONE thing this expensive Docker-network-
  // isolation harness exists to prove, and now a hard gate rather than an
  // observation. The topology (real DOCKER-USER DROP rules + a
  // pre-ceremony TCP probe, see lib/docker-harness.mjs) guarantees the two
  // containers have NO route to each other's IPs; that part is proven,
  // not inferred. Whether the QUIC connection specifically landed on
  // iroh's relay path is a SEPARATE question this flow answers directly:
  // @number0/iroh's native Connection exposes `paths()` with an `isRelay`
  // flag per candidate path (packages/tunnel/src/iroh.ts, extended in this
  // change to declare it — it was already present on the native binding,
  // just not in the repo's hand-written TS surface). device-redeem.mjs
  // reads it right after the tunneled probe, once a path has actually been
  // selected, and reports it as `device.path` (null if none was selected).
  if (!device.path) {
    throw new Error(
      'device reported no selected path — cannot confirm relay traversal; check ' +
        'device-redeem.mjs\'s paths() call and its stdout JSON contract',
    );
  }
  if (!device.path.isRelay) {
    // Isolation is still real (proven above by the pre-ceremony TCP
    // probe); a direct-marked path here means iroh found a route this
    // harness's isolation didn't block despite that — e.g. the
    // DOCKER-USER firewall rules aren't actually taking effect, or
    // OrbStack/Docker changed networking behavior. That's a real
    // regression signal for this flow's whole premise, not something to
    // note-and-continue past.
    throw new Error(
      `network isolation didn't force the relay path as expected — selected path reports ` +
        `isIp=${device.path.isIp} isRelay=${device.path.isRelay} (${device.path.remoteAddr}) ` +
        'despite the two networks having no route between them. This means the DOCKER-USER ' +
        'firewall rules are not actually blocking direct routes, or OrbStack/Docker networking ' +
        'changed — see the .md "What this does NOT prove" section.',
    );
  }
  ctx.note(
    `CONFIRMED at the QUIC layer: selected path is a RELAY (${device.path.remoteAddr}, ` +
      `rtt=${device.path.rttMs}ms) — this run exercised the real n0 relay fallback, not a lucky direct route.`,
  );

  return {
    pass: true,
    notes:
      'mint (gateway container) → redeem/tunnel/burn (device container, separate non-routable ' +
      'network) all held, with real DOCKER-USER-enforced network isolation proven before the ' +
      'ceremony ran, AND the QUIC connection confirmed on the real relay path',
  };
});
