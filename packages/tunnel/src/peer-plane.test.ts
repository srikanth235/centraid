import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createTunnelClient, tunnelRequest } from "./client.js";
import type { TunnelClient } from "./client.js";
import { startGatewayEndpoint } from "./gateway-endpoint.js";
import type { GatewayEndpointHandle } from "./gateway-endpoint.js";
import { createTokenBucket } from "./peer-budget.js";
import {
  DEVICE_IDENTITY_HEADER,
  DEVICE_PROOF_HEADER,
  isPeerPlaneTarget,
  PEER_ENDPOINT_HEADER,
  PEER_PROOF_HEADER,
} from "./protocol.js";

vi.setConfig({ testTimeout: 30_000 });

const TOKEN = crypto.randomBytes(16).toString("hex");
const PEER_PROOF = "peer-proof-secret";
const DEVICE_PROOF = "device-proof-secret";

function startEchoUpstream(): Promise<{
  server: http.Server;
  baseUrl: string;
}> {
  const server = http.createServer((req, res) => {
    if ((req.headers.authorization ?? "") !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ path: req.url, headers: req.headers }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

interface EchoBody {
  path: string;
  headers: Record<string, string>;
}

describe("peer plane over iroh", () => {
  let upstream: { server: http.Server; baseUrl: string };
  let gateway: GatewayEndpointHandle;
  let linkedPeer: TunnelClient;
  let strangerPeer: TunnelClient;
  const links = new Set<string>();

  beforeAll(async () => {
    upstream = await startEchoUpstream();
    linkedPeer = await createTunnelClient({ relays: "disabled" });
    strangerPeer = await createTunnelClient({ relays: "disabled" });
    links.add(linkedPeer.endpointId);
    gateway = await startGatewayEndpoint({
      upstream: () => ({ baseUrl: upstream.baseUrl, token: TOKEN }),
      authorize: () => false,
      requestHeaders: (endpointId) => ({
        [DEVICE_IDENTITY_HEADER]: endpointId,
        [DEVICE_PROOF_HEADER]: DEVICE_PROOF,
      }),
      pair: () => ({ ok: false, error: "not_supported" }),
      authorizePeer: (endpointId) => links.has(endpointId),
      peerRequestHeaders: (endpointId) => ({
        [PEER_ENDPOINT_HEADER]: endpointId,
        [PEER_PROOF_HEADER]: PEER_PROOF,
      }),
      relays: "disabled",
    });
  });

  afterAll(async () => {
    await linkedPeer.close();
    await strangerPeer.close();
    await gateway.close();
    upstream.server.close();
  });

  const call = async (target: string, headers?: Record<string, string>) => {
    const connection = await linkedPeer.connectPeer(gateway.ticket());
    try {
      return await tunnelRequest(connection, {
        method: "GET",
        target,
        ...(headers ? { headers } : {}),
      });
    } finally {
      connection.close(0n, []);
    }
  };

  it("forwards a peer-plane target and stamps the peer identity", async () => {
    const response = await call("/centraid/_peer/link/hello");
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body.toString("utf8")) as EchoBody;
    expect(body.path).toBe("/centraid/_peer/link/hello");
    expect(body.headers[PEER_ENDPOINT_HEADER]).toBe(linkedPeer.endpointId);
    expect(body.headers[PEER_PROOF_HEADER]).toBe(PEER_PROOF);
  });

  it("never lets a peer arrive wearing a device identity", async () => {
    const response = await call("/centraid/_peer/link/hello", {
      [DEVICE_IDENTITY_HEADER]: "forged-device",
      [DEVICE_PROOF_HEADER]: DEVICE_PROOF,
    });
    const body = JSON.parse(response.body.toString("utf8")) as EchoBody;
    expect(body.headers[DEVICE_IDENTITY_HEADER]).toBeUndefined();
    expect(body.headers[DEVICE_PROOF_HEADER]).toBeUndefined();
  });

  it("never lets a peer forge its own peer identity", async () => {
    const response = await call("/centraid/_peer/link/hello", {
      [PEER_ENDPOINT_HEADER]: "forged-peer",
      [PEER_PROOF_HEADER]: "forged-proof",
    });
    const body = JSON.parse(response.body.toString("utf8")) as EchoBody;
    expect(body.headers[PEER_ENDPOINT_HEADER]).toBe(linkedPeer.endpointId);
    expect(body.headers[PEER_PROOF_HEADER]).toBe(PEER_PROOF);
  });

  it.each([
    "/centraid/_gateway/tunnel/authorize",
    "/centraid/_gateway/devices",
    "/centraid/_vault/blobs",
    "/centraid/_peer/../_gateway/devices",
    "/centraid/_peer/%2e%2e/_gateway/devices",
    "/centraid/_peer/",
    "/centraid/notes/",
  ])("refuses %s as a state, never as a fault", async (target) => {
    const response = await call(target);
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body.toString("utf8"))).toStrictEqual({
      state: "not_found",
    });
  });

  it("refuses an unlinked peer without telling it why", async () => {
    const connection = await strangerPeer.connectPeer(gateway.ticket());
    await expect(async () => {
      await tunnelRequest(connection, {
        method: "GET",
        target: "/centraid/_peer/link/hello",
      });
      await connection.closed();
      await tunnelRequest(connection, {
        method: "GET",
        target: "/centraid/_peer/link/hello",
      });
    }).rejects.toThrow(Error);
  });
});

describe("peer plane path confinement", () => {
  it.each([
    "/centraid/_peer/link/redeem",
    "/centraid/_peer/blobs/a1b2c3?range=0-1023",
    "/centraid/_peer/route/assert",
    "/centraid/_peer/x#frag",
  ])("admits %s", (target) => {
    expect(isPeerPlaneTarget(target)).toBe(true);
  });

  it.each([
    "/centraid/_gateway/tunnel/authorize",
    "/centraid/_vault/blobs",
    "/centraid/_peer",
    "/centraid/_peer/",
    "/centraid/_peerish/x",
    "/centraid/_peer/../_gateway/devices",
    "/centraid/_peer/./../_gateway",
    "/centraid/_peer/%2e%2e/_gateway",
    "/centraid/_peer/a%2f..%2fb",
    "/centraid/_peer/a\\..\\b",
    "/centraid/_peer/a b",
    "//centraid/_peer/x",
    "",
  ])("refuses %s", (target) => {
    expect(isPeerPlaneTarget(target)).toBe(false);
  });

  it("refuses a non-string target", () => {
    expect(isPeerPlaneTarget(undefined)).toBe(false);
    expect(isPeerPlaneTarget(42)).toBe(false);
    expect(isPeerPlaneTarget({ toString: () => "/centraid/_peer/x" })).toBe(
      false
    );
  });
});

describe("per-link budget", () => {
  it("spends, refuses, and refills on elapsed time", () => {
    let now = 1_000;
    const bucket = createTokenBucket({
      capacity: 2,
      refillPerSecond: 1,
      now: () => now,
    });
    expect(bucket.take("peer-a")).toBe(true);
    expect(bucket.take("peer-a")).toBe(true);
    expect(bucket.take("peer-a")).toBe(false);
    expect(bucket.retryAfterMs("peer-a")).toBe(1000);
    expect(bucket.take("peer-b")).toBe(true);
    now += 1000;
    expect(bucket.take("peer-a")).toBe(true);
    expect(bucket.take("peer-a")).toBe(false);
  });

  it("never grants more than the burst after a long idle", () => {
    let now = 0;
    const bucket = createTokenBucket({
      capacity: 3,
      refillPerSecond: 10,
      now: () => now,
    });
    now += 3_600_000;
    expect(bucket.take("peer", 3)).toBe(true);
    expect(bucket.take("peer")).toBe(false);
  });

  it("forgets a revoked link's state", () => {
    const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 1 });
    expect(bucket.take("gone")).toBe(true);
    expect(bucket.size()).toBe(1);
    bucket.forget("gone");
    expect(bucket.size()).toBe(0);
  });

  it("refuses a nonsensical budget rather than metering nothing", () => {
    expect(() =>
      createTokenBucket({ capacity: 0, refillPerSecond: 1 })
    ).toThrow(/positive/u);
    expect(() =>
      createTokenBucket({ capacity: 1, refillPerSecond: 0 })
    ).toThrow(/positive/u);
  });
});
