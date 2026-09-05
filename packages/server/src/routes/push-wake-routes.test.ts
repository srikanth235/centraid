// governance: allow-repo-hygiene file-size-limit (#865) registration, wake replay, and the SSRF guard share one fixture gateway; splitting them would triple the boot cost.
import { promises as dnsPromises } from "node:dns";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";
import { useFakeClock } from "@centraid/test-kit/fake-clock";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { notifyReplicaCommit } from "@centraid/vault";

import type { WebPushSender } from "../push/web-push.js";
import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import { openVaultPlane } from "../serve/vault-plane.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import {
  makePushRegistrationRouteHandler,
  PUSH_REGISTRATIONS_PATH,
  PUSH_VAPID_KEY_PATH,
  PushWakeRelay,
} from "./push-wake-routes.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const servers: http.Server[] = [];
const databases: GatewayDatabase[] = [];
const planes: VaultPlane[] = [];
const dirs: string[] = [];
const relays: PushWakeRelay[] = [];

describe("push-wake-routes", () => {
  // Registration resolves the endpoint host (issue #865); tests run offline,
  // so named hosts default to a public resolution. Individual tests override
  // this spy for reserved-range cases.
  beforeEach(() => {
    vi.spyOn(dnsPromises, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const relay of relays.splice(0)) relay.stop();
    for (const server of servers.splice(0)) server.close();
    for (const plane of planes.splice(0)) plane.stop();
    for (const database of databases.splice(0)) database.close();
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  test("registers, upserts, and removes an Expo push token for the calling device", async () => {
    const { base, database } = await registrationServer();
    const headers = {
      [AUTHED_DEVICE_HEADER]: "phone-1",
      "content-type": "application/json",
    };
    const first = await fetch(`${base}${PUSH_REGISTRATIONS_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        token: "ExponentPushToken[first-token]",
        platform: "ios",
      }),
    });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toStrictEqual({ registered: true });
    expect(registrationRows(database)).toStrictEqual([
      {
        device_id: "phone-1",
        expo_token: "ExponentPushToken[first-token]",
        platform: "ios",
      },
    ]);

    const upsert = await fetch(`${base}${PUSH_REGISTRATIONS_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        token: "ExpoPushToken[second-token]",
        platform: "android",
      }),
    });
    expect(upsert.status).toBe(200);
    expect(registrationRows(database)).toStrictEqual([
      {
        device_id: "phone-1",
        expo_token: "ExpoPushToken[second-token]",
        platform: "android",
      },
    ]);

    const removed = await fetch(`${base}${PUSH_REGISTRATIONS_PATH}`, {
      method: "DELETE",
      headers: { [AUTHED_DEVICE_HEADER]: "phone-1" },
    });
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toStrictEqual({ removed: true });
    expect(registrationRows(database)).toStrictEqual([]);
  });

  test("rejects unauthenticated, invalid, and wrong-method registration calls", async () => {
    const { base } = await registrationServer();
    const noDevice = await fetch(`${base}${PUSH_REGISTRATIONS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "ExponentPushToken[x]",
        platform: "ios",
      }),
    });
    expect(noDevice.status).toBe(403);

    const badToken = await fetch(`${base}${PUSH_REGISTRATIONS_PATH}`, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: "phone-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: "not-an-expo-token", platform: "ios" }),
    });
    expect(badToken.status).toBe(400);
    await expect(badToken.json()).resolves.toStrictEqual({
      error: "invalid_push_registration",
    });

    const badPlatform = await fetch(`${base}${PUSH_REGISTRATIONS_PATH}`, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: "phone-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        token: "ExponentPushToken[ok]",
        platform: "web",
      }),
    });
    expect(badPlatform.status).toBe(400);

    const badJson = await fetch(`${base}${PUSH_REGISTRATIONS_PATH}`, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: "phone-1",
        "content-type": "application/json",
      },
      body: "{",
    });
    expect(badJson.status).toBe(400);

    const wrongMethod = await fetch(`${base}${PUSH_REGISTRATIONS_PATH}`, {
      method: "PUT",
      headers: { [AUTHED_DEVICE_HEADER]: "phone-1" },
    });
    expect(wrongMethod.status).toBe(405);

    // Non-matching path: handler returns false; our server ends without body.
    const unknownPath = await fetch(`${base}/centraid/_gateway/push/other`, {
      method: "POST",
      headers: { [AUTHED_DEVICE_HEADER]: "phone-1" },
    });
    expect(unknownPath.status).toBe(200);
    await expect(unknownPath.text()).resolves.toBe("");
  });

  test("registers and revokes a browser subscription without storing content", async () => {
    const webPush: WebPushSender = {
      publicKey: () => "public-vapid-key",
      sendWake: async () => undefined,
    };
    const { base, database } = await registrationServer(webPush);
    const headers = {
      [AUTHED_DEVICE_HEADER]: "phone-1",
      "content-type": "application/json",
    };
    const key = await fetch(`${base}${PUSH_VAPID_KEY_PATH}`, { headers });
    expect(key.status).toBe(200);
    await expect(key.json()).resolves.toStrictEqual({
      publicKey: "public-vapid-key",
    });
    const registered = await fetch(`${base}${PUSH_REGISTRATIONS_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        platform: "web",
        subscription: {
          endpoint: "https://push.example/subscription-1",
          keys: {
            p256dh: "p".repeat(65),
            auth: "a".repeat(16),
          },
        },
      }),
    });
    expect(registered.status).toBe(200);
    expect(webRegistrationRows(database)).toStrictEqual([
      {
        auth: "a".repeat(16),
        device_id: "phone-1",
        endpoint: "https://push.example/subscription-1",
        p256dh: "p".repeat(65),
      },
    ]);

    const removed = await fetch(`${base}${PUSH_REGISTRATIONS_PATH}`, {
      method: "DELETE",
      headers,
    });
    expect(removed.status).toBe(200);
    expect(webRegistrationRows(database)).toStrictEqual([]);
  });

  test("refuses web-push endpoints that resolve into reserved ranges (issue #865)", async () => {
    const { base, database } = await registrationServer();
    const headers = {
      [AUTHED_DEVICE_HEADER]: "phone-1",
      "content-type": "application/json",
    };
    const register = (endpoint: string) =>
      fetch(`${base}${PUSH_REGISTRATIONS_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          platform: "web",
          subscription: {
            endpoint,
            keys: { p256dh: "p".repeat(65), auth: "a".repeat(16) },
          },
        }),
      });

    // Reserved-range IP literals are refused without touching DNS at all.
    await Promise.all(
      [
        "https://127.0.0.1:8080/fcm",
        "https://[::1]/fcm",
        "https://10.9.8.7/fcm",
        "https://192.168.1.10/fcm",
        "https://169.254.169.254/latest/meta-data",
        "https://[fd00::5]/fcm",
      ].map(async (endpoint) => {
        const refused = await register(endpoint);
        expect(refused.status).toBe(400);
        await expect(refused.json()).resolves.toMatchObject({
          error: "invalid_push_registration",
          reason: expect.stringMatching(/reserved-range|must use https/u),
        });
      })
    );

    // A DNS name resolving to a private address is refused too.
    vi.spyOn(dnsPromises, "lookup").mockResolvedValue([
      { address: "192.168.0.20", family: 4 },
    ] as never);
    const rebinded = await register("https://rebind.example/wake");
    expect(rebinded.status).toBe(400);
    await expect(rebinded.json()).resolves.toMatchObject({
      error: "invalid_push_registration",
      reason: expect.stringContaining("reserved-range"),
    });

    // Nothing from the refusals ever reached storage.
    expect(webRegistrationRows(database)).toStrictEqual([]);
  });

  test("PushWakeRelay debounces vault and Notifications wakes into opaque-only payloads", async () => {
    const clock = useFakeClock();
    const { plane, enrollments, database, vaults } = await wakeFixture();
    const deviceId = "wake-phone";
    const wake = enrollments.enroll({
      endpointId: deviceId,
      label: "Wake phone",
      ownerLabel: "Priya",
      vaultIds: [plane.boot.vaultId],
    });
    // Revoked sibling still registered for push must never receive a wake.
    enrollments.enroll({
      endpointId: "revoked-phone",
      label: "Revoked phone",
      ownerId: wake.ownerId,
      vaultIds: [plane.boot.vaultId],
    });
    enrollments.revoke("revoked-phone");
    insertRegistration(database, deviceId, "ExponentPushToken[wake-me]", "ios");
    insertRegistration(
      database,
      "revoked-phone",
      "ExponentPushToken[revoked]",
      "android"
    );

    const send = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 200 })
    );
    const relay = new PushWakeRelay(vaults, enrollments, database, send);
    relays.push(relay);
    relay.start();

    // Real doorbell path the vault uses after a committed write.
    notifyReplicaCommit(plane.db.vault);
    notifyReplicaCommit(plane.db.vault); // second ring still one debounce timer
    expect(send).not.toHaveBeenCalled();

    await clock.advance(10_000);
    await flushMicrotasks();

    expect(send).toHaveBeenCalledOnce();
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe("https://exp.host/--/api/v2/push/send");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
    });
    const body = JSON.parse(String(init?.body)) as Array<
      Record<string, unknown>
    >;
    expect(body).toStrictEqual([
      {
        to: "ExponentPushToken[wake-me]",
        data: { centraid: "replica-wake" },
        _contentAvailable: true,
        priority: "normal",
        ttl: 60,
      },
    ]);
    // Opacity: no vault id or content identity in the Expo payload.
    expect(JSON.stringify(body)).not.toContain(plane.boot.vaultId);
    expect(JSON.stringify(body)).not.toContain("revoked");

    send.mockClear();
    relay.requestWake(plane.boot.vaultId);
    await clock.advance(10_000);
    await flushMicrotasks();
    expect(send).toHaveBeenCalledOnce();
    const explicitBody = JSON.parse(
      String(send.mock.calls[0]?.[1]?.body)
    ) as Array<Record<string, unknown>>;
    expect(explicitBody).toStrictEqual(body);
    expect(JSON.stringify(explicitBody)).not.toContain(plane.boot.vaultId);

    relay.attach(plane); // idempotent second attach
    relay.stop();
  });

  test("PushWakeRelay swallows Expo delivery failures and skips empty audiences", async () => {
    const clock = useFakeClock();
    const { plane, enrollments, database, vaults } = await wakeFixture();
    enrollments.enroll({
      endpointId: "silent-phone",
      label: "Silent",
      ownerLabel: "Priya",
      vaultIds: [plane.boot.vaultId],
    });
    const send = vi.fn<typeof fetch>(async () => {
      throw new Error("expo unreachable");
    });
    const relay = new PushWakeRelay(vaults, enrollments, database, send);
    relays.push(relay);
    relay.start();

    // Enrolled device but no push registration → wake is a no-op.
    notifyReplicaCommit(plane.db.vault);
    await clock.advance(10_000);
    await flushMicrotasks();
    expect(send).not.toHaveBeenCalled();

    // Registered audience + failing Expo delivery must not throw out of wake.
    insertRegistration(
      database,
      "silent-phone",
      "ExponentPushToken[fail]",
      "ios"
    );
    notifyReplicaCommit(plane.db.vault);
    await clock.advance(10_000);
    await flushMicrotasks();
    expect(send).toHaveBeenCalledOnce();
  });

  test("PushWakeRelay arms the exact next reminder instead of relying on a poll", async () => {
    const clock = useFakeClock(new Date("2026-07-29T12:00:00.000Z"));
    const { plane, enrollments, database, vaults } = await wakeFixture();
    const deviceId = "timer-phone";
    enrollments.enroll({
      endpointId: deviceId,
      label: "Timer phone",
      ownerLabel: "Priya",
      vaultIds: [plane.boot.vaultId],
    });
    insertRegistration(
      database,
      deviceId,
      "ExponentPushToken[timer]",
      "android"
    );
    plane.db.vault
      .prepare(
        `INSERT INTO schedule_task
          (task_id, owner_party_id, title, status, priority, due_at,
           remind_before_min)
         VALUES ('timer-task', ?, 'Leave now', 'needs-action', 0,
                 '2026-07-29T12:00:05.000Z', 0)`
      )
      .run(plane.boot.ownerPartyId);
    const send = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 200 })
    );
    const webPush: WebPushSender = {
      publicKey: () => "unused",
      sendWake: async () => undefined,
    };
    const relay = new PushWakeRelay(
      vaults,
      enrollments,
      database,
      send,
      webPush
    );
    relays.push(relay);
    relay.start();

    await clock.advance(4_999);
    expect(send).not.toHaveBeenCalled();
    await clock.advance(1);
    await flushMicrotasks();

    expect(send).toHaveBeenCalledOnce();
  });

  test("PushWakeRelay reads three entities per idle tick and receipts none", async () => {
    // #916 routed the reminder scan through the gateway, so this timer is a
    // WRITER: every read appends an access.receipt. It used to ask twice for
    // the same two entities — `computeDueReminders` then `nextReminderFireAt`,
    // same instant, same rows — and commit all five receipts separately, which
    // is what pushed idle disk writes past their budget. One scan, one commit.
    const clock = useFakeClock();
    const { plane, enrollments, database, vaults } = await wakeFixture();
    enrollments.enroll({
      endpointId: "receipt-phone",
      label: "Receipt phone",
      ownerLabel: "Priya",
      vaultIds: [plane.boot.vaultId],
    });
    const send = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 200 })
    );
    const relay = new PushWakeRelay(vaults, enrollments, database, send);
    relays.push(relay);
    const receipts = (): number =>
      (
        plane.db.vault
          .prepare(
            "SELECT COUNT(*) AS n FROM access_receipt WHERE action = 'read'"
          )
          .get() as { n: number }
      ).n;

    relay.start(); // attach() arms the first scan synchronously
    const afterFirstScan = receipts();
    notifyReplicaCommit(plane.db.vault);
    await clock.advance(10_000);
    await flushMicrotasks();

    // OWNER-DIRECT SCANS COST NO AUDIT WRITE (#928, #922 B1). The three reads
    // (schedule.task, schedule.event_ext, tally.recurring_expense) happen —
    // the relay's whole job — and leave the band untouched, which is the
    // point: an idle tick used to pay three fsyncs to prove nothing.
    expect(receipts() - afterFirstScan).toBe(0);
    expect(plane.db.vault.isTransaction).toBe(false);
  });

  test("PushWakeRelay stop clears due-arm debounce so closed vaults do not throw", async () => {
    const clock = useFakeClock();
    const { plane, enrollments, database, vaults } = await wakeFixture();
    enrollments.enroll({
      endpointId: "closed-phone",
      label: "Closed",
      ownerLabel: "Priya",
      vaultIds: [plane.boot.vaultId],
    });
    const send = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 200 })
    );
    const relay = new PushWakeRelay(vaults, enrollments, database, send);
    relays.push(relay);
    relay.start();

    // Schedule a coalesced armDue, then tear down the plane + relay before it
    // fires. Without clearing #dueArmTimers this re-entered armDue on a closed
    // DatabaseSync and surfaced as vitest unhandled ERR_INVALID_STATE.
    notifyReplicaCommit(plane.db.vault);
    plane.stop();
    relay.stop();
    await clock.advance(10_000);
    await flushMicrotasks();
    expect(send).not.toHaveBeenCalled();
  });

  test("PushWakeRelay armDue swallows closed-database errors after plane.stop", async () => {
    const clock = useFakeClock(new Date("2026-07-29T12:00:00.000Z"));
    const { plane, enrollments, database, vaults } = await wakeFixture();
    enrollments.enroll({
      endpointId: "race-phone",
      label: "Race",
      ownerLabel: "Priya",
      vaultIds: [plane.boot.vaultId],
    });
    insertRegistration(
      database,
      "race-phone",
      "ExponentPushToken[race]",
      "ios"
    );
    plane.db.vault
      .prepare(
        `INSERT INTO schedule_task
          (task_id, owner_party_id, title, status, priority, due_at,
           remind_before_min)
         VALUES ('race-task', ?, 'Soon', 'needs-action', 0,
                 '2026-07-29T12:00:05.000Z', 0)`
      )
      .run(plane.boot.ownerPartyId);
    const send = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 200 })
    );
    const relay = new PushWakeRelay(vaults, enrollments, database, send);
    relays.push(relay);
    relay.start();
    // Close the vault while the next-fire timer is still armed, without
    // stop()ing the relay — exercises the closed-DB catch in armDue.
    plane.stop();
    await clock.advance(5_000);
    await flushMicrotasks();
    // No unhandled rejection; wake must not fire against a dead plane.
    expect(send).not.toHaveBeenCalled();
    relay.stop();
  });
});

async function registrationServer(webPush?: WebPushSender): Promise<{
  base: string;
  database: GatewayDatabase;
}> {
  const root = await tempDir("push-reg-");
  dirs.push(root);
  const database = GatewayDatabase.open(root);
  databases.push(database);
  const enrollments = EnrollmentStore.open(database);
  enrollments.enroll({
    endpointId: "phone-1",
    label: "Phone",
    ownerLabel: "Priya",
    vaultIds: ["vault-personal"],
  });
  const handler = makePushRegistrationRouteHandler(database, webPush);
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled && !res.writableEnded) res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, database };
}

function webRegistrationRows(database: GatewayDatabase): Array<{
  endpoint: string;
  device_id: string;
  p256dh: string;
  auth: string;
}> {
  return (
    database.db
      .prepare(
        `SELECT endpoint, device_id, p256dh, auth
           FROM web_push_registrations
          ORDER BY endpoint`
      )
      .all() as Array<{
      endpoint: string;
      device_id: string;
      p256dh: string;
      auth: string;
    }>
  ).map((row) => ({ ...row }));
}

async function wakeFixture(): Promise<{
  plane: VaultPlane;
  enrollments: EnrollmentStore;
  database: GatewayDatabase;
  vaults: VaultRegistry;
}> {
  const root = await tempDir("push-wake-");
  dirs.push(root);
  const database = GatewayDatabase.open(root);
  databases.push(database);
  const enrollments = EnrollmentStore.open(database);
  const plane = openVaultPlane({
    bootstrap: true,
    dir: path.join(root, "vault"),
    logger,
    enableWalShipper: false,
  });
  planes.push(plane);
  const vaults = {
    list: () => [{ vaultId: plane.boot.vaultId }],
    get: (vaultId: string) =>
      vaultId === plane.boot.vaultId ? plane : undefined,
  } as unknown as VaultRegistry;
  return { plane, enrollments, database, vaults };
}

function insertRegistration(
  database: GatewayDatabase,
  deviceId: string,
  token: string,
  platform: "ios" | "android"
): void {
  database.run(
    `INSERT INTO push_registrations
       (device_id, expo_token, platform, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       expo_token = excluded.expo_token,
       platform = excluded.platform,
       updated_at = excluded.updated_at`,
    deviceId,
    token,
    platform,
    new Date().toISOString()
  );
}

function registrationRows(database: GatewayDatabase): Array<{
  device_id: string;
  expo_token: string;
  platform: string;
}> {
  return (
    database.db
      .prepare(
        `SELECT device_id, expo_token, platform FROM push_registrations
          ORDER BY device_id`
      )
      .all() as Array<{
      device_id: string;
      expo_token: string;
      platform: string;
    }>
  ).map((row) => ({ ...row }));
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
