/*
 * HOSTILE-PEER PROTOCOL HARNESS (#842, #726). The fuzz suites attack the
 * DECODER; this one attacks a peer that speaks the wire CORRECTLY BUT
 * MALICIOUSLY — every frame parses, and the abuse is in the STATE MACHINE.
 * The rig drives a REAL endpoint into the REAL peer handler, with production
 * admission, so each abuse happens inside the window it would in the wild.
 * Every assertion reads REAL server-side state: a breach here is a defect to
 * PIN, not a test to soften. Every abuse is STRUCTURAL — no wall-clock sleep.
 */ import { promises as fs } from "node:fs";
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

/** Fixed seeds keep signatures replayable. */
function vaultIdentity(seedByte: number, vaultId: string) {
  const seed = Buffer.alloc(32, seedByte);
  return {
    vaultId,
    seed,
    publicKey: vaultIdentityPublicKey(seed).toString("base64"),
    partyId: `party-${vaultId}`,
  };
}

const HOST = vaultIdentity(0x11, "vlt-host");
/** A DIFFERENT owner's vault, as the ceremony requires. */
const PEER = vaultIdentity(0x22, "vlt-peer");

interface HostileWorld {
  links: VaultLinksStore;
  endpoint: GatewayEndpointHandle;
  client: TunnelClient;
  server: http.Server;
  /** Admission is decided AT CONNECT, so every test mints its ticket or
   *  establishes its link BEFORE calling this. */
  connect: () => Promise<Connection>;
  linkRowCount: () => number;
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
    authorize: () => false,
    pair: () => ({ ok: false, error: "not_used" }),
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

  // The burn is ATOMIC with the link write: no second link, no resurrection.
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
    expect(world.linkRowCount()).toBe(1);
    expect(world.ticketRowCount()).toBe(0);
  }, 60_000);

  // Sent before the link, it must write nothing and leave the ticket live.
  test("a valid route assertion sent before the link writes nothing", async () => {
    const world = await hostileWorld();
    world.links.tickets.mint(HOST.vaultId, HOST.publicKey);
    const connection = await world.connect();

    const premature = await ask(connection, {
      method: "POST",
      target: "/centraid/_peer/route/assert",
      body: signedAssertion(world.client.endpointId, Date.now() + 60_000),
    });
    expect(premature.status).toBe(404);
    expect(premature.json).toStrictEqual({ state: "not_found" });
    expect(world.linkRowCount()).toBe(0);
    expect(world.links.routeFor(PEER.vaultId)).toBeUndefined();
    expect(world.links.tickets.hasPending()).toBe(true);
  }, 60_000);

  // The version wall fires BEFORE `tickets.claim`, so an incompletable
  // handshake never burns the one-time ticket.
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
    expect(world.ticketRowCount()).toBe(1);
    expect(world.links.tickets.hasPending()).toBe(true);
    expect(world.linkRowCount()).toBe(0);

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

  // `recordRoute` advances only on a strictly newer timestamp, so a replayed
  // assertion cannot re-point the gateway. `Date.now() + 60_000` is an
  // ordering key, not randomness (oxlint.config.ts).
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
    expect(replay.json).toStrictEqual({ state: "stale" });
    expect(world.links.routeFor(PEER.vaultId)?.assertedAt).toBe(ts);
  }, 60_000);

  // Streams are served independently, so a parked read wedges nothing.
  test("a stalled stream neither wedges the connection nor mints a link", async () => {
    const world = await hostileWorld();
    world.links.tickets.mint(HOST.vaultId, HOST.publicKey);
    const connection = await world.connect();

    // Deliberately never finished: the header read parks.
    const stalled = await connection.openBi();
    await stalled.send.writeAll([0, 0, 4, 0]);
    await stalled.send.writeAll([0x7b, 0x22, 0x74]);

    const hello = await ask(connection, {
      method: "GET",
      target: "/centraid/_peer/link/hello",
    });
    expect(hello.status).toBe(200);
    expect(hello.json).toMatchObject({ state: "ready" });
    expect(world.linkRowCount()).toBe(0);
  }, 60_000);

  // Past capacity, requests are refused as a typed state, never queued.
  test("a per-link request flood is bounded by the hygiene budget", async () => {
    const world = await hostileWorld({ budgetCapacity: 3 });
    world.links.tickets.mint(HOST.vaultId, HOST.publicKey);
    const connection = await world.connect();

    const outcomes: WireAnswer[] = [];
    for (let index = 0; index < 4; index += 1) {
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
    expect(outcomes[3]!.status).toBe(429);
    expect(outcomes[3]!.json).toStrictEqual({ state: "rate_limited" });
  }, 60_000);

  // The ceremony is a live moment, not a standing invitation. The injectable
  // `now` keeps this off the wall clock.
  test("an expired, abandoned ticket is reclaimed and admits no one", async () => {
    const world = await hostileWorld();

    // The door is a function of the clock, so a never-redeemed ticket cannot
    // keep the plane open forever.
    const live = world.links.tickets.mint(HOST.vaultId, HOST.publicKey);
    const now0 = Date.now();
    expect(world.links.tickets.hasPending(now0)).toBe(true);
    expect(world.links.tickets.hasPending(now0 + 16 * 60 * 1000)).toBe(false);

    const expired = world.links.tickets.mint(HOST.vaultId, HOST.publicKey, -1);
    expect(
      world.links.tickets.claim(expired.ticketId, expired.secret)
    ).toBeUndefined();
    expect(world.links.tickets.hasPending()).toBe(true);
    expect(world.links.tickets.claim(live.ticketId, live.secret)).toMatchObject(
      { vaultId: HOST.vaultId }
    );

    // With no link and no live ticket, a fresh dial is refused at the
    // transport, not served.
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

// The forwarders' `isPeerPlaneTarget` is what keeps every request above inside
// the plane.
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
