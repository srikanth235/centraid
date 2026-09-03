import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { BearerAuthorization } from "@centraid/server/engine";

import { unrefTimer } from "../lib/unref-timer.js";
import { sendJson } from "../routes/route-helpers.js";
import type { RouteHandler } from "./build-gateway.js";
import { vaultContext, VAULT_HEADER } from "./vault-context.js";
import {
  WebControlSessionStore,
  hashControlToken,
  CONTROL_ABSOLUTE_TTL_MS,
} from "./web-session-store.js";

export const WEB_CONTROL_PATH = "/centraid/_web/control";
export const WEB_SERVICE_WORKER_HEADER = "x-centraid-service-worker";

const CONTROL_COOKIE = "__centraid_control";
const SWEEP_INTERVAL_MS = 5 * 60_000;
const SERVICE_WORKER_WAKE_PATHS = new Set([
  "/centraid/_vault/notifications",
  "/centraid/_reminders/due",
]);

export interface WebControlSessionsOptions {
  controlStore?: WebControlSessionStore;
  controlsFile?: string;
  isDeviceValid?: (deviceKey: string) => boolean;
  now?: () => number;
}

function safeOrigin(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw)) return undefined;
  try {
    const url = new URL(raw ?? "");
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function cookies(req: IncomingMessage): Map<string, string> {
  const values = new Map<string, string>();
  for (const pair of (req.headers.cookie ?? "").split(";")) {
    const split = pair.indexOf("=");
    if (split <= 0) continue;
    values.set(pair.slice(0, split).trim(), pair.slice(split + 1).trim());
  }
  return values;
}

function requestPath(req: IncomingMessage): string {
  return (req.url ?? "/").split("?")[0] ?? "/";
}

export class WebControlSessions {
  private readonly controlStore: WebControlSessionStore;
  private readonly isDeviceValid?: (deviceKey: string) => boolean;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: WebControlSessionsOptions = {}) {
    this.controlStore =
      options.controlStore ??
      WebControlSessionStore.open(options.controlsFile, options.now);
    if (options.isDeviceValid) this.isDeviceValid = options.isDeviceValid;
  }

  private revoked(deviceKey: string | undefined): boolean {
    return deviceKey !== undefined && this.isDeviceValid !== undefined
      ? !this.isDeviceValid(deviceKey)
      : false;
  }

  readonly handler: RouteHandler = (req, res) => {
    if (requestPath(req) !== WEB_CONTROL_PATH) return Promise.resolve(false);
    if ((req.method ?? "GET").toUpperCase() === "DELETE")
      return this.logout(req, res);
    return this.establishControl(req, res);
  };

  knownShellOrigins(): string[] {
    const origins = new Set<string>();
    for (const row of this.controlStore.list()) origins.add(row.shellOrigin);
    return [...origins];
  }

  authorize(req: IncomingMessage): BearerAuthorization | undefined {
    if (requestPath(req) !== WEB_CONTROL_PATH) return undefined;
    const presented = cookies(req);
    const origin = safeOrigin(req.headers.origin);
    const target = new URL(
      req.url ?? "/",
      "http://gateway.invalid"
    ).searchParams.get("path");
    const presentedToken = presented.get(CONTROL_COOKIE);
    const control =
      presentedToken === undefined
        ? undefined
        : this.controlStore.find(hashControlToken(presentedToken));
    const serviceWorkerWake =
      origin === undefined &&
      (req.method ?? "GET").toUpperCase() === "GET" &&
      req.headers[WEB_SERVICE_WORKER_HEADER] === "notifications-wake" &&
      req.headers["sec-fetch-site"] === "same-origin" &&
      target !== null &&
      SERVICE_WORKER_WAKE_PATHS.has(target);
    if (!control || (origin !== control.shellOrigin && !serviceWorkerWake))
      return undefined;
    if (this.revoked(control.deviceKey)) {
      this.controlStore.remove(control.tokenHash);
      return undefined;
    }
    if (!target) {
      if ((req.method ?? "GET").toUpperCase() === "DELETE") {
        return control.deviceKey
          ? { plane: "device", deviceKey: control.deviceKey }
          : undefined;
      }
      return undefined;
    }
    if (!target.startsWith("/") || target.startsWith(WEB_CONTROL_PATH))
      return undefined;
    this.controlStore.touch(control.tokenHash);
    req.url = target;
    req.headers[VAULT_HEADER] = control.vaultId;
    return control.deviceKey
      ? { plane: "device", deviceKey: control.deviceKey }
      : undefined;
  }

  private establishControl(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<true> {
    if ((req.method ?? "GET") !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return Promise.resolve(true);
    }
    const context = vaultContext();
    const shellOrigin = safeOrigin(req.headers.origin);
    if (!context || !shellOrigin) {
      sendJson(res, 400, { error: "origin_required" });
      return Promise.resolve(true);
    }
    const token = crypto.randomBytes(32).toString("base64url");
    this.sweep();
    this.controlStore.establish({
      tokenHash: hashControlToken(token),
      vaultId: context.vaultId,
      ...(context.deviceKey ? { deviceKey: context.deviceKey } : {}),
      shellOrigin,
    });
    const forwarded = req.headers["x-forwarded-proto"];
    const secure = forwarded === "https" ? "; Secure" : "";
    res.setHeader(
      "Set-Cookie",
      `${CONTROL_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=${WEB_CONTROL_PATH}; Max-Age=${Math.floor(CONTROL_ABSOLUTE_TTL_MS / 1000)}${secure}`
    );
    sendJson(res, 200, { ok: true, vaultId: context.vaultId });
    return Promise.resolve(true);
  }

  private logout(req: IncomingMessage, res: ServerResponse): Promise<true> {
    const presentedToken = cookies(req).get(CONTROL_COOKIE);
    if (presentedToken !== undefined)
      this.controlStore.remove(hashControlToken(presentedToken));
    const forwarded = req.headers["x-forwarded-proto"];
    const secure = forwarded === "https" ? "; Secure" : "";
    res.setHeader(
      "Set-Cookie",
      `${CONTROL_COOKIE}=; HttpOnly; SameSite=Strict; Path=${WEB_CONTROL_PATH}; Max-Age=0${secure}`
    );
    sendJson(res, 200, { ok: true });
    return Promise.resolve(true);
  }

  startSweeping(intervalMs = SWEEP_INTERVAL_MS): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    unrefTimer(this.sweepTimer);
  }

  stopSweeping(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  private sweep(): void {
    this.controlStore.sweepExpired();
  }
}
