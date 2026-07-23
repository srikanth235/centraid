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
 *   GET    /centraid/_vault/connections                    — list + health (never a secret cell)
 *   GET    /centraid/_vault/connections/providers          — BYO-client wizard presets (Google, Microsoft, GitHub, …)
 *   POST   /centraid/_vault/connections                    — configure a credential (sync.configure_credential)
 *   PATCH  /centraid/_vault/connections/<id>               — {status, note?} pause / resume
 *   DELETE /centraid/_vault/connections/<id>               — remove entirely (sync.remove_connection); 404
 *                                                             unknown id, 409 when undecided outbox items or
 *                                                             receipted sync history block the delete
 *   POST   /centraid/_vault/connections/<id>/authorize     — {redirect_uri?} → {auth_url, state}
 *   GET    /centraid/_vault/oauth/callback?state=&code=    — finish the ceremony (browser-facing HTML)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ROUTES } from '@centraid/protocol';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import type { VaultPlane } from '../serve/vault-plane.js';
import type { ConnectionBroker } from '../serve/connection-broker.js';
import { PROVIDER_PRESETS } from './connection-providers.js';
import { readJson, sendJson } from './route-helpers.js';
import {
  ASSIST_GOOGLE_AUTH_URL,
  ASSIST_GOOGLE_TOKEN_URL,
  GOOGLE_ASSIST_SCOPE_TIERS,
  assistCallbackUrl,
  assistScopes,
  type AssistOAuthConfig,
} from '../serve/assist-oauth.js';
import { vaultContext } from '../serve/vault-context.js';

const PREFIX = ROUTES.vaultConnections;
export const OAUTH_CALLBACK_PATH = ROUTES.vaultOAuthCallback;

/** Health + identity of one connection — everything EXCEPT secret cells. */
function listConnections(plane: VaultPlane): Record<string, unknown>[] {
  const rows = plane.db.vault
    .prepare(
      `SELECT c.connection_id, c.kind, c.label, c.principal, c.status, c.trust,
              c.created_at, c.last_run_at,
              cc.cred_kind, cc.oauth_mode, cc.provider, cc.scopes, cc.allowed_hosts,
              cc.token_expires_at,
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

async function invokeAsOwner(
  plane: VaultPlane,
  res: ServerResponse,
  command: string,
  input: Record<string, unknown>,
): Promise<void> {
  const outcome = await plane.invoke(plane.ownerCredential, {
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
  res.writeHead(ok ? 200 : 400, {
    'cache-control': 'no-store, max-age=0',
    'content-security-policy':
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'content-type': 'text/html; charset=utf-8',
    pragma: 'no-cache',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Centraid</title>` +
      `<main><h2>${ok ? 'Connected' : 'Not connected'}</h2>` +
      `<p>${escapeHtml(message)}</p>` +
      (ok ? `<p>You can close this window.</p>` : '') +
      `</main>`,
  );
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function makeConnectionsRouteHandler(
  vaults: VaultRegistry,
  broker: ConnectionBroker,
  assistOAuth?: AssistOAuthConfig,
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
        if (state) broker.cancelAuthorization({ state });
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
      sendJson(res, 200, {
        providers: PROVIDER_PRESETS,
        assist: assistOAuth
          ? {
              enabled: true,
              provider: 'google',
              callbackUrl: assistCallbackUrl(assistOAuth),
              restrictedScopesEnabled: assistOAuth.restrictedScopesEnabled,
              scopeTiers: GOOGLE_ASSIST_SCOPE_TIERS,
            }
          : { enabled: false },
      });
      return true;
    }

    // POST /connections/assist — configure with public shared-client
    // coordinates supplied by the gateway, never by the browser.
    if (segments.length === 1 && segments[0] === 'assist' && method === 'POST') {
      if (!assistOAuth) {
        sendJson(res, 503, { error: 'assist_not_configured' });
        return true;
      }
      const body = await readJson(req, 16 * 1024).catch(() => undefined);
      const label = typeof body?.label === 'string' ? body.label.trim() : '';
      const kind = typeof body?.kind === 'string' ? body.kind.trim() : '';
      const scopes =
        Array.isArray(body?.scopes) && body.scopes.every((scope) => typeof scope === 'string')
          ? (body.scopes as string[])
          : [];
      const google = PROVIDER_PRESETS.find((preset) => preset.id === 'google');
      const knownKind = google?.connectors.some((connector) => connector.kind === kind) === true;
      if (!label || !knownKind) {
        sendJson(res, 400, { error: 'invalid_assist_connection' });
        return true;
      }
      let approvedScopes: readonly string[];
      try {
        approvedScopes = assistScopes(scopes, assistOAuth);
        const connectorScopes = new Set(
          google?.connectors
            .filter((connector) => connector.kind === kind)
            .flatMap((connector) => (connector.scope ? [connector.scope] : [])),
        );
        if (approvedScopes.some((scope) => !connectorScopes.has(scope))) {
          throw new Error('requested Google scope does not belong to this connector');
        }
      } catch (err) {
        sendJson(res, 400, {
          error: 'invalid_assist_scopes',
          message: err instanceof Error ? err.message : String(err),
        });
        return true;
      }
      await invokeAsOwner(plane, res, 'sync.configure_credential', {
        kind,
        label,
        cred_kind: 'oauth2',
        oauth_mode: 'assist',
        provider: 'google',
        auth_url: ASSIST_GOOGLE_AUTH_URL,
        token_url: ASSIST_GOOGLE_TOKEN_URL,
        scopes: approvedScopes.join(' '),
        client_id: assistOAuth.googleClientId,
        allowed_hosts: google?.allowedHosts ?? [],
      });
      return true;
    }

    // POST /connections/assist/complete — authenticated courier handoff.
    if (
      segments.length === 2 &&
      segments[0] === 'assist' &&
      segments[1] === 'complete' &&
      method === 'POST'
    ) {
      const clientSessionId = clientSessionHeader(req);
      if (!clientSessionId) {
        sendJson(res, 400, { error: 'missing_client_session' });
        return true;
      }
      const body = await readJson(req, 16 * 1024).catch(() => undefined);
      const state = boundedString(body?.state, 128);
      const providerError = boundedString(body?.error, 128);
      if (!state) {
        sendJson(res, 400, { error: 'invalid_authorization_handoff' });
        return true;
      }
      const deviceKey = vaultContext()?.deviceKey;
      if (providerError) {
        broker.cancelAuthorization({ state, clientSessionId, deviceKey });
        sendJson(res, 400, {
          error: providerError === 'access_denied' ? 'access_denied' : 'provider_error',
          message:
            providerError === 'access_denied'
              ? 'You declined Google access. Start Connect again when ready.'
              : 'Google could not complete authorization. Start Connect again.',
        });
        return true;
      }
      const code = boundedString(body?.code, 4096);
      const receipt = boundedString(body?.receipt, 1024);
      if (!code || !receipt) {
        sendJson(res, 400, { error: 'invalid_authorization_handoff' });
        return true;
      }
      try {
        const completed = await broker.completeAssistAuthorization({
          state,
          code,
          receipt,
          clientSessionId,
          deviceKey,
        });
        sendJson(res, 200, { ok: true, connection_id: completed.connectionId });
      } catch (err) {
        sendJson(res, 400, {
          error: 'assist_authorization_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }

    // POST /connections — attach/detach a credential.
    if (segments.length === 0 && method === 'POST') {
      const body = await readJson(req).catch(() => undefined);
      if (!body) {
        sendJson(res, 400, { error: 'body must be JSON' });
        return true;
      }
      if (body.oauth_mode === 'assist') {
        sendJson(res, 400, {
          error: 'use_assist_configuration_route',
          message: 'Centraid Assist configuration is gateway-owned.',
        });
        return true;
      }
      await invokeAsOwner(plane, res, 'sync.configure_credential', body);
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
      await invokeAsOwner(plane, res, 'sync.set_connection_status', {
        connection_id: segments[0],
        status: body.status,
        ...(body.note ? { note: body.note } : {}),
      });
      return true;
    }

    // DELETE /connections/<id> — remove entirely (sync.remove_connection).
    // Checked for existence up front so an unknown id answers 404 rather
    // than folding into the command's generic refusal 409 — the two are
    // different problems (nothing to delete vs. won't delete this yet).
    if (segments.length === 1 && method === 'DELETE') {
      const connectionId = segments[0]!;
      const exists = plane.db.vault
        .prepare('SELECT 1 AS x FROM sync_connection WHERE connection_id = ?')
        .get(connectionId);
      if (!exists) {
        sendJson(res, 404, { error: `no such connection ${connectionId}` });
        return true;
      }
      const outcome = await plane.invoke(plane.ownerCredential, {
        command: 'sync.remove_connection',
        input: { connection_id: connectionId },
        purpose: 'dpv:ServiceProvision',
      });
      if (outcome.status === 'executed') {
        sendJson(res, 200, { ok: true, ...(outcome.output as Record<string, unknown>) });
        return true;
      }
      const reason = 'reason' in outcome ? outcome.reason : outcome.status;
      // A refused removal (undecided outbox items, or receipted sync
      // history) is a real state conflict, not a bad request — 409, mirroring
      // vault-routes.ts's outbox decide/revoke convention.
      sendJson(res, outcome.status === 'denied' ? 403 : 409, { ok: false, error: reason });
      return true;
    }

    // POST /connections/<id>/authorize — start the consent ceremony.
    if (segments.length === 2 && segments[1] === 'authorize' && method === 'POST') {
      const body = (await readJson(req).catch(() => undefined)) as
        | { redirect_uri?: string; surface?: 'desktop' | 'web' }
        | undefined;
      // The gateway's own callback is the default redirect: reachable when
      // the consenting browser can reach the gateway (loopback/desktop).
      const redirectUri =
        body?.redirect_uri ?? `http://${req.headers.host ?? '127.0.0.1'}${OAUTH_CALLBACK_PATH}`;
      try {
        const row = plane.db.vault
          .prepare(
            'SELECT oauth_mode FROM sync_connection_credential WHERE connection_id = ? AND cred_kind = ?',
          )
          .get(segments[0]!, 'oauth2') as { oauth_mode?: unknown } | undefined;
        const assist = row?.oauth_mode === 'assist';
        const ceremony = assist
          ? broker.beginAssistAuthorization({
              plane,
              connectionId: segments[0]!,
              clientSessionId: requireClientSession(req),
              deviceKey: vaultContext()?.deviceKey,
              surface: body?.surface === 'web' ? 'web' : 'desktop',
            })
          : broker.beginAuthorization(plane, segments[0]!, redirectUri);
        sendJson(res, 200, {
          auth_url: ceremony.authUrl,
          state: ceremony.state,
          redirect_uri: 'redirectUri' in ceremony ? ceremony.redirectUri : redirectUri,
        });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    sendJson(res, 404, { error: `no such connections route: ${method} ${url.pathname}` });
    return true;
  };
}

function clientSessionHeader(req: IncomingMessage): string | undefined {
  const raw = req.headers['x-centraid-client-session'];
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(raw)) return undefined;
  return raw;
}

function requireClientSession(req: IncomingMessage): string {
  const value = clientSessionHeader(req);
  if (!value) throw new Error('missing or invalid client session');
  return value;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}
