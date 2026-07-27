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

import {
  auth,
  authHeaders,
  doFetch,
  readJson,
  scopedAuthHeaders,
  GatewayClientError,
} from './gateway-client-core.js';
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
  opts: { refresh?: boolean } = {},
): Promise<CentraidAgentsStatus> {
  const { baseUrl, token } = await auth();
  // `?refresh=1` re-enumerates each agent's models (issue #188). A plain load
  // returns the catalog cache.
  const path = opts.refresh ? '/centraid/_agents/status?refresh=1' : '/centraid/_agents/status';
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
  /**
   * The space this conversation reads and writes (issue #599). A conversation
   * is pinned to exactly ONE space for its whole life: the picker records the
   * choice when the conversation is created, and every later turn/load repeats
   * it. Omitted degrades to the shell's internal default-scope pointer, which
   * is what every conversation created before the picker existed relies on.
   */
  scopeId?: string;
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
  scopeId?: string,
): Promise<Response> {
  const { baseUrl, token } = await auth();
  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(baseUrl, path, {
      method: 'POST',
      headers: scopedAuthHeaders(token, scopeId, 'application/json'),
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
  scopeId?: string,
): Promise<ConversationAttachmentRef> {
  const { baseUrl, token } = await auth();
  // The blob CAS is vault-partitioned: an attachment staged in the ambient
  // space while the turn resolves its hash in the conversation's space would
  // silently break — so the conversation's scope rides the upload too (#599).
  const res = await doFetch(baseUrl, blobsPath(appId), {
    method: 'POST',
    headers: scopedAuthHeaders(token, scopeId, mime),
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
    input.scopeId,
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
    input.scopeId,
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
  scopeId?: string,
): Promise<{ turnCount: number; updatedAt: number }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, conversationStatusPath(appId, sessionId), {
    method: 'GET',
    headers: scopedAuthHeaders(token, scopeId),
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

// The chat-history CRUD (list/create/load/rename/search/pin/archive/delete)
// lives beside this file; re-exported so the conversation surface stays one
// import for every call site.
export * from './gateway-client-conversation-history.js';
