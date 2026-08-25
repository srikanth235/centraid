/*
 * The CLI minting lane stays open with no paired device, at any tier.
 *
 * `centraid-gateway pair` runs with shell access on the gateway host and no
 * device identity — the devices route authorizes it through its own
 * host-custody check (`canMintPairingTicket` → `isDirectHostRequest`). The
 * composed handler's global "proved enrolled device" gate must not run first:
 * that would make the hatch unreachable, and a headless daemon could not
 * enroll any device from the CLI at all.
 *
 * The bypass must stay narrow — a loopback, non-forwarded caller only. An
 * iroh-forwarded request carries device headers and must still be gated.
 */

import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

import { describe, afterEach, beforeEach, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { isDirectHostRequest } from "../routes/route-helpers.ts";
import { buildGateway } from "./build-gateway.ts";
import type { BuiltGateway } from "./build-gateway.ts";
import { EnrollmentStore } from "./enrollment-store.ts";
import { GatewayDatabase } from "./gateway-db.ts";
import { PairingTicketStore } from "./pairing-store.ts";

const TICKET_PATH = "/centraid/_gateway/devices/ticket";
/** Stands in for the daemon's per-boot device proof. */
const PROOF = "per-boot-device-proof";

let dataDir: string;
let database: GatewayDatabase;
let gateway: BuiltGateway;
let server: http.Server;
let base: string;

describe("pairing-ticket-host-custody scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir("pair-host-custody-");
    database = GatewayDatabase.open(dataDir, { lock: "exclusive" });
    const enrollments = EnrollmentStore.open(database);
    const tickets = PairingTicketStore.open(database);
    gateway = await buildGateway({
      paths: { dataDir, vaultDir: path.join(dataDir, "vault") },
      gatewayDatabase: database,
      devicePairing: {
        enrollments,
        tickets,
        endpointTicket: () => "endpoint-ticket",
      },
      isHostCustody: isDirectHostRequest,
      // Mirrors the daemon's resolver rather than letting buildGateway fall back
      // to `embeddedAccess`, which resolves EVERY loopback request to the
      // embedded owner and would make the negative case pass vacuously.
      deviceAccess: {
        deviceKeyFor: (req) => {
          const device = req.headers["x-centraid-device"];
          if (typeof device !== "string" || device.length === 0)
            return undefined;
          return req.headers["x-centraid-device-proof"] === PROOF
            ? device
            : undefined;
        },
        vaultsFor: (deviceKey) => enrollments.vaultsFor(deviceKey),
      },
    });
    server = http.createServer((req, res) => {
      void gateway.composedHandler(req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no bound address");
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await gateway.stop().catch(() => undefined);
    database.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("direct host custody mints the first ticket with no enrolled device", async () => {
    const minted = await fetch(`${base}${TICKET_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(minted.status).toBe(200);
    await expect(minted.json()).resolves.toMatchObject({
      ok: true,
      ownerLabel: "You",
    });
  });

  test("an iroh-forwarded caller never reaches the host-custody hatch", async () => {
    const forwarded = await fetch(`${base}${TICKET_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-centraid-tunnel-forwarded": "1",
        "x-centraid-device": "unenrolled-device",
        "x-centraid-device-proof": "not-the-per-boot-proof",
      },
      body: JSON.stringify({}),
    });

    expect(forwarded.status).toBe(403);
    // Asserting the MESSAGE, not just the shared `device_identity_required`
    // code: the devices route refuses an unproved caller too, with the same
    // code but its own wording. Pinning the gate's wording is what proves the
    // forwarded request was stopped BEFORE the route — drop
    // `isDirectHostRequest` from the bypass and this flips to the route's
    // "pairing tickets require…" text.
    await expect(forwarded.json()).resolves.toMatchObject({
      error: "device_identity_required",
      message: "this request has no proved enrolled device identity",
    });
  });

  test("host custody re-mints for the same owner once one exists", async () => {
    const first = (await (
      await fetch(`${base}${TICKET_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    ).json()) as { ownerId: string };

    const minted = await fetch(`${base}${TICKET_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(minted.status).toBe(200);
    // The second mint targets the SAME person — access is ownership, and a
    // machine's host lane never invents a second owner for an owned vault.
    await expect(minted.json()).resolves.toMatchObject({
      ok: true,
      ownerId: first.ownerId,
    });
  });
});
