/*
 * HTTP client for the centraid user-store routes exposed under
 * `/_centraid-user`. The gateway owns a single shared SQLite that holds:
 *   - the single user UUID (generated on first read — cross-device-stable)
 *   - global user preferences keyed by string keys
 *
 * The client is intentionally thin: it shapes URLs, attaches the bearer
 * token, and JSON-decodes. Auth resolution is cached for the process
 * lifetime since `loadSettings()` reads from disk and the renderer fires
 * one prefs-fetch per launch plus a write per slider drag — both happen
 * often enough to be worth coalescing. `resetUserPrefsAuthCache()` is
 * called from settings-save when the gateway URL/token may have flipped.
 */

import { loadSettings } from './settings.js';

interface AuthCache {
  baseUrl: string;
  headers: Record<string, string>;
}
let cachedAuth: AuthCache | undefined;
let inflightAuth: Promise<AuthCache> | undefined;

async function authHeaders(): Promise<AuthCache> {
  if (cachedAuth) return cachedAuth;
  if (!inflightAuth) {
    inflightAuth = (async () => {
      const settings = await loadSettings();
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (settings.gatewayToken) headers.authorization = `Bearer ${settings.gatewayToken}`;
      const next: AuthCache = {
        baseUrl: settings.gatewayUrl.replace(/\/$/, ''),
        headers,
      };
      cachedAuth = next;
      return next;
    })().finally(() => {
      inflightAuth = undefined;
    });
  }
  return inflightAuth;
}

export function resetUserPrefsAuthCache(): void {
  cachedAuth = undefined;
}

async function call<T>(method: string, sub: string, body?: unknown): Promise<T> {
  const { baseUrl, headers } = await authHeaders();
  const url = `${baseUrl}/_centraid-user${sub}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const msg =
      (parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : undefined) ?? `user-prefs HTTP ${res.status}`;
    throw new Error(msg);
  }
  return parsed as T;
}

// The renderer now reads user id + prefs and writes prefs directly over
// HTTP (renderer/gateway-client.ts) under the thin-client pivot. Only the
// main process's internal prefs read for the runner-preflight loader
// (`loadRunnerPrefs` in ipc.ts) still goes through here.
export async function fetchUserPrefs(): Promise<Record<string, unknown>> {
  const out = await call<{ prefs: Record<string, unknown> }>('GET', '/prefs');
  return out.prefs ?? {};
}
