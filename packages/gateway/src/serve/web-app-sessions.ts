import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BearerAuthorization } from '@centraid/app-engine';
import { sendJson } from '../routes/route-helpers.js';
import { vaultContext, VAULT_HEADER } from './vault-context.js';
import {
  WebControlSessionStore,
  hashControlToken,
  CONTROL_ABSOLUTE_TTL_MS,
} from './web-session-store.js';
import type { RouteHandler } from './build-gateway.js';

export const WEB_SESSION_REDEEM_PATH = '/centraid/_web/session';
export const WEB_CONTROL_PATH = '/centraid/_web/control';
export const WEB_APP_HEADER = 'x-centraid-web-app';
export const WEB_SHELL_ORIGIN_HEADER = 'x-centraid-web-shell-origin';

const CONTROL_COOKIE = '__centraid_control';
const MINT_RE = /^\/centraid\/_apps\/([^/]+)\/web-session$/;
const PENDING_TTL_MS = 60_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const REPLICA_APP_PATHS = new Set([
  '/centraid/_vault/replica/bootstrap',
  '/centraid/_vault/changes',
  '/centraid/_vault/replica/row',
  '/centraid/_vault/replica/checkpoint',
  '/centraid/_vault/replica/intents',
]);

export interface WebAppSessionsOptions {
  /**
   * Persist CONTROL sessions to this JSON file so they survive a gateway
   * restart (and the 12h→30d sliding window). Omitted → in-memory only
   * (desktop embed, tests, an e2e `serve()` without wiring), exactly the
   * prior behavior.
   */
  controlsFile?: string;
  /**
   * Enrollment liveness check for revocation propagation (issue #376): a
   * live control/app cookie whose device enrollment was revoked
   * (`centraid-gateway devices revoke`) stops authorizing immediately
   * instead of riding its TTL. Given the session's `deviceKey`, return
   * `false` once the device is no longer enrolled. Sessions with no
   * `deviceKey` (admin/shared-bearer plane) skip this — the admin plane is
   * the landlord.
   */
  isDeviceValid?: (deviceKey: string) => boolean;
  /** Clock seam (tests). Defaults to `Date.now`. */
  now?: () => number;
}

interface SessionScope {
  appId: string;
  vaultId: string;
  deviceKey?: string;
  shellOrigin: string;
  draftSessionId?: string;
}

interface PendingSession extends SessionScope {
  expiresAt: number;
}

interface ActiveSession extends SessionScope {
  token: string;
  cookieName: string;
  expiresAt: number;
}

function safeOrigin(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw)) return undefined;
  try {
    const url = new URL(raw ?? '');
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Constant-time cookie-token comparison, matching the repo's secret-compare
 * standard. `crypto.timingSafeEqual` throws on unequal lengths, so bail early
 * (a length mismatch already means the tokens differ). */
function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function cookies(req: IncomingMessage): Map<string, string> {
  const values = new Map<string, string>();
  for (const pair of (req.headers.cookie ?? '').split(';')) {
    const split = pair.indexOf('=');
    if (split <= 0) continue;
    values.set(pair.slice(0, split).trim(), pair.slice(split + 1).trim());
  }
  return values;
}

function requestPath(req: IncomingMessage): string {
  return (req.url ?? '/').split('?')[0] ?? '/';
}

function permits(scope: SessionScope, pathname: string): boolean {
  const app = encodeURIComponent(scope.appId);
  if (pathname.startsWith(`/centraid/${app}/`)) return true;
  if (scope.draftSessionId) {
    const draft = encodeURIComponent(scope.draftSessionId);
    if (pathname.startsWith(`/centraid/_draft/${draft}/${app}/`)) return true;
    if (pathname.startsWith(`/centraid/_draft/${draft}/_tool/`)) return true;
  }
  // Generated apps stage uploads and serve their already-authorized media
  // through the blob custody door. Keep this separate from the rest of the
  // vault surface: the app still receives no general /_vault authority.
  if (pathname === '/centraid/_vault/blobs' || pathname.startsWith('/centraid/_vault/blobs/')) {
    return true;
  }
  // App sessions may use only the replica protocol's exact paths. The
  // authorizer stamps x-centraid-web-app after the cookie/origin checks;
  // replica routes derive their shape and intent app from that trusted
  // header, so this does not open the rest of the owner `_vault` surface.
  if (REPLICA_APP_PATHS.has(pathname)) return true;
  return pathname.startsWith('/centraid/_tool/');
}

export class WebAppSessions {
  private readonly pending = new Map<string, PendingSession>();
  private readonly active = new Map<string, ActiveSession>();
  private readonly activeByCookieName = new Map<string, ActiveSession>();
  private readonly controlStore: WebControlSessionStore;
  private readonly isDeviceValid?: (deviceKey: string) => boolean;
  private readonly now: () => number;

  constructor(options: WebAppSessionsOptions = {}) {
    this.controlStore = WebControlSessionStore.open(options.controlsFile, options.now);
    if (options.isDeviceValid) this.isDeviceValid = options.isDeviceValid;
    this.now = options.now ?? Date.now;
  }

  /**
   * Revocation propagation (issue #376): a session bound to a device key is
   * dead the moment that key's enrollment is revoked. Sessions without a
   * device key (admin/shared-bearer plane) are never revoked here.
   */
  private revoked(deviceKey: string | undefined): boolean {
    return deviceKey !== undefined && this.isDeviceValid !== undefined
      ? !this.isDeviceValid(deviceKey)
      : false;
  }

  readonly handler: RouteHandler = async (req, res) => {
    const pathname = requestPath(req);
    if (pathname === WEB_SESSION_REDEEM_PATH) return this.redeem(req, res);
    if (pathname === WEB_CONTROL_PATH) {
      // A DELETE that cleared the bearer gate in `authorize()` (valid cookie
      // + matching Origin) is a logout; POST is the establish ceremony.
      if ((req.method ?? 'GET').toUpperCase() === 'DELETE') return this.logout(req, res);
      return this.establishControl(req, res);
    }
    const match = MINT_RE.exec(pathname);
    if (!match) return false;
    if ((req.method ?? 'GET') !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    const context = vaultContext();
    if (!context) {
      sendJson(res, 500, { error: 'vault_context_missing' });
      return true;
    }
    const shellOrigin = safeOrigin(req.headers.origin);
    if (!shellOrigin) {
      sendJson(res, 400, {
        error: 'origin_required',
        message: 'Browser sessions require an HTTP Origin.',
      });
      return true;
    }
    let appId: string;
    try {
      appId = decodeURIComponent(match[1] ?? '');
    } catch {
      sendJson(res, 400, { error: 'invalid_app_id' });
      return true;
    }
    let draftSessionId: string | undefined;
    try {
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      if (body) {
        const parsed = JSON.parse(body) as { draftSessionId?: unknown };
        if (parsed.draftSessionId !== undefined && typeof parsed.draftSessionId !== 'string') {
          throw new Error('invalid draft session');
        }
        draftSessionId = parsed.draftSessionId;
      }
    } catch {
      sendJson(res, 400, { error: 'malformed_request' });
      return true;
    }
    this.sweep();
    const code = crypto.randomBytes(32).toString('base64url');
    this.pending.set(code, {
      appId,
      vaultId: context.vaultId,
      ...(context.deviceKey ? { deviceKey: context.deviceKey } : {}),
      shellOrigin,
      ...(draftSessionId ? { draftSessionId } : {}),
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
    sendJson(res, 200, {
      launchPath: `${WEB_SESSION_REDEEM_PATH}?code=${encodeURIComponent(code)}`,
    });
    return true;
  };

  authorize(req: IncomingMessage): BearerAuthorization | undefined {
    this.sweep();
    const pathname = requestPath(req);
    const presented = cookies(req);
    if (pathname === WEB_CONTROL_PATH) {
      const origin = safeOrigin(req.headers.origin);
      const presentedToken = presented.get(CONTROL_COOKIE);
      const control =
        presentedToken !== undefined
          ? this.controlStore.find(hashControlToken(presentedToken))
          : undefined;
      if (!control || origin !== control.shellOrigin) return undefined;
      // A revoked device's cookie stops working immediately — evict the row.
      if (this.revoked(control.deviceKey)) {
        this.controlStore.remove(control.tokenHash);
        return undefined;
      }
      const target = new URL(req.url ?? '/', 'http://gateway.invalid').searchParams.get('path');
      // A DELETE straight to the control endpoint (no proxied `?path=`) is a
      // logout: leave the URL intact so `handler` performs the deletion and
      // expires the cookie; just clear the bearer gate here. A DELETE that
      // DOES carry a `?path=` is an ordinary proxied request (e.g. the shell
      // revoking a device via `DELETE /centraid/_gateway/devices/:id`) and
      // must fall through to the rewrite below — otherwise every DELETE API
      // call from the web shell would be swallowed as a control-session logout.
      if (!target) {
        if ((req.method ?? 'GET').toUpperCase() === 'DELETE') {
          return control.deviceKey
            ? { plane: 'device', deviceKey: control.deviceKey }
            : { plane: 'admin' };
        }
        return undefined;
      }
      if (!target.startsWith('/') || target.startsWith(WEB_CONTROL_PATH)) return undefined;
      // Extend the sliding idle window (throttled to an hourly disk write).
      this.controlStore.touch(control.tokenHash);
      req.url = target;
      req.headers[VAULT_HEADER] = control.vaultId;
      return control.deviceKey
        ? { plane: 'device', deviceKey: control.deviceKey }
        : { plane: 'admin' };
    }
    let session: ActiveSession | undefined;
    for (const [cookieName, token] of presented) {
      const candidate = this.activeByCookieName.get(cookieName);
      if (candidate && tokenMatches(token, candidate.token) && permits(candidate, pathname)) {
        session = candidate;
        break;
      }
    }
    if (!session) return undefined;
    // Revocation propagation for active app sessions (issue #376): a live
    // `__centraid_app_*` cookie whose device enrollment was revoked is dead.
    if (this.revoked(session.deviceKey)) {
      this.active.delete(session.token);
      this.activeByCookieName.delete(session.cookieName);
      return undefined;
    }
    // Origin-bind active app sessions. CORS is now credentialed and reflects
    // the request Origin, and `SameSite=Strict` isolates by site — NOT by port
    // — so a page on another port of the same host could otherwise ride the
    // `__centraid_app_*` cookie and read our responses. When an Origin header
    // is present, require it to match either the session's shellOrigin (the
    // PWA shell) or the gateway's own origin (same-origin app-iframe / API
    // requests, whose Origin host equals `req.headers.host`). We do NOT require
    // an Origin: same-origin GET subresources (direct-HTTP iframe mode) and
    // Iroh-bridge requests legitimately omit it, and must still pass on
    // cookie + path alone.
    const origin = safeOrigin(req.headers.origin);
    if (origin !== undefined) {
      const host = Array.isArray(req.headers.host) ? undefined : req.headers.host;
      let originHost: string | undefined;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = undefined;
      }
      const sameOriginAsGateway = host !== undefined && originHost === host;
      if (origin !== session.shellOrigin && !sameOriginAsGateway) return undefined;
    }
    req.headers[VAULT_HEADER] = session.vaultId;
    req.headers[WEB_APP_HEADER] = session.appId;
    req.headers[WEB_SHELL_ORIGIN_HEADER] = session.shellOrigin;
    return session.deviceKey
      ? { plane: 'device', deviceKey: session.deviceKey }
      : { plane: 'admin' };
  }

  private redeem(req: IncomingMessage, res: ServerResponse): Promise<true> {
    const code = new URL(req.url ?? '/', 'http://gateway.invalid').searchParams.get('code') ?? '';
    const pending = this.pending.get(code);
    this.pending.delete(code);
    if (!pending || pending.expiresAt <= Date.now()) {
      sendJson(res, 403, { error: 'web_session_invalid' });
      return Promise.resolve(true);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const cookieName = `__centraid_app_${crypto.randomBytes(8).toString('hex')}`;
    const session: ActiveSession = {
      ...pending,
      token,
      cookieName,
      expiresAt: this.now() + SESSION_TTL_MS,
    };
    this.active.set(token, session);
    this.activeByCookieName.set(cookieName, session);
    const forwarded = req.headers['x-forwarded-proto'];
    const secure = forwarded === 'https' ? '; Secure' : '';
    res.statusCode = 303;
    res.setHeader(
      'Set-Cookie',
      `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/centraid/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`,
    );
    const app = encodeURIComponent(pending.appId);
    const location = pending.draftSessionId
      ? `/centraid/_draft/${encodeURIComponent(pending.draftSessionId)}/${app}/`
      : `/centraid/${app}/`;
    res.setHeader('Location', location);
    res.end();
    return Promise.resolve(true);
  }

  private establishControl(req: IncomingMessage, res: ServerResponse): Promise<true> {
    if ((req.method ?? 'GET') !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return Promise.resolve(true);
    }
    const context = vaultContext();
    const shellOrigin = safeOrigin(req.headers.origin);
    if (!context || !shellOrigin) {
      sendJson(res, 400, { error: 'origin_required' });
      return Promise.resolve(true);
    }
    const token = crypto.randomBytes(32).toString('base64url');
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
    const forwarded = req.headers['x-forwarded-proto'];
    const secure = forwarded === 'https' ? '; Secure' : '';
    // Cookie `Max-Age` carries the ABSOLUTE 180-day wall; the server-side
    // idle window (30d, sliding) is the tighter bound enforced on authorize.
    res.setHeader(
      'Set-Cookie',
      `${CONTROL_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=${WEB_CONTROL_PATH}; Max-Age=${Math.floor(CONTROL_ABSOLUTE_TTL_MS / 1000)}${secure}`,
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
    if (presentedToken !== undefined) this.controlStore.remove(hashControlToken(presentedToken));
    const forwarded = req.headers['x-forwarded-proto'];
    const secure = forwarded === 'https' ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `${CONTROL_COOKIE}=; HttpOnly; SameSite=Strict; Path=${WEB_CONTROL_PATH}; Max-Age=0${secure}`,
    );
    sendJson(res, 200, { ok: true });
    return Promise.resolve(true);
  }

  private sweep(): void {
    const now = this.now();
    for (const [code, session] of this.pending)
      if (session.expiresAt <= now) this.pending.delete(code);
    for (const [token, session] of this.active) {
      if (session.expiresAt <= now) {
        this.active.delete(token);
        this.activeByCookieName.delete(session.cookieName);
      }
    }
    this.controlStore.sweepExpired();
  }
}
