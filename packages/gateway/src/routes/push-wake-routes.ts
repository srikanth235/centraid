import type { IncomingMessage } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import { subscribeReplicaCommits } from "@centraid/vault";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type { GatewayDatabase } from "../serve/gateway-db.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { readJson, sendJson } from "./route-helpers.js";

export const PUSH_REGISTRATIONS_PATH = "/centraid/_gateway/push/registrations";
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export function makePushRegistrationRouteHandler(
  gatewayDatabase: GatewayDatabase
): RouteHandler {
  return async (req, res): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname !== PUSH_REGISTRATIONS_PATH) return false;
    const deviceId = callerDeviceId(req);
    if (!deviceId)
      return sendJson(res, 403, { error: "device_identity_required" });
    if ((req.method ?? "GET") === "DELETE") {
      gatewayDatabase.run(
        "DELETE FROM push_registrations WHERE device_id = ?",
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

  constructor(
    private readonly vaults: VaultRegistry,
    private readonly enrollments: EnrollmentStore,
    private readonly gatewayDatabase: GatewayDatabase,
    private readonly send: typeof fetch = fetch
  ) {}

  start(): void {
    for (const info of this.vaults.list()) {
      const plane = this.vaults.get(info.vaultId);
      if (plane) this.attach(plane);
    }
  }

  attach(plane: VaultPlane): void {
    if (this.#unsubscribes.has(plane.boot.vaultId)) return;
    this.#unsubscribes.set(
      plane.boot.vaultId,
      subscribeReplicaCommits(plane.db.vault, () =>
        this.schedule(plane.boot.vaultId)
      )
    );
  }

  stop(): void {
    for (const unsubscribe of this.#unsubscribes.values()) unsubscribe();
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#unsubscribes.clear();
    this.#timers.clear();
  }

  private schedule(vaultId: string): void {
    if (this.#timers.has(vaultId)) return;
    const timer = setTimeout(() => {
      this.#timers.delete(vaultId);
      void this.wake(vaultId);
    }, 10_000);
    timer.unref?.();
    this.#timers.set(vaultId, timer);
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
    if (messages.length === 0) return;
    await this.send(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(messages),
    }).catch(() => undefined);
  }
}

function callerDeviceId(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
