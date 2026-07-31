import type { IncomingMessage } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import { subscribeReplicaCommits } from "@centraid/vault";

import { createWebPushSender } from "../push/web-push.js";
import type { WebPushSender } from "../push/web-push.js";
import {
  computeDueReminders,
  nextReminderFireAt,
} from "../reminders/due-reminders.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type { GatewayDatabase } from "../serve/gateway-db.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { readJson, sendJson } from "./route-helpers.js";

export const PUSH_REGISTRATIONS_PATH = "/centraid/_gateway/push/registrations";
export const PUSH_VAPID_KEY_PATH = "/centraid/_gateway/push/vapid-key";
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

function isClosedDatabaseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code =
    "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
  return (
    code === "ERR_INVALID_STATE" || /database is not open/iu.test(error.message)
  );
}

export function makePushRegistrationRouteHandler(
  gatewayDatabase: GatewayDatabase,
  webPush: WebPushSender = createWebPushSender(gatewayDatabase)
): RouteHandler {
  return async (req, res): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname === PUSH_VAPID_KEY_PATH) {
      if ((req.method ?? "GET") !== "GET")
        return sendJson(res, 405, { error: "method_not_allowed" });
      return sendJson(res, 200, { publicKey: webPush.publicKey() });
    }
    if (url.pathname !== PUSH_REGISTRATIONS_PATH) return false;
    const deviceId = callerDeviceId(req);
    if (!deviceId)
      return sendJson(res, 403, { error: "device_identity_required" });
    if ((req.method ?? "GET") === "DELETE") {
      gatewayDatabase.run(
        "DELETE FROM push_registrations WHERE device_id = ?",
        deviceId
      );
      gatewayDatabase.run(
        "DELETE FROM web_push_registrations WHERE device_id = ?",
        deviceId
      );
      return sendJson(res, 200, { removed: true });
    }
    if ((req.method ?? "GET") !== "POST")
      return sendJson(res, 405, { error: "method_not_allowed" });
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: "invalid_body" });
    }
    const token = body.token;
    const platform = body.platform;
    const subscription =
      body.subscription && typeof body.subscription === "object"
        ? (body.subscription as Record<string, unknown>)
        : undefined;
    if (platform === "web" && subscription) {
      const endpoint = subscription.endpoint;
      const keys =
        subscription.keys && typeof subscription.keys === "object"
          ? (subscription.keys as Record<string, unknown>)
          : undefined;
      const p256dh = keys?.p256dh;
      const auth = keys?.auth;
      if (
        typeof endpoint !== "string" ||
        !endpoint.startsWith("https://") ||
        typeof p256dh !== "string" ||
        p256dh.length < 40 ||
        typeof auth !== "string" ||
        auth.length < 8
      )
        return sendJson(res, 400, { error: "invalid_push_registration" });
      gatewayDatabase.run(
        `INSERT INTO web_push_registrations
          (endpoint, device_id, p256dh, auth, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           device_id = excluded.device_id,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           updated_at = excluded.updated_at`,
        endpoint,
        deviceId,
        p256dh,
        auth,
        new Date().toISOString()
      );
      return sendJson(res, 200, { registered: true });
    }
    if (
      typeof token !== "string" ||
      !/^(?:ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/u.test(token) ||
      (platform !== "ios" && platform !== "android")
    ) {
      return sendJson(res, 400, { error: "invalid_push_registration" });
    }
    gatewayDatabase.run(
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
    return sendJson(res, 200, { registered: true });
  };
}

/**
 * Minimal push-to-wake relay. It sends no vault id, item id, title, or content;
 * APNs/FCM delivery merely advances the same bounded background pull the
 * scheduler runs. Correctness never depends on push delivery.
 */
export class PushWakeRelay {
  readonly #unsubscribes = new Map<string, () => void>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #dueTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Coalesced armDue debounce timers (distinct from the next-fire arm). */
  readonly #dueArmTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #dueKeys = new Map<string, Set<string>>();
  /** Vaults waiting for a coalesced armDue after a commit storm. */
  readonly #dueArmPending = new Set<string>();
  #stopped = false;

  constructor(
    private readonly vaults: VaultRegistry,
    private readonly enrollments: EnrollmentStore,
    private readonly gatewayDatabase: GatewayDatabase,
    private readonly send: typeof fetch = fetch,
    private readonly webPush: WebPushSender = createWebPushSender(
      gatewayDatabase
    )
  ) {}

  start(): void {
    this.#stopped = false;
    for (const info of this.vaults.list()) {
      const plane = this.vaults.get(info.vaultId);
      if (plane) this.attach(plane);
    }
  }

  attach(plane: VaultPlane): void {
    if (this.#unsubscribes.has(plane.boot.vaultId)) return;
    this.#unsubscribes.set(
      plane.boot.vaultId,
      subscribeReplicaCommits(plane.db.vault, () => {
        this.schedule(plane.boot.vaultId);
        // Coalesce due-arming with the same 10s wake timer rather than
        // scanning task/event/tally tables on every vault commit.
        this.scheduleDue(plane);
      })
    );
    this.armDue(plane);
  }

  /** Request the same content-free, debounced wake used by replica commits. */
  requestWake(vaultId: string): void {
    this.schedule(vaultId);
  }

  stop(): void {
    this.#stopped = true;
    for (const unsubscribe of this.#unsubscribes.values()) unsubscribe();
    for (const timer of this.#timers.values()) clearTimeout(timer);
    for (const timer of this.#dueTimers.values()) clearTimeout(timer);
    for (const timer of this.#dueArmTimers.values()) clearTimeout(timer);
    this.#unsubscribes.clear();
    this.#timers.clear();
    this.#dueTimers.clear();
    this.#dueArmTimers.clear();
    this.#dueKeys.clear();
    this.#dueArmPending.clear();
  }

  private schedule(vaultId: string): void {
    if (this.#stopped || this.#timers.has(vaultId)) return;
    const timer = setTimeout(() => {
      this.#timers.delete(vaultId);
      void this.wake(vaultId);
    }, 10_000);
    timer.unref?.();
    this.#timers.set(vaultId, timer);
  }

  /** Coalesce armDue onto a short timer so commit storms do not N-scan. */
  private scheduleDue(plane: VaultPlane): void {
    if (this.#stopped) return;
    const vaultId = plane.boot.vaultId;
    if (this.#dueArmPending.has(vaultId)) return;
    this.#dueArmPending.add(vaultId);
    const timer = setTimeout(() => {
      this.#dueArmPending.delete(vaultId);
      this.#dueArmTimers.delete(vaultId);
      this.armDue(plane);
    }, 10_000);
    timer.unref?.();
    this.#dueArmTimers.set(vaultId, timer);
  }

  private armDue(plane: VaultPlane): void {
    if (this.#stopped) return;
    const vaultId = plane.boot.vaultId;
    const prior = this.#dueTimers.get(vaultId);
    if (prior) clearTimeout(prior);
    this.#dueTimers.delete(vaultId);
    const now = new Date();
    const seen = this.#dueKeys.get(vaultId) ?? new Set<string>();
    this.#dueKeys.set(vaultId, seen);
    let due: ReturnType<typeof computeDueReminders>;
    let next: string | null | undefined;
    try {
      due = computeDueReminders(plane.db, now.toISOString()).filter(
        (reminder) => !seen.has(reminder.key)
      );
      next = nextReminderFireAt(plane.db, now.toISOString());
    } catch (error) {
      // Plane/tests may close the vault after stop(); never surface a
      // closed-DB timer as an unhandled exception (vitest fails the suite).
      if (isClosedDatabaseError(error)) return;
      throw error;
    }
    if (due.length > 0) {
      for (const reminder of due) seen.add(reminder.key);
      void this.wake(vaultId);
    }
    if (!next) return;
    const delay = Math.max(
      0,
      Math.min(Date.parse(next) - now.getTime(), 2_147_000_000)
    );
    const timer = setTimeout(() => {
      this.#dueTimers.delete(vaultId);
      this.armDue(plane);
    }, delay);
    timer.unref?.();
    this.#dueTimers.set(vaultId, timer);
  }

  private async wake(vaultId: string): Promise<void> {
    const deviceIds = new Set(
      this.enrollments
        .listByVault(vaultId)
        .filter((row) => row.role !== "revoked")
        .map((row) => row.endpointId)
    );
    if (deviceIds.size === 0) return;
    const rows = this.gatewayDatabase.db
      .prepare(
        `SELECT device_id, expo_token FROM push_registrations
          ORDER BY device_id`
      )
      .all() as Array<{ device_id: string; expo_token: string }>;
    const messages = rows
      .filter((row) => deviceIds.has(row.device_id))
      .map((row) => ({
        to: row.expo_token,
        data: { centraid: "replica-wake" },
        _contentAvailable: true,
        priority: "normal",
        ttl: 60,
      }));
    await Promise.all([
      messages.length === 0
        ? Promise.resolve()
        : this.send(EXPO_PUSH_URL, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
            },
            body: JSON.stringify(messages),
          }).catch(() => undefined),
      this.webPush.sendWake(deviceIds),
    ]);
  }
}

function callerDeviceId(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
