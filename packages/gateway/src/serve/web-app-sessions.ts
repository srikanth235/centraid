import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BearerAuthorization } from '@centraid/app-engine';
import { sendJson } from '../routes/route-helpers.js';
import { vaultContext, VAULT_HEADER } from './vault-context.js';
import type { RouteHandler } from './build-gateway.js';

export const WEB_SESSION_REDEEM_PATH = '/centraid/_web/session';
export const WEB_CONTROL_PATH = '/centraid/_web/control';
export const WEB_APP_HEADER = 'x-centraid-web-app';
export const WEB_SHELL_ORIGIN_HEADER = 'x-centraid-web-shell-origin';

const MINT_RE = /^\/centraid\/_apps\/([^/]+)\/web-session$/;
const PENDING_TTL_MS = 60_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

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

interface ControlSession {
  token: string;
  cookieName: string;
  vaultId: string;
  deviceKey?: string;
  shellOrigin: string;
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
  return pathname.startsWith('/centraid/_tool/');
}

export class WebAppSessions {
  private readonly pending = new Map<string, PendingSession>();
  private readonly active = new Map<string, ActiveSession>();
  private readonly controls = new Map<string, ControlSession>();

  readonly handler: RouteHandler = async (req, res) => {
    const pathname = requestPath(req);
    if (pathname === WEB_SESSION_REDEEM_PATH) return this.redeem(req, res);
    if (pathname === WEB_CONTROL_PATH) return this.establishControl(req, res);
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
      const control = [...this.controls.values()].find(
        (candidate) =>
          presented.get(candidate.cookieName) === candidate.token &&
          origin === candidate.shellOrigin,
      );
      if (!control) return undefined;
      const target = new URL(req.url ?? '/', 'http://gateway.invalid').searchParams.get('path');
      if (!target || !target.startsWith('/') || target.startsWith(WEB_CONTROL_PATH))
        return undefined;
      req.url = target;
      req.headers[VAULT_HEADER] = control.vaultId;
      return control.deviceKey
        ? { plane: 'device', deviceKey: control.deviceKey }
        : { plane: 'admin' };
    }
    const session = [...this.active.values()].find(
      (candidate) =>
        presented.get(candidate.cookieName) === candidate.token && permits(candidate, pathname),
    );
    if (!session) return undefined;
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
    this.active.set(token, {
      ...pending,
      token,
      cookieName,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
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
    const cookieName = '__centraid_control';
    this.controls.clear();
    this.controls.set(token, {
      token,
      cookieName,
      vaultId: context.vaultId,
      ...(context.deviceKey ? { deviceKey: context.deviceKey } : {}),
      shellOrigin,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    const forwarded = req.headers['x-forwarded-proto'];
    const secure = forwarded === 'https' ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=${WEB_CONTROL_PATH}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`,
    );
    sendJson(res, 200, { ok: true, vaultId: context.vaultId });
    return Promise.resolve(true);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [code, session] of this.pending)
      if (session.expiresAt <= now) this.pending.delete(code);
    for (const [token, session] of this.active)
      if (session.expiresAt <= now) this.active.delete(token);
    for (const [token, session] of this.controls)
      if (session.expiresAt <= now) this.controls.delete(token);
  }
}
