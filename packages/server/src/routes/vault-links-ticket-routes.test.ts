import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

import { describe, afterEach, expect, test } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { PEER_ENDPOINT_HEADER, PEER_PROOF_HEADER } from "@centraid/tunnel";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import type { PeerDial, PeerRequest } from "../serve/peer-link-client.js";
import { VaultLinksStore } from "../serve/vault-links-store.js";
import { makePeerPlaneHandler } from "./peer-plane.js";
import { makeVaultLinksRouteHandler } from "./vault-links-routes.js";

const servers: http.Server[] = [];
const databases: GatewayDatabase[] = [];
const dirs: string[] = [];

describe("vault-links-routes: remote ticket/redeem (#726 audit finding 1)", () => {
  afterEach(async () => {
    for (const server of servers.splice(0)) server.close();
    for (const database of databases.splice(0)) database.close();
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  interface TicketGateway {
    base: string;
    store: VaultLinksStore;
    vaultId: string;
    deviceKey: string;
    publicKey: string;
    endpointId: string;
    proof: string;
  }

  function transportTo(
    gw: TicketGateway,
    callerEndpointId: string
  ): PeerRequest {
    const handler = makePeerPlaneHandler({
      links: gw.store,
      peerProof: gw.proof,
      vaultPublicKey: (vaultId) =>
        vaultId === gw.vaultId ? gw.publicKey : undefined,
      localRoute: () => ({ endpointId: gw.endpointId, relayHints: [] }),
      localLabel: () => gw.vaultId,
    });
    return async (input) => {
      let status = 0;
      let body = "";
      const req = Readable.from([
        Buffer.from(JSON.stringify(input.body ?? {})),
      ]) as IncomingMessage;
      req.method = input.method;
      req.url = input.target;
      req.headers = {
        [PEER_ENDPOINT_HEADER]: callerEndpointId,
        [PEER_PROOF_HEADER]: gw.proof,
      };
      const res = {
        setHeader: () => undefined,
        end(value?: string | Buffer) {
          if (value) body += value.toString();
        },
        get statusCode() {
          return status;
        },
        set statusCode(value: number) {
          status = value;
        },
      } as unknown as ServerResponse;
      await handler(req, res);
      return { status, json: body ? (JSON.parse(body) as unknown) : undefined };
    };
  }

  function dialTo(peer: TicketGateway, ownEndpointId: string): PeerDial {
    return {
      request: transportTo(peer, ownEndpointId),
      endpointTicketFor: (endpointId) => `ticket-for-${endpointId}`,
    };
  }

  async function setupTicketGateway(
    name: string,
    vaultId: string,
    dial?: PeerDial
  ): Promise<TicketGateway> {
    const dir = await tempDir(`vault-links-routes-ticket-${name}-`);
    dirs.push(dir);
    const database = GatewayDatabase.open(dir);
    databases.push(database);
    const enrollments = EnrollmentStore.open(database);
    const store = new VaultLinksStore(database);
    const deviceKey = `${name}-device`;
    enrollments.enroll({
      endpointId: deviceKey,
      vaultIds: [vaultId],
      label: `${name} device`,
      ownerLabel: name,
    });
    const gw: TicketGateway = {
      base: "",
      store,
      vaultId,
      deviceKey,
      publicKey: `key-${vaultId}`,
      endpointId: `ep-${name}`,
      proof: crypto.randomBytes(16).toString("hex"),
    };
    const handler = makeVaultLinksRouteHandler({
      enrollments,
      store,
      gatewayDatabase: database,
      vaultPublicKey: (id) => (id === vaultId ? gw.publicKey : undefined),
      vaultName: () => name,
      ...(dial
        ? {
            peer: {
              localRoute: () => ({ endpointId: gw.endpointId, relayHints: [] }),
              dial,
            },
          }
        : {}),
    });
    const server = http.createServer((req, res) => {
      void handler(req, res);
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    gw.base = `http://127.0.0.1:${port}/centraid/_gateway/links`;
    return gw;
  }

  test("minting requires ownership, refused not_found for a vault you do not own", async () => {
    const priya = await setupTicketGateway("priya", "vault-priya", dummyDial());
    const response = await fetch(`${priya.base}/ticket`, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: priya.deviceKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ vaultId: "vault-someone-else" }),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "not_found",
    });
  });

  test("minting with no wired peer transport is refused typed, never a ticket that could not be redeemed", async () => {
    const priya = await setupTicketGateway("priya", "vault-priya"); // no dial
    const response = await fetch(`${priya.base}/ticket`, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: priya.deviceKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ vaultId: "vault-priya" }),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "peer_plane_unavailable",
    });
  });

  test("redeeming with no wired peer transport is refused the SAME typed capability refusal as minting (#726 re-audit)", async () => {
    const raj = await setupTicketGateway("raj", "vault-raj"); // no dial
    const response = await fetch(`${raj.base}/redeem`, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: raj.deviceKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        vaultId: "vault-raj",
        ticket: JSON.stringify({
          v: 1,
          kind: "centraid-link",
          vaultId: "vault-x",
          vaultPublicKey: "key-x",
          endpointTicket: "irrelevant",
          ticketId: "t",
          secret: "s",
        }),
      }),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "peer_plane_unavailable",
    });
  });

  test("redeeming when the peer plane IS wired but the dial itself fails answers the network fact, not the capability refusal", async () => {
    const raj = await setupTicketGateway("raj", "vault-raj", {
      request: () => Promise.reject(new Error("simulated network drop")),
      endpointTicketFor: (id) => `ticket-for-${id}`,
    });
    const response = await fetch(`${raj.base}/redeem`, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: raj.deviceKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        vaultId: "vault-raj",
        ticket: JSON.stringify({
          v: 1,
          kind: "centraid-link",
          vaultId: "vault-x",
          vaultPublicKey: "key-x",
          endpointTicket: "irrelevant",
          ticketId: "t",
          secret: "s",
        }),
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { state: string; error?: string };
    expect(body.state).toBe("unreachable");
    expect(body.error).toBeUndefined();
  });

  test("the full remote ceremony: mint on one gateway, redeem on another, links both sides", async () => {
    const priya = await setupTicketGateway("priya", "vault-priya", dummyDial());
    const raj = await setupTicketGateway(
      "raj",
      "vault-raj",
      dialTo(priya, "ep-raj")
    );

    const minted = await fetch(`${priya.base}/ticket`, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: priya.deviceKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ vaultId: "vault-priya" }),
    });
    expect(minted.status).toBe(201);
    const { ticket } = (await minted.json()) as { ticket: string };

    const redeemed = await fetch(`${raj.base}/redeem`, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: raj.deviceKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ vaultId: "vault-raj", ticket }),
    });
    expect(redeemed.status).toBe(201);
    const redeemedBody = (await redeemed.json()) as {
      state: string;
      link: { vaultA: string; vaultB: string; approved: boolean };
    };
    expect(redeemedBody.state).toBe("linked");
    expect(redeemedBody.link.approved).toBe(true);
    expect(
      [redeemedBody.link.vaultA, redeemedBody.link.vaultB].sort()
    ).toStrictEqual(["vault-priya", "vault-raj"].sort());

    expect(priya.store.peerForVault("vault-raj", "vault-priya")).toMatchObject({
      peerVaultId: "vault-raj",
    });

    const second = await fetch(`${raj.base}/redeem`, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: raj.deviceKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ vaultId: "vault-raj", ticket }),
    });
    expect(second.status).toBe(404);
    await expect(second.json()).resolves.toMatchObject({ state: "not_found" });
  });

  test("redeeming a garbled ticket is refused typed, never an exception", async () => {
    const raj = await setupTicketGateway("raj", "vault-raj", dummyDial());
    const response = await fetch(`${raj.base}/redeem`, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: raj.deviceKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ vaultId: "vault-raj", ticket: "not a ticket" }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_ticket",
    });
  });

  test("redeeming for a vault you do not own is refused not_found (topology hiding), before any dial", async () => {
    const raj = await setupTicketGateway("raj", "vault-raj", {
      request: () => {
        throw new Error("must not dial for an unowned vault");
      },
      endpointTicketFor: (id) => `ticket-for-${id}`,
    });
    const response = await fetch(`${raj.base}/redeem`, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: raj.deviceKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        vaultId: "vault-not-mine",
        ticket: JSON.stringify({
          v: 1,
          kind: "centraid-link",
          vaultId: "vault-x",
          vaultPublicKey: "key-x",
          endpointTicket: "irrelevant",
          ticketId: "t",
          secret: "s",
        }),
      }),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "not_found",
    });
  });

  function dummyDial(): PeerDial {
    return {
      request: () => Promise.reject(new Error("not used by this test")),
      endpointTicketFor: (id) => `ticket-for-${id}`,
    };
  }
});
