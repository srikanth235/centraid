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
  enc,
  readJson,
  GatewayClientError,
} from './gateway-client-core.js';
import type { CentraidAgentsStatus, CentraidRunnerStatus } from './centraid-api.js';

/**
 * Runner preflight + model catalog from the ACTIVE gateway. Reads the
 * gateway's own `GET /centraid/_turn/runner-status` — so a remote OpenClaw
 * gateway reports `{ kind: 'openclaw', models: [...] }` and the chat picker
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
 * beside the runner, so a remote OpenClaw gateway reports its own host's
 * agents rather than whatever is installed on the desktop.
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

/**
 * The gateway's native chat stream event (mirrors
 * `@centraid/app-engine`'s `TurnStreamEvent`). Kept as a local type so the
 * renderer doesn't import the Node package; the panel consumes this union
 * directly now that the turn isn't translated through IPC.
 */
export type TurnStreamEvent =
  | { type: 'assistant.start' }
  | { type: 'assistant.delta'; delta: string }
  | { type: 'reasoning.delta'; delta: string }
  | { type: 'tool.start'; toolCallId: string; toolName: string; args?: unknown; sql?: string }
  | {
      type: 'tool.result';
      toolCallId: string;
      toolName: string;
      ok: boolean;
      result?: unknown;
      errorText?: string;
    }
  | { type: 'phase'; phase: string; detail?: unknown }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string }
  | { type: 'aborted' }
  | {
      type: 'usage';
      model?: string;
      provider?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }
  | {
      type: 'webhooks';
      minted: Array<{
        automationId: string;
        ownerApp: string;
        webhookId: string;
        url: string;
        secret: string;
      }>;
    };

/** An attachment already uploaded to the blob CAS, referenced on the next turn. */
export interface ConversationAttachmentRef {
  hash: string;
  mime: string;
  sizeBytes: number;
  filename?: string;
}

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
  const res = await doFetch(baseUrl, `/_centraid-conversations/apps/${enc(appId)}/blobs`, {
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
): Promise<void> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/${enc(appId)}/_turn`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({
      conversationId: input.conversationId,
      message: input.message,
      ...(input.register ? { register: input.register } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinking ? { thinking: input.thinking } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new GatewayClientError(
        'auth_required',
        `chat: gateway rejected request (HTTP ${res.status}).`,
      );
    }
    throw new GatewayClientError(
      'gateway_error',
      `chat failed (HTTP ${res.status}): ${text || res.statusText}`,
    );
  }
  if (!res.body)
    throw new GatewayClientError('gateway_error', 'chat: gateway returned no stream body.');
  await consumeSse(res.body, onEvent);
}

/**
 * Parse a `_turn` SSE body into `TurnStreamEvent`s. Frames are separated by
 * a blank line; each may carry an `event:` line (ignored — `type` is inside
 * the JSON), `:` heartbeat comments, and one or more `data:` lines. The
 * closing `event: end\ndata: {}` frame parses to an object with no `type`,
 * so it falls through harmlessly.
 */
async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: TurnStreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice('data:'.length).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        const evt = JSON.parse(data) as { type?: string };
        if (evt && typeof evt.type === 'string') onEvent(evt as TurnStreamEvent);
      } catch {
        /* skip a malformed frame rather than abort the stream */
      }
    }
  }
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
): Promise<void> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_vault/assistant/_turn`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({
      conversationId: input.conversationId,
      message: input.message,
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinking ? { thinking: input.thinking } : {}),
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new GatewayClientError(
      res.status === 401 || res.status === 403 ? 'auth_required' : 'gateway_error',
      `assistant turn failed (HTTP ${res.status}): ${text || res.statusText}`,
    );
  }
  if (!res.body)
    throw new GatewayClientError('gateway_error', 'assistant: gateway returned no stream body.');
  await consumeSse(res.body, onEvent);
}

/** Resolve answer refs (`ref:type/id`) to renderable entity cards. */
export async function resolveAssistantRefs(
  refs: Array<{ type: string; id: string }>,
): Promise<AssistantRefCard[]> {
  if (refs.length === 0) return [];
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_vault/assistant/resolve`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ refs }),
  });
  const out = await readJson<{ cards: AssistantRefCard[] }>(res, 'resolve assistant refs');
  return out.cards ?? [];
}

// ───────────────────────── chat history ─────────────────────

function sessionsPath(appId: string): string {
  return `/_centraid-conversations/apps/${enc(appId)}/sessions`;
}

/** List this app's persisted chat sessions, newest first. */
export async function listConversations(appId: string): Promise<CentraidConversationSummary[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, sessionsPath(appId), {
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
  const res = await doFetch(baseUrl, sessionsPath(appId), {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ title }),
  });
  return readJson<CentraidConversationSummary>(res, 'create chat');
}

/** Load one chat session with its reconstructed transcript. */
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
  }
> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `${sessionsPath(appId)}/${enc(sessionId)}`, {
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
  const res = await doFetch(baseUrl, `${sessionsPath(appId)}/${enc(sessionId)}`, {
    method: 'PATCH',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ title }),
  });
  await readJson(res, 'rename chat');
}

/** Delete a chat session. */
export async function deleteConversation(appId: string, sessionId: string): Promise<void> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `${sessionsPath(appId)}/${enc(sessionId)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  await readJson(res, 'delete chat').catch(() => undefined);
}
