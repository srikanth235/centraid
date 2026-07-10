// The failure half of the pairing ceremony — see the .md next to this file.
import { runFlow, parseTicket } from '../lib/harness.mjs';

await runFlow('pairing-ticket-hygiene', async (ctx) => {
  const device = await ctx.newDevice();

  // 1. Wrong secret burns the ticket for good.
  const a = (await ctx.mintTicket()).payload;
  const wrong = await device.pairGateway(a.gw, {
    ticketId: a.t,
    secret: 'not-the-secret',
    deviceName: 'mallory',
    platform: 'agent-e2e',
  });
  if (wrong.ok) throw new Error('wrong secret redeemed');
  const burned = await device.pairGateway(a.gw, {
    ticketId: a.t,
    secret: a.s,
    deviceName: 'mallory-retry',
    platform: 'agent-e2e',
  });
  if (burned.ok) throw new Error('ticket survived a wrong-secret attempt');
  ctx.note('wrong secret refused AND burned the ticket for the right secret');

  // 2. Expired tickets never redeem.
  const b = (await ctx.mintTicket({ ttlMinutes: 0.001 })).payload; // 60ms
  await new Promise((resolve) => setTimeout(resolve, 500));
  const stale = await device.pairGateway(b.gw, {
    ticketId: b.t,
    secret: b.s,
    deviceName: 'latecomer',
    platform: 'agent-e2e',
  });
  if (stale.ok) throw new Error('expired ticket redeemed');
  ctx.note('expired ticket refused despite the correct secret');

  // Through all of it: no enrollment, no tunnel.
  const listed = (await ctx.cli(['devices', 'list'])).stdout.trim();
  if (listed !== '') throw new Error(`devices list should be empty, got:\n${listed}`);
  await ctx.expectTunnelRefused(device);
  ctx.note('prober never enrolled; QUIC layer refuses its tunnel');

  // 3. Garbage never even dials.
  let parsed;
  try {
    parsed = parseTicket('this is not a ticket');
  } catch {
    // expected
  }
  if (parsed) throw new Error('garbage parsed as a ticket');

  return { pass: true, notes: 'wrong-secret burn, expiry, and QUIC refusal all hold' };
});
