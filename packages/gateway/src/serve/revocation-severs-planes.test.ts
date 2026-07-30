/*
 * Issue #555: one enrollment deletion severs every surviving device plane.
 * There is no direct bearer plane; the remaining durable planes are the
 * iroh admission row and device-bound web sessions.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, afterEach, beforeEach, expect, test, vi } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  createTunnelClient,
  startGatewayEndpoint,
  tunnelRequest,
} from "@centraid/tunnel";
import type { GatewayEndpointHandle, TunnelClient } from "@centraid/tunnel";

import { EnrollmentStore } from "./enrollment-store.ts";
import { GatewayDatabase } from "./gateway-db.ts";
import { PairingTicketStore } from "./pairing-store.ts";
import { serve } from "./serve.ts";
import type { GatewayServeHandle } from "./serve.ts";
import {
  hashControlToken,
  WebControlSessionStore,
} from "./web-session-store.ts";

const LOOPBACK_SECRET = "loopback-secret-for-tests";
let dataDir: string;
let database: GatewayDatabase;
let handle: GatewayServeHandle;
let endpoint: GatewayEndpointHandle | undefined;
let memberClient: TunnelClient | undefined;

describe("revocation-severs-planes scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir("revoke-planes-");
    database = GatewayDatabase.open(dataDir, { lock: "exclusive" });
  });

  afterEach(async () => {
    await memberClient?.close().catch(() => undefined);
    await endpoint?.close().catch(() => undefined);
    await handle?.close().catch(() => undefined);
    database.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("revocation removes web sessions and closes the admitted iroh endpoint", async () => {
    const enrollments = EnrollmentStore.open(database);
    const tickets = PairingTicketStore.open(database);
    const sessions = WebControlSessionStore.open(database);
    const onEndpointRevoked = vi.fn<(endpointId: string) => Promise<void>>(
      async (endpointId) => {
        await endpoint?.revokeEndpoint(endpointId);
      }
    );
    handle = await serve({
      paths: {
        dataDir,
        vaultDir: path.join(dataDir, "vault"),
      },
      gatewayDatabase: database,
      token: LOOPBACK_SECRET,
      deviceAccess: {
        deviceKeyFor: (req) => {
          const value = req.headers["x-test-device"];
          return typeof value === "string" ? value : undefined;
        },
        vaultsFor: (deviceKey) => enrollments.vaultsFor(deviceKey),
      },
      devicePairing: { enrollments, tickets, onEndpointRevoked },
      webSessions: {
        controlStore: sessions,
        isDeviceValid: (key) => enrollments.isEnrolled(key),
      },
    });
    endpoint = await startGatewayEndpoint({
      upstream: () => ({ baseUrl: handle.url, token: LOOPBACK_SECRET }),
      authorize: (endpointId) => enrollments.isEnrolled(endpointId),
      pair: () => ({ ok: false, error: "not_used" }),
      requestHeaders: (endpointId) => ({ "x-test-device": endpointId }),
      relays: "disabled",
    });
    memberClient = await createTunnelClient({ relays: "disabled" });
    const vaultId = handle.vaults.defaultVaultId();
    const owner = enrollments.enroll({
      endpointId: "owner-endpoint",
      vaultId,
      label: "Owner",
      role: "admin",
    });
    const member = enrollments.enroll({
      endpointId: memberClient.endpointId,
      vaultId,
      label: "Member",
      role: "write",
    });
    const tokenHash = hashControlToken("member-control-cookie");
    sessions.establish({
      tokenHash,
      vaultId,
      deviceKey: member.endpointId,
      shellOrigin: "http://127.0.0.1:4173",
    });
    const admitted = await memberClient.connect(endpoint.ticket());
    expect(
      (
        await tunnelRequest(admitted, {
          method: "GET",
          target: "/centraid/_apps",
        })
      ).status
    ).toBe(200);

    const response = await fetch(
      `${handle.url}/centraid/_gateway/devices/${encodeURIComponent(member.enrollmentId)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${LOOPBACK_SECRET}`,
          "x-test-device": owner.endpointId,
        },
      }
    );
    expect(response.status).toBe(200);
    expect(enrollments.isEnrolled(member.endpointId)).toBe(false);
    expect(sessions.find(tokenHash)).toBeUndefined();
    expect(onEndpointRevoked).toHaveBeenCalledWith(member.endpointId);
    await admitted.closed();
    const refused = await memberClient.connect(endpoint.ticket());
    await expect(
      tunnelRequest(refused, { method: "GET", target: "/centraid/_apps" })
    ).rejects.toThrow("unauthorized");
  });
});
