/*
 * HTTP client for the centraid chat routes exposed under `/_centraid-chat`.
 * The gateway owns the chat sessions in the activity SQLite — see
 * packages/runtime-core/src/chat-history.ts. A chat session IS the chat
 * window: the session id is the window id. Chat is a flat per-user store
 * (no app scoping). The transcript is reconstructed from the run ledger;
 * there is no append surface.
 *
 * The client is thin on purpose: it shapes URLs, attaches the bearer token,
 * and JSON-decodes. Auth resolution is cached for the process lifetime.
 * Callers can invalidate via `resetChatHistoryAuthCache()` after a settings
 * save flips the gateway URL or token.
 */

import { loadSettings } from './settings.js';

export interface ChatSessionMeta {
  id: string;
  title: string;
  /** Sticky chat mode. */
  mode: 'full' | 'data';
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

export interface ChatSessionWithMessages extends ChatSessionMeta {
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
export function resetChatHistoryAuthCache(): void {
  cachedAuth = undefined;
}

async function call<T>(method: string, pathAndQuery: string, body?: unknown): Promise<T> {
  const { baseUrl, headers } = await authHeaders();
  const url = `${baseUrl}/_centraid-chat${pathAndQuery}`;
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
        : undefined) ?? `chat-history HTTP ${res.status}`;
    throw new Error(msg);
  }
  return parsed as T;
}

export async function historyList(): Promise<ChatSessionMeta[]> {
  const out = await call<{ sessions: ChatSessionMeta[] }>('GET', '/sessions');
  return out.sessions ?? [];
}

export async function historyCreate(mode: 'full' | 'data', title = ''): Promise<ChatSessionMeta> {
  return call<ChatSessionMeta>('POST', '/sessions', { mode, title });
}

export async function historyLoad(id: string): Promise<ChatSessionWithMessages> {
  return call<ChatSessionWithMessages>('GET', `/sessions/${encodeURIComponent(id)}`);
}

export async function historyRename(id: string, title: string): Promise<ChatSessionMeta> {
  return call<ChatSessionMeta>('PATCH', `/sessions/${encodeURIComponent(id)}`, { title });
}

export async function historyDelete(id: string): Promise<{ ok: boolean }> {
  return call<{ ok: boolean }>('DELETE', `/sessions/${encodeURIComponent(id)}`);
}
