/*
 * HTTP client for the centraid chat routes exposed under `/_centraid-conversations`.
 * The gateway owns the chat sessions — see
 * packages/app-engine/src/conversation-history.ts. A chat session IS the chat
 * window: the session id is the window id. Chat is app-scoped (issue
 * #98): every call carries the owning app and the session lives in that
 * app's `runtime.sqlite`. The transcript is reconstructed from the run
 * ledger; there is no append surface.
 *
 * The client is thin on purpose: it shapes URLs, attaches the bearer token,
 * and JSON-decodes. Auth resolution is cached for the process lifetime.
 * Callers can invalidate via `resetConversationHistoryAuthCache()` after a settings
 * save flips the gateway URL or token.
 */

import { loadSettings } from './settings.js';

export interface ConversationSummary {
  id: string;
  title: string;
  /** Runner kind that owns `adapterSessionId`. */
  adapterKind: string | null;
  /** Opaque per-runner resume handle. */
  adapterSessionId: string | null;
  /** Number of completed turns. */
  turnCount: number;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface ConversationWithMessages extends ConversationSummary {
  messages: Array<{ idx: number; payload: unknown; createdAt: number }>;
}

interface AuthCache {
  baseUrl: string;
  headers: Record<string, string>;
}
let cachedAuth: AuthCache | undefined;
let inflightAuth: Promise<AuthCache> | undefined;

async function authHeaders(): Promise<AuthCache> {
  if (cachedAuth) return cachedAuth;
  // Coalesce concurrent first-time callers so we only read settings once.
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

/** Called from settings-save when gatewayUrl/Token may have changed. */
export function resetConversationHistoryAuthCache(): void {
  cachedAuth = undefined;
}

async function call<T>(method: string, pathAndQuery: string, body?: unknown): Promise<T> {
  const { baseUrl, headers } = await authHeaders();
  const url = `${baseUrl}/_centraid-conversations${pathAndQuery}`;
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
        : undefined) ?? `conversation-history HTTP ${res.status}`;
    throw new Error(msg);
  }
  return parsed as T;
}

/** Chat is app-scoped (issue #98) — every call carries the owning app. */
function sessionsPath(appId: string): string {
  return `/apps/${encodeURIComponent(appId)}/sessions`;
}

export async function historyList(appId: string): Promise<ConversationSummary[]> {
  const out = await call<{ sessions: ConversationSummary[] }>('GET', sessionsPath(appId));
  return out.sessions ?? [];
}

export async function historyCreate(appId: string, title = ''): Promise<ConversationSummary> {
  return call<ConversationSummary>('POST', sessionsPath(appId), { title });
}

export async function historyLoad(appId: string, id: string): Promise<ConversationWithMessages> {
  return call<ConversationWithMessages>('GET', `${sessionsPath(appId)}/${encodeURIComponent(id)}`);
}

export async function historyRename(
  appId: string,
  id: string,
  title: string,
): Promise<ConversationSummary> {
  return call<ConversationSummary>('PATCH', `${sessionsPath(appId)}/${encodeURIComponent(id)}`, {
    title,
  });
}

export async function historyDelete(appId: string, id: string): Promise<{ ok: boolean }> {
  return call<{ ok: boolean }>('DELETE', `${sessionsPath(appId)}/${encodeURIComponent(id)}`);
}
