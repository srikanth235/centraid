// The failure half of the pairing ceremony — see the .md next to this file.
import { runFlow, parseTicket } from "../lib/harness.mjs";

await runFlow("pairing-ticket-hygiene", async (ctx) => {
  const device = await ctx.newDevice();

  // 1. Wrong secret is refused without burning the grant. This prevents an
  // attacker from invalidating a user's ticket by guessing once.
  const a = (await ctx.mintTicket()).payload;
  const wrong = await device.pairGateway(a.gw, {
    ticketId: a.t,
    secret: "not-the-secret",
    deviceName: "mallory",
    platform: "agent-e2e",
  });
  if (wrong.ok) throw new Error("wrong secret redeemed");
  const redeemed = await device.pairGateway(a.gw, {
    ticketId: a.t,
    secret: a.s,
    deviceName: "mallory-retry",
    platform: "agent-e2e",
  });
  if (!redeemed.ok)
    throw new Error(
      `correct secret did not survive wrong guess: ${redeemed.error}`
    );
  const replay = await device.pairGateway(a.gw, {
    ticketId: a.t,
    secret: a.s,
    deviceName: "mallory-replay",
    platform: "agent-e2e",
  });
  if (replay.ok)
    throw new Error("successful redemption did not consume the ticket");
  ctx.note(
    "wrong secret refused without burning; successful redemption consumed the ticket"
  );
  const roster = await ctx.requestJson(
    device,
    "GET",
    "/centraid/_gateway/devices"
  );
  const enrollment = roster.json?.devices?.find(
    (row) => row.endpointId === device.endpointId
  );
  if (!enrollment)
    throw new Error("redeemed device missing from gateway.db-backed roster");
  const revoked = await ctx.requestJson(
    device,
    "DELETE",
    `/centraid/_gateway/devices/${encodeURIComponent(enrollment.deviceId)}`
  );
  if (revoked.response.status !== 200 || revoked.json?.removed !== true) {
    throw new Error(`self-revoke failed: ${JSON.stringify(revoked.json)}`);
  }

  // 2. Expired tickets never redeem.
  const b = (await ctx.mintTicket({ ttlMinutes: 0.001 })).payload; // 60ms
  await new Promise((resolve) => {
    setTimeout(resolve, 500);
  });
  const stale = await device.pairGateway(b.gw, {
    ticketId: b.t,
    secret: b.s,
    deviceName: "latecomer",
    platform: "agent-e2e",
  });
  if (stale.ok) throw new Error("expired ticket redeemed");
  ctx.note("expired ticket refused despite the correct secret");

  // Through expiry and after revocation: no attacker enrollment, no tunnel.
  await ctx.expectTunnelRefused(device);
  ctx.note("prober never enrolled; QUIC layer refuses its tunnel");

  // 3. Garbage never even dials.
  let parsed;
  try {
    parsed = parseTicket("this is not a ticket");
  } catch {
    // expected
  }
  if (parsed) throw new Error("garbage parsed as a ticket");

  return {
    pass: true,
    notes:
      "wrong-secret non-burning refusal, one-shot redemption, expiry, and QUIC refusal hold",
  };
});
