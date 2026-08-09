/*
 * Peer plane route layer (issue #726 P3): the ceremony, the update wall, the
 * signed route assertion, and the two traps as seen from the HTTP side.
 */

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { peerHello } from "@centraid/protocol";
import { tempDirSync } from "@centraid/test-kit/temp-dir";
import {
  createTokenBucket,
  DEVICE_IDENTITY_HEADER,
  PEER_ENDPOINT_HEADER,
  PEER_PROOF_HEADER,
} from "@centraid/tunnel";
import { signWithVaultIdentity, vaultIdentityPublicKey } from "@centraid/vault";

import { GatewayDatabase } from "../serve/gateway-db.js";
import { routeAssertionBytes } from "../serve/peer-route-assertion.js";
import { VaultLinksStore } from "../serve/vault-links-store.js";
import { makePeerPlaneHandler } from "./peer-plane.js";

const PROOF = "a".repeat(64);
const LOCAL_VAULT = "vlt_local";
const PEER_VAULT = "vlt_peer";
const PEER_ENDPOINT = "endpoint-peer";
const LOCAL_KEY = "bG9jYWwtcHVibGljLWtleQ==";

const peerSeed = crypto.randomBytes(32);
const peerPublicKey = vaultIdentityPublicKey(peerSeed).toString("base64");

function openStore(): VaultLinksStore {
  return VaultLinksStore.open(
    GatewayDatabase.open(tempDirSync("centraid-peer-"))
  );
}

function makeHandler(links: VaultLinksStore) {
  return makePeerPlaneHandler({
    links,
    peerProof: PROOF,
    vaultPublicKey: (vaultId) =>
      vaultId === LOCAL_VAULT ? "bG9jYWwtcHVibGljLWtleQ==" : undefined,
    localRoute: () => ({ endpointId: "endpoint-local", relayHints: ["r1"] }),
    localLabel: () => "Home",
  });
}

async function call(
  handler: ReturnType<typeof makePeerPlaneHandler>,
  input: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  }
): Promise<{ handled: boolean; status: number; json: unknown }> {
  let statusCode = 0;
  let body = "";
  const req = Readable.from(
    input.body === undefined ? [] : [Buffer.from(JSON.stringify(input.body))]
  ) as IncomingMessage;
  req.method = input.method;
  req.url = input.url;
  req.headers = {
    [PEER_ENDPOINT_HEADER]: PEER_ENDPOINT,
    [PEER_PROOF_HEADER]: PROOF,
    ...input.headers,
  };
  const res = {
    setHeader: () => undefined,
    end(value?: string | Buffer) {
      if (value) body += value.toString();
    },
    get statusCode() {
      return statusCode;
    },
    set statusCode(value: number) {
      statusCode = value;
    },
  } as unknown as ServerResponse;
  const handled = await handler(req, res);
  return {
    handled,
    status: statusCode,
    json: body ? (JSON.parse(body) as unknown) : undefined,
  };
}

function redeemBody(extra: Record<string, unknown> = {}) {
  return {
    ...peerHello(),
    vaultId: PEER_VAULT,
    vaultPublicKey: peerPublicKey,
    relayHints: ["r9"],
    label: "Priya",
    ...extra,
  };
}

describe("peer plane identity", () => {
  it("ignores paths outside the plane rather than claiming them", async () => {
    const result = await call(makeHandler(openStore()), {
      method: "GET",
      url: "/centraid/_gateway/devices",
    });
    expect(result.handled).toBe(false);
  });

  /* TRAP 1, route half. */
  it.each([
    "/centraid/_peer/../_gateway/devices",
    "/centraid/_peer/%2e%2e/_gateway/devices",
    "/centraid/_peer/",
  ])("refuses %s as not_found", async (url) => {
    const result = await call(makeHandler(openStore()), {
      method: "GET",
      url,
    });
    expect(result.status).toBe(404);
    expect(result.json).toStrictEqual({ state: "not_found" });
  });

  /* TRAP 2, route half: a device identity is never a peer identity. */
  it("refuses a request carrying a device identity instead of a peer proof", async () => {
    const result = await call(makeHandler(openStore()), {
      method: "GET",
      url: "/centraid/_peer/link/hello",
      headers: {
        [PEER_PROOF_HEADER]: "",
        [DEVICE_IDENTITY_HEADER]: "some-device",
      },
    });
    expect(result.status).toBe(404);
    expect(result.json).toStrictEqual({ state: "not_found" });
  });

  it("refuses a forged proof", async () => {
    const result = await call(makeHandler(openStore()), {
      method: "GET",
      url: "/centraid/_peer/link/hello",
      headers: { [PEER_PROOF_HEADER]: "b".repeat(64) },
    });
    expect(result.status).toBe(404);
  });

  it("answers the handshake probe without naming anything local", async () => {
    const result = await call(makeHandler(openStore()), {
      method: "GET",
      url: "/centraid/_peer/link/hello",
    });
    expect(result.status).toBe(200);
    expect(result.json).toStrictEqual({ state: "ready", ...peerHello() });
  });

  it("meters a link and refuses the overspend as a state", async () => {
    const handler = makePeerPlaneHandler({
      links: openStore(),
      peerProof: PROOF,
      vaultPublicKey: () => undefined,
      localRoute: () => ({ relayHints: [] }),
      localLabel: () => "Home",
      budget: createTokenBucket({ capacity: 1, refillPerSecond: 1 }),
    });
    const first = await call(handler, {
      method: "GET",
      url: "/centraid/_peer/link/hello",
    });
    expect(first.status).toBe(200);
    const second = await call(handler, {
      method: "GET",
      url: "/centraid/_peer/link/hello",
    });
    expect(second.status).toBe(429);
    expect(second.json).toStrictEqual({ state: "rate_limited" });
  });

  it("refuses an unknown peer-plane route as not_found", async () => {
    const result = await call(makeHandler(openStore()), {
      method: "GET",
      url: "/centraid/_peer/blobs/deadbeef",
    });
    expect(result.status).toBe(404);
    expect(result.json).toStrictEqual({ state: "not_found" });
  });
});

describe("link ceremony", () => {
  it("links both sides once and refuses the replay", async () => {
    const links = openStore();
    const handler = makeHandler(links);
    const ticket = links.tickets.mint(LOCAL_VAULT, LOCAL_KEY);
    const first = await call(handler, {
      method: "POST",
      url: "/centraid/_peer/link/redeem",
      body: redeemBody({ ticketId: ticket.ticketId, secret: ticket.secret }),
    });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({
      state: "linked",
      vaultId: LOCAL_VAULT,
      vaultPublicKey: "bG9jYWwtcHVibGljLWtleQ==",
      endpointId: "endpoint-local",
      relayHints: ["r1"],
      label: "Home",
      ...peerHello(),
    });
    const link = links.peerForEndpoint(PEER_ENDPOINT);
    expect(link).toMatchObject({
      localVaultId: LOCAL_VAULT,
      peerVaultId: PEER_VAULT,
      peerPublicKey,
      peerLabel: "Priya",
      route: { relayHints: ["r9"] },
    });

    const replay = await call(handler, {
      method: "POST",
      url: "/centraid/_peer/link/redeem",
      body: redeemBody({ ticketId: ticket.ticketId, secret: ticket.secret }),
    });
    expect(replay.status).toBe(404);
    expect(replay.json).toStrictEqual({ state: "not_found" });
  });

  it("tells a wrong secret, an unknown ticket, and an expired one apart from nothing", async () => {
    const links = openStore();
    const handler = makeHandler(links);
    const ticket = links.tickets.mint(LOCAL_VAULT, LOCAL_KEY);
    const expired = links.tickets.mint(LOCAL_VAULT, LOCAL_KEY, -1);
    const attempts = await Promise.all(
      [
        { ticketId: ticket.ticketId, secret: "wrong" },
        { ticketId: "no-such-ticket", secret: ticket.secret },
        { ticketId: expired.ticketId, secret: expired.secret },
      ].map((attempt) =>
        call(handler, {
          method: "POST",
          url: "/centraid/_peer/link/redeem",
          body: redeemBody(attempt),
        })
      )
    );
    for (const result of attempts) {
      expect(result.status).toBe(404);
      expect(result.json).toStrictEqual({ state: "not_found" });
    }
    // The live ticket survived every failed attempt.
    expect(links.tickets.hasPending()).toBe(true);
  });

  it("refuses a version-mismatched peer as a state, without burning the ticket", async () => {
    const links = openStore();
    const handler = makeHandler(links);
    const ticket = links.tickets.mint(LOCAL_VAULT, LOCAL_KEY);
    const result = await call(handler, {
      method: "POST",
      url: "/centraid/_peer/link/redeem",
      body: redeemBody({
        ticketId: ticket.ticketId,
        secret: ticket.secret,
        peerProtocolVersion: peerHello().peerProtocolVersion + 9,
        minPeerProtocol: peerHello().peerProtocolVersion + 9,
      }),
    });
    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({ state: "protocol_refused" });
    expect(links.tickets.hasPending()).toBe(true);
    expect(links.linkForEndpoint(PEER_ENDPOINT)).toBeUndefined();
  });

  it("refuses a body that names an endpoint other than the proved one", async () => {
    const links = openStore();
    const handler = makeHandler(links);
    const ticket = links.tickets.mint(LOCAL_VAULT, LOCAL_KEY);
    const result = await call(handler, {
      method: "POST",
      url: "/centraid/_peer/link/redeem",
      body: redeemBody({
        ticketId: ticket.ticketId,
        secret: ticket.secret,
        endpointId: "somebody-else",
      }),
    });
    expect(result.status).toBe(400);
    expect(result.json).toStrictEqual({ state: "bad_request" });
  });

  it("maps a malformed body to a state, never an exception", async () => {
    const links = openStore();
    const handler = makeHandler(links);
    const result = await call(handler, {
      method: "POST",
      url: "/centraid/_peer/link/redeem",
      body: { ...peerHello() },
    });
    expect(result.status).toBe(400);
    expect(result.json).toStrictEqual({ state: "bad_request" });
  });
});

describe("route assertion", () => {
  const link = (links: VaultLinksStore) => {
    const ticket = links.tickets.mint(LOCAL_VAULT, LOCAL_KEY);
    links.redeem({
      ticketId: ticket.ticketId,
      secret: ticket.secret,
      peerVaultId: PEER_VAULT,
      peerPublicKey,
      route: { endpointId: "endpoint-old", relayHints: [], assertedAt: 1 },
      peerLabel: "Priya",
      localLabel: "Home",
    });
  };

  const assertion = (seed: Buffer, ts: number) => {
    const claim = {
      vaultId: PEER_VAULT,
      endpointId: PEER_ENDPOINT,
      relayHints: ["r-new"],
      ts,
    };
    return {
      ...claim,
      signature: signWithVaultIdentity(
        seed,
        routeAssertionBytes(claim)
      ).toString("base64"),
    };
  };

  it("moves the route cache for a peer that rotated its endpoint", async () => {
    const links = openStore();
    link(links);
    // The ceremony seeds the route clock, so only an assertion made AFTER the
    // link was formed can move it — a replayed older one never wins.
    const result = await call(makeHandler(links), {
      method: "POST",
      url: "/centraid/_peer/route/assert",
      body: assertion(peerSeed, Date.now() + 1000),
    });
    expect(result.status).toBe(200);
    expect(result.json).toStrictEqual({ state: "accepted" });
    expect(links.peerForEndpoint(PEER_ENDPOINT)?.peerVaultId).toBe(PEER_VAULT);
    expect(links.linkForEndpoint("endpoint-old")).toBeUndefined();
  });

  it("refuses an assertion signed with the wrong key and leaves the route put", async () => {
    const links = openStore();
    link(links);
    const result = await call(makeHandler(links), {
      method: "POST",
      url: "/centraid/_peer/route/assert",
      body: assertion(crypto.randomBytes(32), Date.now() + 1000),
    });
    expect(result.status).toBe(403);
    expect(result.json).toStrictEqual({ state: "bad_signature" });
    expect(links.linkForEndpoint("endpoint-old")).toBeTruthy();
    expect(links.linkForEndpoint(PEER_ENDPOINT)).toBeUndefined();
  });

  it("hides vaults it has no link to", async () => {
    const result = await call(makeHandler(openStore()), {
      method: "POST",
      url: "/centraid/_peer/route/assert",
      body: assertion(peerSeed, Date.now()),
    });
    expect(result.status).toBe(404);
    expect(result.json).toStrictEqual({ state: "not_found" });
  });

  it("refuses an assertion whose endpoint is not the caller", async () => {
    const links = openStore();
    link(links);
    const signed = assertion(peerSeed, Date.now());
    const result = await call(makeHandler(links), {
      method: "POST",
      url: "/centraid/_peer/route/assert",
      body: { ...signed, endpointId: "third-party" },
    });
    expect(result.status).toBe(400);
    expect(result.json).toStrictEqual({ state: "bad_request" });
  });

  it("verifies a stale assertion but does not let it win", async () => {
    const links = openStore();
    link(links);
    const handler = makeHandler(links);
    const now = Date.now() + 1000;
    await call(handler, {
      method: "POST",
      url: "/centraid/_peer/route/assert",
      body: assertion(peerSeed, now),
    });
    const stale = await call(handler, {
      method: "POST",
      url: "/centraid/_peer/route/assert",
      body: assertion(peerSeed, now - 1),
    });
    expect(stale.status).toBe(200);
    expect(stale.json).toStrictEqual({ state: "stale" });
  });
});
