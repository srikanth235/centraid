/*
 * The peer lane where it meets the composed handler (#726).
 *
 * `mountUnauthed` is the honest model of the hole this file closes: the
 * gateway's own bearer is checked ABOVE the composed handler, and every
 * forwarder — the peer one included — carries that bearer on the requests it
 * delivers. So a peer that escapes path confinement arrives already past the
 * bearer, on loopback, where the embedded device resolver would otherwise
 * hand it the HOST's device key. A peer must never satisfy an owner-tier
 * check by ANY route.
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

import { describe, afterEach, beforeEach, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  PEER_ENDPOINT_HEADER,
  PEER_PROOF_HEADER,
  PEER_VAULT_HEADER,
} from "@centraid/tunnel";

import { isDirectHostRequest } from "../routes/route-helpers.js";
import { buildGateway } from "./build-gateway.js";
import type { BuiltGateway } from "./build-gateway.js";

const PEER_PROOF = "p".repeat(64);

let dataDir: string;
let gateway: BuiltGateway;
let server: http.Server;
let base: string;

async function mount(): Promise<void> {
  server = http.createServer((req, res) => {
    void gateway.composedHandler(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;
}

const asPeer = (endpointId = "ep-peer"): Record<string, string> => ({
  [PEER_ENDPOINT_HEADER]: endpointId,
  [PEER_PROOF_HEADER]: PEER_PROOF,
});

describe("peer lane at the composed handler", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`build-gateway-peer-${crypto.randomUUID()}-`);
    gateway = await buildGateway({
      paths: { vaultDir: path.join(dataDir, "vault") },
      peerPlane: {
        proof: PEER_PROOF,
        localRoute: () => ({ endpointId: "ep-local", relayHints: [] }),
      },
    });
    await mount();
  }, 30_000);

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await gateway.stop().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  }, 30_000);

  test("the plane is reachable, and says nothing about vaults or owners", async () => {
    const response = await fetch(`${base}/centraid/_peer/link/hello`, {
      headers: asPeer(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.state).toBe("ready");
    expect(Object.keys(body)).not.toContain("vaultId");
  });

  test("an owner-tier route refuses a peer-marked request", async () => {
    // Same request without the peer marking is served: the refusal below is
    // the marking, not a broken harness.
    expect((await fetch(`${base}/centraid/_apps`)).status).toBe(200);
    const asPeerRequest = await fetch(`${base}/centraid/_apps`, {
      headers: asPeer(),
    });
    expect(asPeerRequest.status).toBe(404);
    await expect(asPeerRequest.json()).resolves.toStrictEqual({
      state: "not_found",
    });
  });

  /* (#865 F9) The backstop used to judge only the endpoint header; the Rust
   * relay's forwarder-owned set carries a peer-vault name too, so each of
   * them alone must be enough to refuse. */
  test.each([
    { [PEER_ENDPOINT_HEADER]: "ep-peer" },
    { [PEER_PROOF_HEADER]: PEER_PROOF },
    { [PEER_VAULT_HEADER]: "vlt_peer" },
  ])(
    "any single peer identity header triggers the backstop",
    async (headers) => {
      const response = await fetch(`${base}/centraid/_apps`, { headers });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toStrictEqual({
        state: "not_found",
      });
    }
  );

  test("the gateway control lanes refuse a peer-marked request too", async () => {
    await Promise.all(
      [
        "/centraid/_gateway/info",
        "/centraid/_gateway/tunnel/authorize?endpointId=ep-peer",
        "/centraid/_gateway/devices/ticket",
        "/centraid/_gateway/links",
      ].map(async (target) => {
        const response = await fetch(`${base}${target}`, { headers: asPeer() });
        expect([target, response.status]).toStrictEqual([target, 404]);
      })
    );
  });

  test("a `..` escape lands on the peer handler's confinement, not the owner route", async () => {
    // The HTTP router resolves `..` with `new URL()` BEFORE dispatch, so this
    // target's pathname IS `/centraid/_gateway/devices`. The peer handler
    // matches on the RAW url and refuses it. Confinement itself lives in the
    // forwarders; this is the backstop for one that forgets.
    const response = await fetch(`${base}/centraid/_peer/../_gateway/devices`, {
      headers: asPeer(),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      state: "not_found",
    });
  });

  test("a request with no peer proof reaches no peer route", async () => {
    const response = await fetch(`${base}/centraid/_peer/link/hello`, {
      headers: { [PEER_ENDPOINT_HEADER]: "ep-peer" },
    });
    expect(response.status).toBe(404);
  });

  test("host custody refuses anything the peer forwarder stamped", () => {
    const request = {
      headers: { [PEER_ENDPOINT_HEADER]: "ep-peer" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage;
    expect(isDirectHostRequest(request)).toBe(false);
  });
});
