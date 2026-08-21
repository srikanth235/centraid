/*
 * HOSTILE-PEER PROTOCOL HARNESS (umbrella #842 W2.3, gap on #726 P3).
 *
 * The fuzz suites (`manifest-scope-denial.fuzz.test.ts`,
 * `packages/tunnel/src/wire-properties.test.ts`) attack the DECODER with
 * garbage. This suite attacks a peer that speaks the wire CORRECTLY BUT
 * MALICIOUSLY: every frame below parses and is individually well-formed — the
 * abuse is in the STATE MACHINE (order, repetition, an unfinished ceremony, an
 * abandoned ticket, a stream flood). The peer plane (#726 P3) is the newest
 * attack surface; the steward-signature suites cover only the commons rail, so
 * the ceremony and route-assertion state machine had no adversarial-peer rig.
 *
 * The rig, reused from #839's join lane and `peer-plane.test.ts`, drives a REAL
 * iroh endpoint end to end: `startGatewayEndpoint` binds the `centraid/gw-link/1`
 * ALPN, a real `createTunnelClient().connectPeer()` dials it over in-process
 * QUIC, and the endpoint forwards each stream to the REAL server-side peer
 * handler (`makePeerPlaneHandler`) over a loopback HTTP hop — the same transport
 * a linked gateway uses. Admission mirrors production: the peer ALPN admits an
 * unknown endpoint ONLY while a link exists or a ticket is pending
 * (`hasAnyLink() || tickets.hasPending()`), so the abuses below happen inside
 * the exact window they would in the wild.
 *
 * Every assertion reads REAL server-side state — `vault_links` rows, the
 * `peer_link_tickets` table, the recorded route's `assertedAt` — never a log
 * line. An abuse that breached an invariant here would be a real defect to PIN,
 * not a test to soften.
 *
 * Runnable HERE: real QUIC runs in-process (the join lane proves it). Every
 * abuse below is STRUCTURAL — a fixed number of round trips, no wall-clock
 * sleep, no `setTimeout` race. Ticket expiry is asserted through the store's
 * injectable `now`/past-expiry mint rather than by waiting out a TTL, so there
 * is nothing to split into a nightly wall-clock variant.
 */

import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import { peerHello, PEER_PROTOCOL_VERSION } from "@centraid/core/protocol";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  createTunnelClient,
  isPeerPlaneTarget,
  PEER_ENDPOINT_HEADER,
  PEER_PROOF_HEADER,
  startGatewayEndpoint,
  tunnelRequest,
} from "@centraid/tunnel";
import type {
  Connection,
  GatewayEndpointHandle,
  TunnelClient,
} from "@centraid/tunnel";
import { signWithVaultIdentity, vaultIdentityPublicKey } from "@centraid/vault";

import { makePeerPlaneHandler } from "../routes/peer-plane.ts";
import { GatewayDatabase } from "./gateway-db.ts";
import { routeAssertionBytes } from "./peer-route-assertion.ts";
import type { RouteClaim } from "./peer-route-assertion.ts";
import { VaultLinksStore } from "./vault-links-store.ts";

const PEER_PROOF = "h".repeat(64);
const UPSTREAM_TOKEN = "hostile-peer-loopback-secret";

/** A deterministic vault identity — fixed seeds keep signatures replayable. */
function vaultIdentity(seedByte: number, vaultId: string) {
  const seed = Buffer.alloc(32, seedByte);
  return {
    vaultId,
    seed,
    publicKey: vaultIdentityPublicKey(seed).toString("base64"),
    partyId: `party-${vaultId}`,
  };
}

/** The gateway under attack. */
const HOST = vaultIdentity(0x11, "vlt-host");
/** The malicious gateway. A DIFFERENT owner's vault, as the ceremony requires. */
const PEER = vaultIdentity(0x22, "vlt-peer");

interface HostileWorld {
  links: VaultLinksStore;
  endpoint: GatewayEndpointHandle;
  client: TunnelClient;
  server: http.Server;
  /**
   * Dial the peer plane. The peer ALPN admits a stranger only while admission
   * holds (a live ticket or link), and that decision is taken AT CONNECT — so
   * every test mints its ticket or establishes its link BEFORE calling this,
   * exactly as a real ceremony's ticket precedes the dial.
   */
  connect: () => Promise<Connection>;
  /** Live + revoked link rows this gateway holds. */
  linkRowCount: () => number;
  /** Rows in `peer_link_tickets`, live or expired. */
  ticketRowCount: () => number;
}

const worlds: HostileWorld[] = [];
const connections: Connection[] = [];
const dataDirs: string[] = [];

async function closeEverything(): Promise<void> {
  for (const connection of connections.splice(0)) connection.close(0n, []);
  await Promise.all(
    worlds.splice(0).map(async (world) => {
      await world.client.close().catch(() => undefined);
      await world.endpoint.close().catch(() => undefined);
      await new Promise<void>((resolve) => {
        world.server.close(() => resolve());
      });
    })
  );
  await Promise.all(
    dataDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
}

/**
 * One gateway serving the real peer handler over a real endpoint, and one live
 * malicious peer connection. `budgetCapacity` shrinks the per-link hygiene
 * budget for the flood test; the default is wide so it never interferes.
 */
async function hostileWorld(
  options: { budgetCapacity?: number } = {}
): Promise<HostileWorld> {
  const dataDir = await tempDir("hostile-peer-");
  dataDirs.push(dataDir);
  const database = GatewayDatabase.open(dataDir, { lock: "exclusive" });
  const links = VaultLinksStore.open(database);

  const handler = makePeerPlaneHandler({
    links,
    peerProof: PEER_PROOF,
    vaultPublicKey: (vaultId) =>
      vaultId === HOST.vaultId ? HOST.publicKey : undefined,
    ownerPartyFor: (vaultId) =>
      vaultId === HOST.vaultId ? HOST.partyId : undefined,
    localRoute: () => ({ endpointId: "ep-host", relayHints: [] }),
    localLabel: () => "host",
    ...(options.budgetCapacity === undefined
      ? {}
      : {
          budget: makeCountingBudget(options.budgetCapacity),
        }),
  });

  // The loopback hop the endpoint forwards each stream to — the same seam the
  // gateway's own bearer sits above in production.
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end(JSON.stringify({ state: "not_found" }));
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const endpoint = await startGatewayEndpoint({
    upstream: () => ({ baseUrl, token: UPSTREAM_TOKEN }),
    // The device lane admits nobody: the peer plane must stand on its own.
    authorize: () => false,
    pair: () => ({ ok: false, error: "not_used" }),
    // Production admission (vault-links-store `hasAnyLink`, peer-link-tickets
    // `hasPending`): a stranger is admitted only during a live ceremony.
    authorizePeer: () => links.hasAnyLink() || links.tickets.hasPending(),
    peerRequestHeaders: (endpointId) => ({
      [PEER_ENDPOINT_HEADER]: endpointId,
      [PEER_PROOF_HEADER]: PEER_PROOF,
    }),
    relays: "disabled",
  });

  const client = await createTunnelClient({ relays: "disabled" });

  const world: HostileWorld = {
    links,
    endpoint,
    client,
    server,
    connect: async () => {
      const connection = await client.connectPeer(endpoint.ticket());
      connections.push(connection);
      return connection;
    },
    linkRowCount: () =>
      (
        database.db.prepare("SELECT COUNT(*) AS n FROM vault_links").get() as {
          n: number;
        }
      ).n,
    ticketRowCount: () =>
      (
        database.db
          .prepare("SELECT COUNT(*) AS n FROM peer_link_tickets")
          .get() as { n: number }
      ).n,
  };
  worlds.push(world);
  return world;
}

/** A token bucket that never refills within a test — capacity is the hard cap. */
function makeCountingBudget(capacity: number) {
  let tokens = capacity;
  return {
    take: (_id: string, cost = 1): boolean => {
      if (tokens < cost) return false;
      tokens -= cost;
      return true;
    },
    retryAfterMs: () => 1000,
    forget: () => undefined,
    size: () => 0,
  };
}

interface WireAnswer {
  status: number;
  json: Record<string, unknown>;
}

/** One peer-plane request down one bi-stream of the live malicious connection. */
async function ask(
  connection: Connection,
  input: { method: string; target: string; body?: Record<string, unknown> }
): Promise<WireAnswer> {
  const response = await tunnelRequest(connection, {
    method: input.method,
    target: input.target,
    headers: { "content-type": "application/json" },
    ...(input.body ? { body: Buffer.from(JSON.stringify(input.body)) } : {}),
  });
  const text = response.body.toString("utf8");
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

/** A well-formed redemption body for HOST's ticket, presenting PEER's vault. */
function redeemBody(
  ticket: { ticketId: string; secret: string },
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ...peerHello(),
    ticketId: ticket.ticketId,
    secret: ticket.secret,
    vaultId: PEER.vaultId,
    vaultPublicKey: PEER.publicKey,
    ownerPartyId: PEER.partyId,
    label: "peer",
    ...overrides,
  };
}

/** A validly-signed route assertion moving PEER's vault to `endpointId` at `ts`. */
function signedAssertion(
  endpointId: string,
  ts: number
): Record<string, unknown> {
  const claim: RouteClaim = {
    vaultId: PEER.vaultId,
    endpointId,
    relayHints: [],
    ts,
  };
  return {
    ...claim,
    signature: signWithVaultIdentity(
      PEER.seed,
      routeAssertionBytes(claim)
    ).toString("base64"),
  };
}

describe("hostile peer: protocol-level state-machine abuse", () => {
  afterEach(closeEverything);

  /*
   * REPLAY. A one-time link ticket is redeemed, then the IDENTICAL redemption
   * is replayed. Invariant: the burn is atomic with the link write, so the
   * replay is `not_found` — no second link, no resurrected ticket. A replay is
   * never accepted as fresh.
   *
   * DEMONSTRATED-RED: if `PeerLinkTicketStore.claim` did not DELETE the row
   * (single-use disabled), the second redeem would mint a SECOND link — this
   * asserts `linkRowCount() === 1`, which then fails.
   */
  test("a redeemed link ticket cannot be replayed as a fresh redemption", async () => {
    const world = await hostileWorld();
    const ticket = world.links.tickets.mint(HOST.vaultId, HOST.publicKey);
    expect(world.ticketRowCount()).toBe(1);
    const connection = await world.connect();

    const first = await ask(connection, {
      method: "POST",
      target: "/centraid/_peer/link/redeem",
      body: redeemBody(ticket),
    });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({
      state: "linked",
      vaultId: HOST.vaultId,
    });
    // The link is real and the ticket is burned in the SAME transaction.
    expect(world.linkRowCount()).toBe(1);
    expect(world.ticketRowCount()).toBe(0);
    expect(world.links.isLinked(world.client.endpointId)).toBe(true);

    const replay = await ask(connection, {
      method: "POST",
      target: "/centraid/_peer/link/redeem",
      body: redeemBody(ticket),
    });
    expect(replay.status).toBe(404);
    expect(replay.json).toStrictEqual({ state: "not_found" });
    // No phantom success: still exactly one link, still no ticket.
    expect(world.linkRowCount()).toBe(1);
    expect(world.ticketRowCount()).toBe(0);
  }, 60_000);

  /*
   * OUT OF ORDER. A route assertion is a LATER-stage frame — it only means
   * something once a link exists. Sent BEFORE the ceremony (while the ticket is
   * still pending, which is what admits the peer at all), it must write
   * nothing: no link, no route, and the ticket stays reclaimable.
   */
  test("a valid route assertion sent before the link writes nothing", async () => {
    const world = await hostileWorld();
    world.links.tickets.mint(HOST.vaultId, HOST.publicKey);
    const connection = await world.connect();

    const premature = await ask(connection, {
      method: "POST",
      target: "/centraid/_peer/route/assert",
      body: signedAssertion(world.client.endpointId, Date.now() + 60_000),
    });
    // Topology hiding: an assertion for a vault with no link is `not_found`.
    expect(premature.status).toBe(404);
    expect(premature.json).toStrictEqual({ state: "not_found" });
    // Nothing partial persisted, and the ceremony is still redeemable.
    expect(world.linkRowCount()).toBe(0);
    expect(world.links.routeFor(PEER.vaultId)).toBeUndefined();
    expect(world.links.tickets.hasPending()).toBe(true);
  }, 60_000);

  /*
   * STALLED HANDSHAKE (version wall). A peer from an incompatible protocol
   * begins redemption. The mutual-window wall fires BEFORE the ticket is
   * touched (`judgePeerHandshake` ahead of `tickets.claim`), so a handshake
   * that cannot complete never burns the one-time ticket. Proof it was NOT
   * spent: a compatible redemption of the same ticket still links.
   */
  test("a version-refused handshake never burns the one-time ticket", async () => {
    const world = await hostileWorld();
    const ticket = world.links.tickets.mint(HOST.vaultId, HOST.publicKey);
    const connection = await world.connect();

    const future = PEER_PROTOCOL_VERSION + 1;
    const refused = await ask(connection, {
      method: "POST",
      target: "/centraid/_peer/link/redeem",
      body: redeemBody(ticket, {
        peerProtocolVersion: future,
        minPeerProtocol: future,
      }),
    });
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ state: "protocol_refused" });
    // The ticket is untouched — still pending, still exactly one row.
    expect(world.ticketRowCount()).toBe(1);
    expect(world.links.tickets.hasPending()).toBe(true);
    expect(world.linkRowCount()).toBe(0);

    // Same ticket, now a compatible hello: it links, proving it was reclaimable.
    const ok = await ask(connection, {
      method: "POST",
      target: "/centraid/_peer/link/redeem",
      body: redeemBody(ticket),
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ state: "linked" });
    expect(world.ticketRowCount()).toBe(0);
    expect(world.linkRowCount()).toBe(1);
  }, 60_000);

  /*
   * DUPLICATED FRAME at the route layer. After a link forms, a signed route
   * assertion moves the cached route. Replaying the SAME assertion (same `ts`)
   * must be `stale`, not re-applied: `recordRoute` only advances on a strictly
   * newer timestamp, so a captured-and-replayed assertion cannot re-point the
   * gateway. `Date.now() + 60_000` is a monotonic ordering key past the
   * redeem-time stamp, not a randomness source (see oxlint.config.ts).
   */
  test("a duplicated route assertion is stale, never re-applied as fresh", async () => {
    const world = await hostileWorld();
    const ticket = world.links.tickets.mint(HOST.vaultId, HOST.publicKey);
    const connection = await world.connect();
    await ask(connection, {
      method: "POST",
      target: "/centraid/_peer/link/redeem",
      body: redeemBody(ticket),
    });

    const ts = Date.now() + 60_000;
    const assertion = signedAssertion(world.client.endpointId, ts);
    const first = await ask(connection, {
      method: "POST",
      target: "/centraid/_peer/route/assert",
      body: assertion,
    });
    expect(first.json).toStrictEqual({ state: "accepted" });
    const routeAfter = world.links.routeFor(PEER.vaultId);
    expect(routeAfter?.assertedAt).toBe(ts);

    const replay = await ask(connection, {
      method: "POST",
      target: "/centraid/_peer/route/assert",
      body: assertion,
    });
    // Verifies, but does not move the cache — the sender is told so plainly.
    expect(replay.json).toStrictEqual({ state: "stale" });
    expect(world.links.routeFor(PEER.vaultId)?.assertedAt).toBe(ts);
  }, 60_000);

  /*
   * SLOW-LORIS / STALLED STREAM. A raw bi-stream declares a header frame length
   * then trickles a couple of bytes and NEVER finishes it. The endpoint serves
   * each stream independently, so the parked read neither wedges the connection
   * nor mints anything: a fresh, well-formed request on a NEW stream is still
   * answered promptly, and no link exists. Bounded by construction — asserted
   * structurally, with no wall-clock timeout to make it nightly-only.
   */
  test("a stalled stream neither wedges the connection nor mints a link", async () => {
    const world = await hostileWorld();
    world.links.tickets.mint(HOST.vaultId, HOST.publicKey);
    const connection = await world.connect();

    // A 4-byte big-endian length claiming 1024 bytes, then 3 bytes and silence.
    const stalled = await connection.openBi();
    await stalled.send.writeAll([0, 0, 4, 0]);
    await stalled.send.writeAll([0x7b, 0x22, 0x74]); // `{"t`, never completed
    // Deliberately no finish() and no further bytes: the header read parks.

    // The connection is not consumed: a fresh stream answers as normal.
    const hello = await ask(connection, {
      method: "GET",
      target: "/centraid/_peer/link/hello",
    });
    expect(hello.status).toBe(200);
    expect(hello.json).toMatchObject({ state: "ready" });
    // The stall produced no phantom link.
    expect(world.linkRowCount()).toBe(0);
  }, 60_000);

  /*
   * FLOOD (per-link budget). Many well-formed requests down one link are
   * bounded by the per-link token bucket: past capacity, excess requests are
   * refused as a typed `rate_limited` state, never queued unboundedly. Capacity
   * is shrunk here so the bound is reached in a fixed, fast number of streams.
   */
  test("a per-link request flood is bounded by the hygiene budget", async () => {
    const world = await hostileWorld({ budgetCapacity: 3 });
    world.links.tickets.mint(HOST.vaultId, HOST.publicKey);
    const connection = await world.connect();

    const outcomes: WireAnswer[] = [];
    for (let index = 0; index < 4; index += 1) {
      // Sequential on purpose: the budget is a running count, and interleaving
      // would hide which request crossed the cap.
      // oxlint-disable-next-line no-await-in-loop -- one metered request at a time
      const answer = await ask(connection, {
        method: "GET",
        target: "/centraid/_peer/link/hello",
      });
      outcomes.push(answer);
    }
    expect(outcomes.slice(0, 3).map((o) => o.status)).toStrictEqual([
      200, 200, 200,
    ]);
    // The fourth is refused as a state, not a fault or a hang.
    expect(outcomes[3]!.status).toBe(429);
    expect(outcomes[3]!.json).toStrictEqual({ state: "rate_limited" });
  }, 60_000);

  /*
   * ABANDONED TICKET RECLAIMED. A ticket minted and never redeemed must stop
   * holding the peer door open once it expires, and must never be redeemable
   * afterwards — the ceremony is a live moment, not a standing invitation.
   * Asserted deterministically through the store's injectable `now` and a
   * past-expiry mint (no TTL wall-clock wait), then proved over the REAL
   * transport: with only an expired ticket, the peer ALPN admits nobody.
   */
  test("an expired, abandoned ticket is reclaimed and admits no one", async () => {
    const world = await hostileWorld();

    // A live ticket holds the door open...
    const live = world.links.tickets.mint(HOST.vaultId, HOST.publicKey);
    const now0 = Date.now();
    expect(world.links.tickets.hasPending(now0)).toBe(true);
    // ...and self-closes at expiry: the door is a function of the clock, so a
    // never-redeemed ticket cannot keep the plane open forever.
    expect(world.links.tickets.hasPending(now0 + 16 * 60 * 1000)).toBe(false);

    // An already-expired ticket cannot be claimed as fresh.
    const expired = world.links.tickets.mint(HOST.vaultId, HOST.publicKey, -1);
    expect(
      world.links.tickets.claim(expired.ticketId, expired.secret)
    ).toBeUndefined();
    // The live one is still claimable — expiry reclaimed only the expired door.
    expect(world.links.tickets.hasPending()).toBe(true);
    expect(world.links.tickets.claim(live.ticketId, live.secret)).toMatchObject(
      { vaultId: HOST.vaultId }
    );

    // With no link and no live ticket, the real endpoint admits no peer: a
    // fresh dial's first request is refused at the transport, not served.
    const stranger = await createTunnelClient({ relays: "disabled" });
    const strangerConn = await stranger.connectPeer(world.endpoint.ticket());
    await expect(
      ask(strangerConn, {
        method: "GET",
        target: "/centraid/_peer/link/hello",
      })
    ).rejects.toThrow(Error);
    strangerConn.close(0n, []);
    await stranger.close();
  }, 60_000);
});

/*
 * A cheap guard that the confinement constant this suite leans on is the one
 * the transport enforces: `link/hello` and `route/assert` are peer-plane
 * targets, an owner-tier path is not. The forwarders' `isPeerPlaneTarget` is
 * what keeps every request above inside the plane.
 */
describe("hostile peer: the plane the abuses ride is confined", () => {
  test("the abuse targets are peer-plane, an owner path is not", () => {
    expect(isPeerPlaneTarget("/centraid/_peer/link/redeem")).toBe(true);
    expect(isPeerPlaneTarget("/centraid/_peer/route/assert")).toBe(true);
    expect(isPeerPlaneTarget("/centraid/_peer/link/hello")).toBe(true);
    expect(isPeerPlaneTarget("/centraid/_gateway/devices")).toBe(false);
    expect(isPeerPlaneTarget("/centraid/_peer/../_gateway/devices")).toBe(
      false
    );
  });
});
