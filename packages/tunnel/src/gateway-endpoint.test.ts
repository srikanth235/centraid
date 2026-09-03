import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTunnelClient, tunnelRequest } from "./client.js";
import type { TunnelClient } from "./client.js";
import { startGatewayEndpoint } from "./gateway-endpoint.js";
import type {
  GatewayEndpointHandle,
  GatewayPairResponse,
} from "./gateway-endpoint.js";
import {
  TUNNEL_AUTH_MODE_HEADER,
  TUNNEL_AUTH_WEB_SESSION,
} from "./protocol.js";

const TOKEN = crypto.randomBytes(16).toString("hex");
const PROOF = crypto.randomBytes(16).toString("hex");

interface SeenRequest {
  url: string;
  device?: string;
  proof?: string;
  peerVault?: string;
  authorization?: string;
  cookie?: string;
  tunnelAuthMode?: string;
}

function startFakeGateway(
  seen: SeenRequest[]
): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer((req, res) => {
    if (
      (req.headers.authorization ?? "") !== `Bearer ${TOKEN}` &&
      req.headers.cookie !== "__centraid_app=test-session"
    ) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    seen.push({
      url: req.url ?? "",
      ...(typeof req.headers.authorization === "string"
        ? { authorization: req.headers.authorization }
        : {}),
      ...(typeof req.headers.cookie === "string"
        ? { cookie: req.headers.cookie }
        : {}),
      ...(typeof req.headers[TUNNEL_AUTH_MODE_HEADER] === "string"
        ? { tunnelAuthMode: req.headers[TUNNEL_AUTH_MODE_HEADER] }
        : {}),
      ...(typeof req.headers["x-centraid-device"] === "string"
        ? { device: req.headers["x-centraid-device"] }
        : {}),
      ...(typeof req.headers["x-centraid-device-proof"] === "string"
        ? { proof: req.headers["x-centraid-device-proof"] }
        : {}),
      ...(typeof req.headers["x-centraid-peer-vault"] === "string"
        ? { peerVault: req.headers["x-centraid-peer-vault"] }
        : {}),
    });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe("gateway endpoint", () => {
  const seen: SeenRequest[] = [];
  const enrolled = new Set<string>();
  const tickets = new Map<
    string,
    {
      secret: string;
      vaultId: string;
      vaultIds?: string[];
      vaults?: GatewayPairResponse["vaults"];
    }
  >();
  let gateway: { server: http.Server; baseUrl: string };
  let endpoint: GatewayEndpointHandle;
  let device: TunnelClient;

  beforeAll(async () => {
    gateway = await startFakeGateway(seen);
    endpoint = await startGatewayEndpoint({
      upstream: () => ({ baseUrl: gateway.baseUrl, token: TOKEN }),
      authorize: (endpointId) => enrolled.has(endpointId),
      pair: (request, endpointId): GatewayPairResponse => {
        const ticket = tickets.get(request.ticketId);
        if (!ticket || ticket.secret !== request.secret) {
          return { ok: false, error: "invalid_ticket" };
        }
        tickets.delete(request.ticketId);
        enrolled.add(endpointId);
        return {
          ok: true,
          gatewayId: "gateway-endpoint",
          gatewayName: "test-vps",
          vaultId: ticket.vaultId,
          vaultName: "Family",
          ...(ticket.vaultIds ? { vaultIds: ticket.vaultIds } : {}),
          ...(ticket.vaults ? { vaults: ticket.vaults } : {}),
          version: "0.1.0",
          protocolVersion: 2,
        };
      },
      requestHeaders: (endpointId) => ({
        "x-centraid-device": endpointId,
        "x-centraid-device-proof": PROOF,
      }),
      relays: "disabled",
    });
    device = await createTunnelClient({ relays: "disabled" });
  });

  afterAll(async () => {
    await device.close();
    await endpoint.close();
    gateway.server.close();
  });

  it("refuses tunnel connections from unenrolled device keys", async () => {
    const connection = await device.connect(endpoint.ticket());
    await expect(async () => {
      await tunnelRequest(connection, {
        method: "GET",
        target: "/centraid/_apps",
      });
      await connection.closed();
      await tunnelRequest(connection, {
        method: "GET",
        target: "/centraid/_apps",
      });
    }).rejects.toThrow(/reason: b"unauthorized"/u);
  });

  it("redeems a ticket exactly once and answers the handshake material", async () => {
    tickets.set("t1", {
      secret: "s3cret",
      vaultId: "v-family",
      vaultIds: ["v-family", "v-shared"],
      vaults: [
        {
          enrollmentId: "enrollment-family",
          vaultId: "v-family",
          vaultName: "Family",
        },
        {
          enrollmentId: "enrollment-shared",
          vaultId: "v-shared",
          vaultName: "Shared",
        },
      ],
    });

    const wrong = await device.pairGateway(endpoint.ticket(), {
      ticketId: "t1",
      secret: "guess",
      deviceName: "Mallory",
      platform: "test",
    });
    expect(wrong.ok).toBe(false);

    const ok = await device.pairGateway(endpoint.ticket(), {
      ticketId: "t1",
      secret: "s3cret",
      deviceName: "Priya laptop",
      platform: "test",
    });
    expect(ok).toMatchObject({
      ok: true,
      gatewayId: "gateway-endpoint",
      vaultId: "v-family",
      vaultName: "Family",
      vaultIds: ["v-family", "v-shared"],
      vaults: [
        {
          enrollmentId: "enrollment-family",
          vaultId: "v-family",
          vaultName: "Family",
        },
        {
          enrollmentId: "enrollment-shared",
          vaultId: "v-shared",
          vaultName: "Shared",
        },
      ],
      version: "0.1.0",
      protocolVersion: 2,
    });
    expect(enrolled.has(device.endpointId)).toBe(true);

    const replay = await device.pairGateway(endpoint.ticket(), {
      ticketId: "t1",
      secret: "s3cret",
      deviceName: "Replay",
      platform: "test",
    });
    expect(replay.ok).toBe(false);
  });

  it("stamps the QUIC-proved device identity and strips spoofed copies", async () => {
    const connection = await device.connect(endpoint.ticket());
    seen.length = 0;
    const res = await tunnelRequest(connection, {
      method: "GET",
      target: "/centraid/_apps",
      headers: {
        "x-centraid-device": "someone-else",
        "x-centraid-device-proof": "forged",
        "x-centraid-peer-endpoint": "ep-forged-peer",
        "x-centraid-peer-vault": "v-forged-peer-vault",
        "x-centraid-peer-proof": "f".repeat(64),
      },
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      url: "/centraid/_apps",
      device: device.endpointId,
      proof: PROOF,
    });
    expect(seen[0]?.peerVault).toBeUndefined();
  });

  it("defers generated-app auth to its scoped web session and strips the mode marker", async () => {
    const connection = await device.connect(endpoint.ticket());
    seen.length = 0;
    const res = await tunnelRequest(connection, {
      method: "GET",
      target: "/centraid/todos/",
      headers: {
        cookie: "__centraid_app=test-session",
        [TUNNEL_AUTH_MODE_HEADER]: TUNNEL_AUTH_WEB_SESSION,
      },
    });
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({
      cookie: "__centraid_app=test-session",
      device: device.endpointId,
    });
    expect(seen[0]?.authorization).toBeUndefined();
    expect(seen[0]?.tunnelAuthMode).toBeUndefined();
  });

  it("revocation lands on live connections", async () => {
    const connection = await device.connect(endpoint.ticket());
    const before = await tunnelRequest(connection, {
      method: "GET",
      target: "/centraid/_apps",
    });
    expect(before.status).toBe(200);

    enrolled.delete(device.endpointId);
    await expect(async () => {
      await tunnelRequest(connection, {
        method: "GET",
        target: "/centraid/_apps",
      });
      await connection.closed();
      await tunnelRequest(connection, {
        method: "GET",
        target: "/centraid/_apps",
      });
    }).rejects.toThrow(/reason: b"revoked"/u);
    enrolled.add(device.endpointId);
  });
});

describe("forwarder owned-header parity", () => {
  const rust = fs.readFileSync(
    fileURLToPath(new URL("../data-plane/src/iroh_wire.rs", import.meta.url)),
    "utf8"
  );
  const ts = fs.readFileSync(
    fileURLToPath(new URL("gateway-endpoint.ts", import.meta.url)),
    "utf8"
  );

  it("strips every header the Rust relay owns, and vice versa", () => {
    const rustNames =
      /FORWARDER_OWNED_HEADERS: \[&str; \d+\] = \[(?<body>[^\]]+)\]/u
        .exec(rust)
        ?.groups?.body?.matchAll(/(?<name>[A-Z_]+)/gu) ?? [];
    const declared = [...rustNames].map((match) => match.groups!.name!);
    expect(declared).toStrictEqual([
      "DEVICE_IDENTITY_HEADER",
      "DEVICE_PROOF_HEADER",
      "PEER_ENDPOINT_HEADER",
      "PEER_VAULT_HEADER",
      "PEER_PROOF_HEADER",
    ]);

    const stripList = /IDENTITY_HEADER_NAMES[^=]*= \[(?<body>[^\]]+)\]/u.exec(
      ts
    )?.groups?.body;
    expect(stripList).toBeDefined();
    for (const name of declared) expect(stripList).toContain(name);
  });
});
