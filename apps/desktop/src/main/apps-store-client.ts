/*
 * HTTP client for the gateway's git-store editing + publish surface
 * (issue #137), exposed under `/centraid/_apps`. Replaces the desktop's
 * direct `workspaceDir` reads/writes + tarball publish: the gateway now
 * owns drafted code as a git store, so the desktop is a thin client
 * that opens a session, writes draft files into the session worktree,
 * and publishes — all over HTTP against the active gateway (local or
 * remote, identical wire protocol).
 *
 * Same thin-client + cached-auth shape as `user-prefs-client.ts`.
 * `resetAppsStoreAuthCache()` is called from settings-save when the
 * gateway URL/token may have flipped.
 */

import { loadSettings } from './settings.js';

interface AuthCache {
  baseUrl: string;
  token: string | undefined;
  /** The vault the client addresses (issue #289) — `x-centraid-vault`. */
  vaultId: string | undefined;
}
let cachedAuth: AuthCache | undefined;
let inflightAuth: Promise<AuthCache> | undefined;

async function auth(): Promise<AuthCache> {
  if (cachedAuth) return cachedAuth;
  if (!inflightAuth) {
    inflightAuth = (async () => {
      const settings = await loadSettings();
      const next: AuthCache = {
        baseUrl: settings.gatewayUrl.replace(/\/$/, ''),
        token: settings.gatewayToken || undefined,
        vaultId: settings.activeVaultId || undefined,
      };
      cachedAuth = next;
      return next;
    })().finally(() => {
      inflightAuth = undefined;
    });
  }
  return inflightAuth;
}

export function resetAppsStoreAuthCache(): void {
  cachedAuth = undefined;
}

function headers(token: string | undefined, contentType?: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (contentType) h['content-type'] = contentType;
  // The addressed vault (issue #289): `auth()` is always awaited before any
  // `headers()` call, so the cache carries the current vault id.
  if (cachedAuth?.vaultId) h['x-centraid-vault'] = cachedAuth.vaultId;
  return h;
}

async function parse<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const msg =
      parsed && typeof parsed === 'object' && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `${label} HTTP ${res.status}`;
    throw new Error(msg);
  }
  return parsed as T;
}

/** Open (or reuse) an editing session; returns the session id. */
export async function openSession(sessionId?: string): Promise<string> {
  const { baseUrl, token } = await auth();
  const res = await fetch(`${baseUrl}/centraid/_apps/_sessions`, {
    method: 'POST',
    headers: headers(token, 'application/json'),
    body: JSON.stringify(sessionId ? { sessionId } : {}),
  });
  const out = await parse<{ sessionId: string }>(res, 'open-session');
  return out.sessionId;
}
