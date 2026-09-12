/*
 * LOOPBACK IS NOT THE HOST (#568, #1015 ruling R-NY-18).
 *
 * The embedded gateway resolved the HOST's enrolment for any loopback request
 * that carried no peer header. Every forwarder — the phone tunnel, the byte
 * relay — delivers a remote peer to 127.0.0.1, so that fallback handed the
 * owner's whole vault surface, `K` included, to whoever the forwarder was
 * carrying. Host identity belongs to a request no forwarder touched, and to
 * nothing else.
 *
 * The other half of R-NY-18 — that a STAMPED phone resolves as the phone —
 * is pinned in `tunnelled-phone-identity.test.ts`, which needs the stamp's
 * own vocabulary. This file needs none: it only asserts what must be refused.
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ROUTES } from "@centraid/core/protocol";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  DEVICE_IDENTITY_HEADER,
  DEVICE_PROOF_HEADER,
  PEER_ENDPOINT_HEADER,
  TUNNEL_FORWARDED_HEADER,
} from "@centraid/tunnel";

import { buildGateway } from "./build-gateway.js";
import type { BuiltGateway } from "./build-gateway.js";

const HOST_ENDPOINT = "host-endpoint-1015";

const cleanups: Array<() => Promise<void>> = [];

/** A loopback server that answers 404 for an unrouted path rather than hanging. */
async function mount(
  gateway: BuiltGateway
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void gateway.composedHandler(req, res).then((handled) => {
      if (handled) return;
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("no bound address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function embeddedGateway(): Promise<{ url: string }> {
  const dataDir = await tempDir(`embedded-identity-${crypto.randomUUID()}-`);
  const gateway = await buildGateway({
    paths: { vaultDir: path.join(dataDir, "vault") },
    hostDeviceEndpointId: HOST_ENDPOINT,
  });
  const mounted = await mount(gateway);
  cleanups.push(async () => {
    await mounted.close();
    await gateway.stop().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { url: mounted.url };
}

describe("the embedded gateway's host identity", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  test("the host's own direct request still reaches the key door", async () => {
    const { url } = await embeddedGateway();
    const response = await fetch(`${url}${ROUTES.vaultSeatLockerKey}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["key"]).toBeTypeOf("string");
  }, 30_000);

  test("a forwarded hop with no device stamp is NOT the host", async () => {
    const { url } = await embeddedGateway();
    const response = await fetch(`${url}${ROUTES.vaultSeatLockerKey}`, {
      headers: { [TUNNEL_FORWARDED_HEADER]: "1" },
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["key"]).toBeUndefined();
  }, 30_000);

  test("a device stamp with an unusable proof is NOT the host", async () => {
    const { url } = await embeddedGateway();
    const response = await fetch(`${url}${ROUTES.vaultSeatLockerKey}`, {
      headers: {
        [TUNNEL_FORWARDED_HEADER]: "1",
        [DEVICE_IDENTITY_HEADER]: "ep-attacker",
        [DEVICE_PROOF_HEADER]: crypto.randomBytes(32).toString("hex"),
      },
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["key"]).toBeUndefined();
  }, 30_000);

  test("a peer hop is refused, stamp or no stamp", async () => {
    const { url } = await embeddedGateway();
    const response = await fetch(`${url}${ROUTES.vaultSeatLockerKey}`, {
      headers: {
        [TUNNEL_FORWARDED_HEADER]: "1",
        [PEER_ENDPOINT_HEADER]: "ep-linked-gateway",
        [DEVICE_IDENTITY_HEADER]: HOST_ENDPOINT,
      },
    });
    // A peer hop never reaches a device door at all — the linked-gateway lane
    // answers for `/centraid/_peer/*` and nothing else — so the refusal is a
    // 404 rather than a 403. What matters is the same either way: a linked
    // gateway must never inherit the host's owner-tier reach (#726, trap 2).
    expect(response.status).not.toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["key"]).toBeUndefined();
  }, 30_000);
});
