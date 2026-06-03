/*
 * Renderer-side unified chat transport over direct HTTP (issue #141,
 * Phase 3). The chat panel used to relay through the desktop main process
 * (`main/chat.ts` + the `centraid:chat:*` IPC); it now talks to the gateway
 * directly:
 *
 *   - `streamChat` POSTs `/centraid/<appId>/_chat` and parses the SSE stream
 *     into the gateway's native `ChatStreamEvent`s (fetch + ReadableStream
 *     reader, not `EventSource` — we need a POST body + the Bearer header).
 *     The gateway-side runner (Phase 3a `makeUnifiedChatRunner`) runs the
 *     turn in the app's draft worktree with the union of tools, so one turn
 *     can both tweak the app's code and operate its data.
 *   - the chat-history surface (`/_centraid-chat/apps/<appId>/sessions…`)
 *     mirrors the old `main/chat-history-client.ts`: list / create / load /
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
 * gateway's own `GET /centraid/_chat/runner-status` — so a remote OpenClaw
 * gateway reports `{ kind: 'openclaw', models: [...] }` and the chat picker
 * can list them.
 */
export async function getRunnerStatus(
  opts: { refresh?: boolean } = {},
): Promise<CentraidRunnerStatus> {
  const { baseUrl, token } = await auth();
  const path = opts.refresh
    ? '/centraid/_chat/runner-status?refresh=1'
    : '/centraid/_chat/runner-status';
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
export async function getAgentsStatus(): Promise<CentraidAgentsStatus> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_agents/status', {
    method: 'GET',
    headers: authHeaders(token),
  });
  return readJson<CentraidAgentsStatus>(res, 'fetch agents status');
}

/**
 * The gateway's native chat stream event (mirrors
 * `@centraid/app-engine`'s `ChatStreamEvent`). Kept as a local type so the
 * renderer doesn't import the Node package; the panel consumes this union
 * directly now that the turn isn't translated through IPC.
 */
export type ChatStreamEvent =
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

export interface StreamChatInput {
  /** The chat session id the gateway keys the turn on. */
  conversationId: string;
  message: string;
  model?: string;
  thinking?: string;
}

/**
 * Drive one chat turn against `POST /centraid/<appId>/_chat`, invoking
 * `onEvent` for each parsed `ChatStreamEvent`. Resolves when the stream ends
 * (the gateway's `event: end` frame / connection close). Pass an
 * `AbortSignal` to cancel the in-flight turn (Stop button / panel teardown).
 */
export async function streamChat(
  appId: string,
  input: StreamChatInput,
  onEvent: (event: ChatStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/${enc(appId)}/_chat`, {
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

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // SSE frames are separated by a blank line. Each frame may carry an
  // `event:` line (ignored — `type` is inside the JSON), comment lines
  // (`:` heartbeats), and one or more `data:` lines. The closing
  // `event: end\ndata: {}` frame parses to an object with no `type`, so it
  // falls through harmlessly.
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
        if (evt && typeof evt.type === 'string') onEvent(evt as ChatStreamEvent);
      } catch {
        /* skip a malformed frame rather than abort the stream */
      }
    }
  }
}

// ───────────────────────── chat history ─────────────────────

function sessionsPath(appId: string): string {
  return `/_centraid-chat/apps/${enc(appId)}/sessions`;
}

/** List this app's persisted chat sessions, newest first. */
export async function listChatSessions(appId: string): Promise<CentraidChatSessionMeta[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, sessionsPath(appId), {
    method: 'GET',
    headers: authHeaders(token),
  });
  const out = await readJson<{ sessions: CentraidChatSessionMeta[] }>(res, 'list chats');
  return out.sessions ?? [];
}

/** Create a fresh chat session row (the chat session id the turn streams to). */
export async function createChatSession(
  appId: string,
  title = '',
): Promise<CentraidChatSessionMeta> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, sessionsPath(appId), {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ title }),
  });
  return readJson<CentraidChatSessionMeta>(res, 'create chat');
}

/** Load one chat session with its reconstructed transcript. */
export async function loadChatSession(
  appId: string,
  sessionId: string,
): Promise<
  CentraidChatSessionMeta & {
    messages: Array<{ idx: number; payload: CentraidChatHistoryMessage; createdAt: number }>;
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
export async function renameChatSession(
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
export async function deleteChatSession(appId: string, sessionId: string): Promise<void> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `${sessionsPath(appId)}/${enc(sessionId)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  await readJson(res, 'delete chat').catch(() => undefined);
}
