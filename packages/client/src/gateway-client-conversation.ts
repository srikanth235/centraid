/*
 * Renderer-side unified chat transport over direct HTTP (issue #141,
 * Phase 3). The chat panel used to relay through the desktop main process
 * (`main/chat.ts` + the `centraid:chat:*` IPC); it now talks to the gateway
 * directly:
 *
 *   - `streamTurn` POSTs `/centraid/<appId>/_turn` and parses the SSE stream
 *     into the gateway's native `TurnStreamEvent`s (fetch + ReadableStream
 *     reader, not `EventSource` — we need a POST body + the Bearer header).
 *     The gateway-side runner (Phase 3a `makeUnifiedConversationRunner`) runs the
 *     turn in the app's draft worktree with the union of tools, so one turn
 *     can both tweak the app's code and operate its data.
 *   - the chat-history surface (`/_centraid-conversations/apps/<appId>/sessions…`)
 *     mirrors the old `main/conversation-history-client.ts`: list / create / load /
 *     rename / delete, used to persist + resume conversations.
 *
 * Re-exported from `gateway-client.ts` so call sites import from one barrel.
 */

import { auth, authHeaders, doFetch, readJson, GatewayClientError } from './gateway-client-core.js';
import type { CentraidAgentsStatus, CentraidRunnerStatus } from './centraid-api.js';
// Shared chat-client core (issue #420): the ONE SSE parser + wire-route
// builders + the documented TurnStreamEvent union, from the canonical kit copy.
import { consumeSse } from '@centraid/blueprints/kit/turn-stream.js';
import type { TurnStreamEvent } from '@centraid/blueprints/kit/turn-stream.js';
import {
  appTurnPath,
  assistantTurnPath,
  resolvePath,
  conversationsPath,
  conversationPath,
  conversationSearchPath,
  conversationStatusPath,
  blobsPath,
} from '@centraid/blueprints/kit/conversation-client.js';

// Re-exported so every consumer keeps importing the union from this barrel; the
// definition now lives in one place (the wire contract, turn-stream.d.ts).
export type { TurnStreamEvent };

/**
 * Runner preflight + model catalog from the ACTIVE gateway. Reads the
 * gateway's own `GET /centraid/_turn/runner-status` — so a remote gateway
 * reports its own configured runner and models, and the chat picker
 * can list them.
 */
export async function getRunnerStatus(
  opts: { refresh?: boolean } = {},
): Promise<CentraidRunnerStatus> {
  const { baseUrl, token } = await auth();
  const path = opts.refresh
    ? '/centraid/_turn/runner-status?refresh=1'
    : '/centraid/_turn/runner-status';
  const res = await doFetch(baseUrl, path, {
    method: 'GET',
    headers: authHeaders(token),
  });
  return readJson<CentraidRunnerStatus>(res, 'fetch runner status');
}

/**
 * Which coding-agent credentials are present on the ACTIVE gateway's host.
 * Reads the gateway's `GET /centraid/_agents/status` — detection lives
 * beside the runner, so a remote gateway reports its own host's agents
 * rather than whatever is installed on the desktop.
 */
export async function getAgentsStatus(
  opts: { refresh?: boolean; refreshTools?: boolean } = {},
): Promise<CentraidAgentsStatus> {
  const { baseUrl, token } = await auth();
  // `?refresh=1` re-enumerates each agent's models (issue #188);
  // `?refreshTools=1` re-probes each agent's tools (slower — spawns a CLI), so
  // it's a separate flag/button. A plain load returns the catalog cache.
  const params = new URLSearchParams();
  if (opts.refresh) params.set('refresh', '1');
  if (opts.refreshTools) params.set('refreshTools', '1');
  const qs = params.toString();
  const path = qs ? `/centraid/_agents/status?${qs}` : '/centraid/_agents/status';
  const res = await doFetch(baseUrl, path, {
    method: 'GET',
    headers: authHeaders(token),
  });
  return readJson<CentraidAgentsStatus>(res, 'fetch agents status');
}

/** An attachment already uploaded to the blob CAS, referenced on the next turn. */
export interface ConversationAttachmentRef {
  hash: string;
  mime: string;
  sizeBytes: number;
  filename?: string;
}

/** The gateway's per-file cap on `uploadConversationAttachment` (issue #190). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface StreamTurnInput {
  /** The chat session id the gateway keys the turn on. */
  conversationId: string;
  message: string;
  /**
   * Chat register (issue #286 phase 2): 'ask' = the app copilot ("operate/
   * ask about my data") — the gateway routes vault-backed apps' ask turns
   * onto the vault register. Absent = builder chat (unchanged).
   */
  register?: 'ask' | 'build';
  model?: string;
  thinking?: string;
  /** Files uploaded ahead of the turn (issue #190). */
  attachments?: ConversationAttachmentRef[];
  /** Regenerate: the turn id this turn re-runs (issue #420). Recorded as
   *  `turns.retry_of` so the transcript collapses it into a sibling pager. */
  retryOf?: string;
  /**
   * Idempotency key (issue #420). A fresh UUID per user send, REUSED on every
   * automatic/one-tap resend of the same message — so a retry-after-network-blip
   * replays the already-recorded turn instead of double-running it.
   */
  idempotencyKey?: string;
}

/** Result of a driven turn: whether the stream ended cleanly server-side. */
export interface StreamTurnResult {
  /** True when the terminal `event: end` arrived; false on a mid-turn drop. */
  ended: boolean;
}

/** Bounded auto-retries on a `429` turn-busy before surfacing the error. */
const TURN_BUSY_MAX_RETRIES = 4;

/** Sleep helper for the bounded 429 backoff. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST a `_turn` body, transparently auto-retrying a `429` turn-busy up to
 * `TURN_BUSY_MAX_RETRIES` times honoring `Retry-After` (issue #420). Because the
 * body carries a stable `idempotencyKey`, a retry can only ever replay — never
 * double-run. Returns the OK streaming `Response`; throws `GatewayClientError`
 * on a non-429 failure or once retries are exhausted.
 */
async function postTurnWithRetry(
  path: string,
  body: string,
  signal: AbortSignal,
  errLabel: string,
): Promise<Response> {
  const { baseUrl, token } = await auth();
  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(baseUrl, path, {
      method: 'POST',
      headers: authHeaders(token, 'application/json'),
      body,
      signal,
    });
    if (res.status === 429 && attempt < TURN_BUSY_MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 3000;
      await res.body?.cancel().catch(() => undefined);
      await delay(waitMs);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        throw new GatewayClientError(
          'auth_required',
          `${errLabel}: gateway rejected request (HTTP ${res.status}).`,
        );
      }
      if (res.status === 429) {
        throw new GatewayClientError(
          'gateway_error',
          `${errLabel}: still busy after ${TURN_BUSY_MAX_RETRIES} retries — try again shortly.`,
        );
      }
      throw new GatewayClientError(
        'gateway_error',
        `${errLabel} failed (HTTP ${res.status}): ${text || res.statusText}`,
      );
    }
    if (!res.body)
      throw new GatewayClientError(
        'gateway_error',
        `${errLabel}: gateway returned no stream body.`,
      );
    return res;
  }
}

/**
 * Upload one file to the app's blob CAS ahead of a chat turn
 * (`POST /_centraid-conversations/apps/<appId>/blobs`). Returns the dedup-keyed ref the
 * caller threads into `streamTurn({ attachments })` (issue #190).
 */
export async function uploadConversationAttachment(
  appId: string,
  bytes: Uint8Array,
  mime: string,
  filename?: string,
): Promise<ConversationAttachmentRef> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, blobsPath(appId), {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': mime },
    body: bytes as BodyInit,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new GatewayClientError('gateway_error', `upload failed (HTTP ${res.status}): ${text}`);
  }
  const out = (await res.json()) as { hash: string; sizeBytes: number };
  return { hash: out.hash, mime, sizeBytes: out.sizeBytes, ...(filename ? { filename } : {}) };
}

/**
 * Drive one chat turn against `POST /centraid/<appId>/_turn`, invoking
 * `onEvent` for each parsed `TurnStreamEvent`. Resolves when the stream ends
 * (the gateway's `event: end` frame / connection close). Pass an
 * `AbortSignal` to cancel the in-flight turn (Stop button / panel teardown).
 */
export async function streamTurn(
  appId: string,
  input: StreamTurnInput,
  onEvent: (event: TurnStreamEvent) => void,
  signal: AbortSignal,
): Promise<StreamTurnResult> {
  const res = await postTurnWithRetry(
    appTurnPath(appId),
    JSON.stringify({
      conversationId: input.conversationId,
      message: input.message,
      ...(input.register ? { register: input.register } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinking ? { thinking: input.thinking } : {}),
      ...(input.retryOf ? { retryOf: input.retryOf } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    }),
    signal,
    'chat',
  );
  // `res.body` is guaranteed by postTurnWithRetry.
  return consumeSse(res.body!, onEvent, { signal });
}

// ───────────────────────── vault assistant ─────────────────────

/**
 * The vault assistant's reserved conversation scope (mirrors app-engine's
 * `ASSISTANT_APP_ID`). Its threads ride the same `/_centraid-conversations`
 * CRUD as app chats — list/create/load/rename/delete all take this id.
 */
export const ASSISTANT_APP_ID = '_assistant';

/** A minimal renderable entity card resolved from an answer's @-ref. */
export interface AssistantRefCard {
  type: string;
  id: string;
  status: 'live' | 'trashed' | 'missing' | 'denied' | 'unknown';
  title: string | null;
  subtitle: string | null;
}

/**
 * Drive one vault-assistant turn against the shell-level
 * `POST /centraid/_vault/assistant/_turn` (same SSE grammar as app chat).
 */
export async function streamAssistantTurn(
  input: StreamTurnInput,
  onEvent: (event: TurnStreamEvent) => void,
  signal: AbortSignal,
): Promise<StreamTurnResult> {
  const res = await postTurnWithRetry(
    assistantTurnPath(),
    JSON.stringify({
      conversationId: input.conversationId,
      message: input.message,
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinking ? { thinking: input.thinking } : {}),
      ...(input.retryOf ? { retryOf: input.retryOf } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    }),
    signal,
    'assistant',
  );
  return consumeSse(res.body!, onEvent, { signal });
}

/**
 * Poll a conversation's turn-settle status (issue #420) — cheap enough to loop
 * during reconnect catch-up. Returns the current `turnCount` so the caller can
 * detect a turn landing server-side after a dropped stream.
 */
export async function conversationStatus(
  appId: string,
  sessionId: string,
): Promise<{ turnCount: number; updatedAt: number }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, conversationStatusPath(appId, sessionId), {
    method: 'GET',
    headers: authHeaders(token),
  });
  return readJson(res, 'conversation status');
}

/** Resolve answer refs (`ref:type/id`) to renderable entity cards. */
export async function resolveAssistantRefs(
  refs: Array<{ type: string; id: string }>,
): Promise<AssistantRefCard[]> {
  if (refs.length === 0) return [];
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, resolvePath(), {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ refs }),
  });
  const out = await readJson<{ cards: AssistantRefCard[] }>(res, 'resolve assistant refs');
  return out.cards ?? [];
}

// ───────────────────────── chat history ─────────────────────
// Routes single-sourced in @centraid/blueprints/kit/conversation-client.js (#420).

/** List this app's persisted chat sessions, newest first. */
export async function listConversations(appId: string): Promise<CentraidConversationSummary[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, conversationsPath(appId), {
    method: 'GET',
    headers: authHeaders(token),
  });
  const out = await readJson<{ sessions: CentraidConversationSummary[] }>(res, 'list chats');
  return out.sessions ?? [];
}

/** Create a fresh chat session row (the chat session id the turn streams to). */
export async function createConversation(
  appId: string,
  title = '',
): Promise<CentraidConversationSummary> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, conversationsPath(appId), {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ title }),
  });
  return readJson<CentraidConversationSummary>(res, 'create chat');
}

/**
 * Fetch an attachment blob's bytes (auth-aware) and return an object URL for an
 * inline `<img>` thumbnail (issue #420, Wave 2). The blob GET route lives behind
 * the same bearer auth as the rest of the conversation surface, so an `<img
 * src>` cannot carry it — we fetch the bytes and mint a local object URL. The
 * caller must `URL.revokeObjectURL` it when the image unmounts.
 */
export async function fetchAssistantAttachmentUrl(
  appId: string,
  hash: string,
  mime: string,
): Promise<string> {
  const { baseUrl, token } = await auth();
  const path = `${blobsPath(appId)}/${encodeURIComponent(hash)}?mime=${encodeURIComponent(mime)}`;
  const res = await doFetch(baseUrl, path, { method: 'GET', headers: authHeaders(token) });
  if (!res.ok) {
    throw new GatewayClientError('gateway_error', `attachment fetch failed (HTTP ${res.status})`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/**
 * Load one chat session with its reconstructed transcript. When cold ranges
 * were archived + custody-gated-pruned (issue #438 wave 3), the server merges
 * them back read-only: `hasArchivedHistory` flags that some messages carry
 * `fromArchive`, and `archiveUnavailable` flags that a segment blob couldn't be
 * fetched (the render is the live rows only).
 */
export async function loadConversation(
  appId: string,
  sessionId: string,
): Promise<
  CentraidConversationSummary & {
    messages: Array<{
      idx: number;
      payload: CentraidConversationHistoryMessage;
      createdAt: number;
    }>;
    hasArchivedHistory?: boolean;
    archivedTurnCount?: number;
    archiveUnavailable?: boolean;
  }
> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, conversationPath(appId, sessionId), {
    method: 'GET',
    headers: authHeaders(token),
  });
  return readJson(res, 'load chat');
}

/** Rename a chat session. */
export async function renameConversation(
  appId: string,
  sessionId: string,
  title: string,
): Promise<void> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, conversationPath(appId, sessionId), {
    method: 'PATCH',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ title }),
  });
  await readJson(res, 'rename chat');
}

/**
 * FTS search over this app's chat sessions — titles + inbound message text
 * (issue #420). Powers the ⌘K palette's "Conversations" category. Each hit
 * carries a highlighted `snippet` for match context; archived threads are
 * excluded server-side.
 */
export async function searchConversations(
  appId: string,
  query: string,
  limit = 20,
): Promise<CentraidConversationSearchResult[]> {
  if (!query.trim()) return [];
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, conversationSearchPath(appId, query, limit), {
    method: 'GET',
    headers: authHeaders(token),
  });
  const out = await readJson<{ results: CentraidConversationSearchResult[] }>(res, 'search chats');
  return out.results ?? [];
}

/** Pin or unpin a chat session (pinned threads sort first). */
export async function setConversationPinned(
  appId: string,
  sessionId: string,
  pinned: boolean,
): Promise<void> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, conversationPath(appId, sessionId), {
    method: 'PATCH',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ pinned }),
  });
  await readJson(res, 'pin chat');
}

/** Archive or unarchive a chat session. */
export async function setConversationArchived(
  appId: string,
  sessionId: string,
  archived: boolean,
): Promise<void> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, conversationPath(appId, sessionId), {
    method: 'PATCH',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ archived }),
  });
  await readJson(res, 'archive chat');
}

/**
 * Set (or clear, with `null`) the reader's 👍/👎 on one answer turn
 * (`PATCH .../sessions/<id>/turns/<turnId>/feedback`, issue #420).
 */
export async function setConversationFeedback(
  appId: string,
  sessionId: string,
  turnId: string,
  feedback: 'up' | 'down' | null,
): Promise<void> {
  const { baseUrl, token } = await auth();
  const path = `${conversationPath(appId, sessionId)}/turns/${encodeURIComponent(turnId)}/feedback`;
  const res = await doFetch(baseUrl, path, {
    method: 'PATCH',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ feedback }),
  });
  await readJson(res, 'set feedback');
}

/** Delete a chat session. */
export async function deleteConversation(appId: string, sessionId: string): Promise<void> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, conversationPath(appId, sessionId), {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  await readJson(res, 'delete chat').catch(() => undefined);
}
