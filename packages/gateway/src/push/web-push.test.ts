import { afterEach, describe, expect, it, vi } from "vitest";
import webPush from "web-push";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import { createWebPushSender, webPushVapidKeys } from "./web-push.js";

const opened: GatewayDatabase[] = [];

describe("self-hosted Web Push identity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const database of opened.splice(0)) database.close();
  });

  it("generates once and persists the VAPID key pair", async () => {
    const database = GatewayDatabase.open(await tempDir("web-push-"));
    opened.push(database);
    const first = webPushVapidKeys(database);
    const second = webPushVapidKeys(database);
    expect(first).toStrictEqual(second);
    expect(first.publicKey.length).toBeGreaterThan(40);
    expect(first.privateKey.length).toBeGreaterThan(20);
    expect(
      (
        database.db
          .prepare("SELECT count(*) AS n FROM web_push_vapid")
          .get() as { n: number }
      ).n
    ).toBe(1);
  });

  it("sends only the opaque wake marker and removes expired endpoints", async () => {
    const database = GatewayDatabase.open(await tempDir("web-push-send-"));
    opened.push(database);
    const enrollments = EnrollmentStore.open(database);
    for (const endpointId of ["device-1", "device-2"]) {
      enrollments.enroll({
        endpointId,
        label: endpointId,
        memberLabel: endpointId,
        grants: [{ vaultId: "vault-1", role: "write" }],
      });
    }
    for (const [endpoint, deviceId] of [
      ["https://push.example/current", "device-1"],
      ["https://push.example/expired", "device-1"],
      ["https://push.example/other", "device-2"],
    ] as const) {
      database.run(
        `INSERT INTO web_push_registrations
           (endpoint, device_id, p256dh, auth, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        endpoint,
        deviceId,
        "p".repeat(65),
        "a".repeat(16),
        new Date().toISOString()
      );
    }
    const send = vi
      .spyOn(webPush, "sendNotification")
      .mockImplementation(async (subscription) => {
        if (subscription.endpoint.endsWith("/expired"))
          throw Object.assign(new Error("gone"), { statusCode: 410 });
        return {
          statusCode: 201,
          body: "",
          headers: {},
        };
      });
    await createWebPushSender(database).sendWake(new Set(["device-1"]));

    expect(send).toHaveBeenCalledTimes(2);
    for (const call of send.mock.calls) {
      expect(call[1]).toBe('{"centraid":"replica-wake"}');
      expect(call[1]).not.toContain("device-1");
    }
    expect(
      (
        database.db
          .prepare(
            "SELECT endpoint FROM web_push_registrations ORDER BY endpoint"
          )
          .all() as Array<{ endpoint: string }>
      ).map((row) => row.endpoint)
    ).toStrictEqual([
      "https://push.example/current",
      "https://push.example/other",
    ]);
  });
});
