/*
 * The browser shell's CONTROL session (issue #504).
 *
 * A web PWA cannot hold the owner's bearer token in JS, so it establishes an
 * HttpOnly, origin-bound, device-keyed cookie once and then proxies every
 * gateway call through `/centraid/_web/control?path=…`. This module owns that
 * ceremony: establish, authorize + rewrite, logout, and expiry sweeping.
 *
 * It used to own a second plane as well — per-APP browser sessions
 * (`__centraid_app_*` cookies minted at `/centraid/_apps/<id>/web-session`)
 * that let a sandboxed app iframe talk to the gateway on its own narrow path
 * grant. That plane retired with the served-app plane it existed for (issue
 * #799): every app is now an inline route inside this same shell, so its
 * gateway traffic IS the shell's traffic and rides the control session.
 */

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { BearerAuthorization } from "@centraid/app-engine";

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
/** Expiry reclamation cadence — see `startSweeping()` (issue #659 G3). */
const SWEEP_INTERVAL_MS = 5 * 60_000;
const SERVICE_WORKER_WAKE_PATHS = new Set([
  "/centraid/_vault/notifications",
  "/centraid/_reminders/due",
]);

export interface WebControlSessionsOptions {
  /** Shared gateway.db-backed store. */
  controlStore?: WebControlSessionStore;
  /**
   * Persist CONTROL sessions to this JSON file so they survive a gateway
   * restart (and the 12h→30d sliding window). Omitted → in-memory only
   * (desktop embed, tests, an e2e `serve()` without wiring), exactly the
   * prior behavior.
   */
  controlsFile?: string;
  /**
   * Enrollment liveness check for revocation propagation (issue #376): a
   * live control cookie whose device enrollment was revoked
   * (`centraid-gateway devices revoke`) stops authorizing immediately
   * instead of riding its TTL. Given the session's `deviceKey`, return
   * `false` once the device is no longer enrolled. Legacy sessions without a
   * `deviceKey` never authorize: a web cookie cannot manufacture an identity.
   */
  isDeviceValid?: (deviceKey: string) => boolean;
  /** Clock seam (tests). Defaults to `Date.now`. */
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

  /**
   * Revocation propagation (issue #376): a session bound to a device key is
   * dead the moment that key's enrollment is revoked. Sessions without a
   * device key fail closed in `authorize()`.
   */
  private revoked(deviceKey: string | undefined): boolean {
    return deviceKey !== undefined && this.isDeviceValid !== undefined
      ? !this.isDeviceValid(deviceKey)
      : false;
  }

  readonly handler: RouteHandler = (req, res) => {
    if (requestPath(req) !== WEB_CONTROL_PATH) return Promise.resolve(false);
    // A DELETE that cleared the bearer gate in `authorize()` (valid cookie
    // + matching Origin) is a logout; POST is the establish ceremony.
    if ((req.method ?? "GET").toUpperCase() === "DELETE")
      return this.logout(req, res);
    return this.establishControl(req, res);
  };

  /**
   * Origins bound on live control sessions — credentialed CORS allowlist for
   * the loopback HTTP server (issue #504). Pure data for the host; does not
   * authorize a request by itself.
   */
  knownShellOrigins(): string[] {
    const origins = new Set<string>();
    for (const row of this.controlStore.list()) origins.add(row.shellOrigin);
    return [...origins];
  }

  authorize(req: IncomingMessage): BearerAuthorization | undefined {
    // No sweep here (issue #659 G3). Expiry is enforced by the store's
    // `expires_at > ?` predicate, so authorization never depended on the sweep
    // having just run — the sweep only reclaims rows, on `startSweeping()`'s
    // timer.
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
    // A revoked device's cookie stops working immediately — evict the row.
    if (this.revoked(control.deviceKey)) {
      this.controlStore.remove(control.tokenHash);
      return undefined;
    }
    // A DELETE straight to the control endpoint (no proxied `?path=`) is a
    // logout: leave the URL intact so `handler` performs the deletion and
    // expires the cookie; just clear the bearer gate here. A DELETE that
    // DOES carry a `?path=` is an ordinary proxied request (e.g. the shell
    // revoking a device via `DELETE /centraid/_gateway/devices/:id`) and
    // must fall through to the rewrite below — otherwise every DELETE API
    // call from the web shell would be swallowed as a control-session logout.
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
    // Extend the sliding idle window (throttled to an hourly disk write).
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
    // Multiple browsers/devices may hold concurrent control sessions: each is
    // HttpOnly, origin-bound, and expiry-swept. `establish` replaces only the
    // same-hash row — a second pairing must not silently invalidate the first
    // browser's cookie. Growth is bounded by sweepExpired().
    this.sweep();
    this.controlStore.establish({
      tokenHash: hashControlToken(token),
      vaultId: context.vaultId,
      ...(context.deviceKey ? { deviceKey: context.deviceKey } : {}),
      shellOrigin,
    });
    const forwarded = req.headers["x-forwarded-proto"];
    const secure = forwarded === "https" ? "; Secure" : "";
    // Cookie `Max-Age` carries the ABSOLUTE 180-day wall; the server-side
    // idle window (30d, sliding) is the tighter bound enforced on authorize.
    res.setHeader(
      "Set-Cookie",
      `${CONTROL_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=${WEB_CONTROL_PATH}; Max-Age=${Math.floor(CONTROL_ABSOLUTE_TTL_MS / 1000)}${secure}`
    );
    sendJson(res, 200, { ok: true, vaultId: context.vaultId });
    return Promise.resolve(true);
  }

  /**
   * Server-side logout (issue #376): a DELETE that presented a valid control
   * cookie + matching Origin (gated in `authorize`) drops the session row and
   * expires the cookie. Idempotent — the row may already be gone.
   */
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

  /**
   * Reclaim expired control sessions on a timer instead of on every HTTP
   * request (issue #659 G3). Idempotent; the timer is `unref`d so it never
   * holds the process open.
   */
  startSweeping(intervalMs = SWEEP_INTERVAL_MS): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref?.();
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
