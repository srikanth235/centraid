/*
 * Connections routes (issue #304) — the owner surface over broker-carried
 * credentials and connection health. Everything except the OAuth callback
 * is an OWNER act behind the gateway's bearer auth, executed with the
 * owner-device credential through the registered sync commands (receipted,
 * sealed, journal-redacted). The callback is the ONE bearer-free path
 * (`publicPaths` on the http server): a provider redirects the owner's
 * browser here, and the request authenticates by its single-use `state`
 * capability instead.
 *
 *   GET   /centraid/_vault/connections                    — list + health (never a secret cell)
 *   GET   /centraid/_vault/connections/providers          — BYO-client wizard presets (Google, GitHub…)
 *   POST  /centraid/_vault/connections                    — configure a credential (sync.configure_credential)
 *   PATCH /centraid/_vault/connections/<id>               — {status, note?} pause / resume
 *   POST  /centraid/_vault/connections/<id>/authorize     — {redirect_uri?} → {auth_url, state}
 *   GET   /centraid/_vault/oauth/callback?state=&code=    — finish the ceremony (browser-facing HTML)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import type { VaultPlane } from '../serve/vault-plane.js';
import type { ConnectionBroker } from '../serve/connection-broker.js';
import { PROVIDER_PRESETS } from './connection-providers.js';
import { readJson, sendJson } from './route-helpers.js';

const PREFIX = '/centraid/_vault/connections';
export const OAUTH_CALLBACK_PATH = '/centraid/_vault/oauth/callback';

/** Health + identity of one connection — everything EXCEPT secret cells. */
function listConnections(plane: VaultPlane): Record<string, unknown>[] {
  const rows = plane.db.vault
    .prepare(
      `SELECT c.connection_id, c.kind, c.label, c.principal, c.status, c.trust,
              c.created_at, c.last_run_at,
              cc.cred_kind, cc.provider, cc.scopes, cc.allowed_hosts, cc.token_expires_at,
              cc.refresh_token IS NOT NULL AS has_refresh_token,
              h.auth_note
         FROM sync_connection c
         LEFT JOIN sync_connection_credential cc ON cc.connection_id = c.connection_id
         LEFT JOIN sync_connection_health h ON h.connection_id = c.connection_id
        ORDER BY c.created_at DESC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    ...r,
    has_refresh_token: r.has_refresh_token === 1,
    allowed_hosts:
      typeof r.allowed_hosts === 'string' ? (JSON.parse(r.allowed_hosts) as string[]) : null,
  }));
}

function invokeAsOwner(
  plane: VaultPlane,
  res: ServerResponse,
  command: string,
  input: Record<string, unknown>,
): void {
  const outcome = plane.gateway.invoke(plane.ownerCredential, {
    command,
    input,
    purpose: 'dpv:ServiceProvision',
  });
  if (outcome.status === 'executed') {
    sendJson(res, 200, { ok: true, ...(outcome.output as Record<string, unknown>) });
    return;
  }
  const reason = 'reason' in outcome ? outcome.reason : outcome.status;
  sendJson(res, outcome.status === 'denied' ? 403 : 400, { ok: false, error: reason });
}

/** The browser-facing ceremony end: tiny self-contained HTML, no assets. */
function sendCeremonyHtml(res: ServerResponse, ok: boolean, message: string): void {
  res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Centraid</title>` +
      `<body style="font-family:system-ui;display:grid;place-items:center;height:90vh;margin:0">` +
      `<div style="text-align:center;max-width:26rem"><h2>${ok ? 'Connected' : 'Not connected'}</h2>` +
      `<p>${escapeHtml(message)}</p>` +
      (ok ? `<p style="color:#666">You can close this window.</p>` : '') +
      `</div></body>`,
  );
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function makeConnectionsRouteHandler(
  vaults: VaultRegistry,
  broker: ConnectionBroker,
): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    const method = req.method ?? 'GET';

    // The bearer-free ceremony end — authenticated by its single-use state.
    if (url.pathname === OAUTH_CALLBACK_PATH && method === 'GET') {
      const state = url.searchParams.get('state') ?? '';
      const code = url.searchParams.get('code');
      const providerError = url.searchParams.get('error');
      if (providerError || !code) {
        // Consume the state so a denied ceremony cannot be replayed.
        if (state) await broker.completeAuthorization(state, '').catch(() => undefined);
        sendCeremonyHtml(
          res,
          false,
          providerError === 'access_denied'
            ? 'You declined the consent screen. Start Connect again when ready.'
            : `The provider answered with an error: ${providerError ?? 'missing code'}.`,
        );
        return true;
      }
      try {
        await broker.completeAuthorization(state, code);
        sendCeremonyHtml(res, true, 'The connection is authorized and live.');
      } catch (err) {
        sendCeremonyHtml(res, false, err instanceof Error ? err.message : String(err));
      }
      return true;
    }

    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    const rest = url.pathname.slice(PREFIX.length).replace(/^\//, '');
    const segments = rest === '' ? [] : rest.split('/').map(decodeURIComponent);

    let plane: VaultPlane;
    try {
      plane = vaults.current();
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }

    // GET /connections — the health surface: status, why, freshness.
    if (segments.length === 0 && method === 'GET') {
      sendJson(res, 200, { connections: listConnections(plane) });
      return true;
    }

    // GET /connections/providers — the BYO-client wizard content.
    if (segments.length === 1 && segments[0] === 'providers' && method === 'GET') {
      sendJson(res, 200, { providers: PROVIDER_PRESETS });
      return true;
    }

    // POST /connections — attach/detach a credential.
    if (segments.length === 0 && method === 'POST') {
      const body = await readJson(req).catch(() => undefined);
      if (!body) {
        sendJson(res, 400, { error: 'body must be JSON' });
        return true;
      }
      invokeAsOwner(plane, res, 'sync.configure_credential', body);
      return true;
    }

    // PATCH /connections/<id> — pause / resume.
    if (segments.length === 1 && method === 'PATCH') {
      const body = (await readJson(req).catch(() => undefined)) as
        | { status?: string; note?: string }
        | undefined;
      if (!body?.status) {
        sendJson(res, 400, { error: 'body must carry {status}' });
        return true;
      }
      invokeAsOwner(plane, res, 'sync.set_connection_status', {
        connection_id: segments[0],
        status: body.status,
        ...(body.note ? { note: body.note } : {}),
      });
      return true;
    }

    // POST /connections/<id>/authorize — start the consent ceremony.
    if (segments.length === 2 && segments[1] === 'authorize' && method === 'POST') {
      const body = (await readJson(req).catch(() => undefined)) as
        | { redirect_uri?: string }
        | undefined;
      // The gateway's own callback is the default redirect: reachable when
      // the consenting browser can reach the gateway (loopback/desktop).
      const redirectUri =
        body?.redirect_uri ?? `http://${req.headers.host ?? '127.0.0.1'}${OAUTH_CALLBACK_PATH}`;
      try {
        const ceremony = broker.beginAuthorization(plane, segments[0]!, redirectUri);
        sendJson(res, 200, { auth_url: ceremony.authUrl, state: ceremony.state, redirect_uri: redirectUri });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    sendJson(res, 404, { error: `no such connections route: ${method} ${url.pathname}` });
    return true;
  };
}
