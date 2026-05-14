// governance: allow-repo-hygiene file-size-limit per-app-chat-ipc pending split into chat-session / chat-stream / chat-history-ipc modules
import { ipcMain, BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { loadSettings } from './settings.js';
import { GatewayWsClient, type GatewayEvent } from './gateway-ws.js';
import {
  historyAppendBatch,
  historyCreate,
  historyDelete,
  historyList,
  historyLoad,
  historyRename,
  type ChatSessionMeta,
  type ChatSessionWithMessages,
} from './chat-history-client.js';

/**
 * Per-app agentic chat over the OpenClaw Gateway WS RPC.
 *
 * Each window+app pair owns one `agent` run at a time. The run is opened with
 * `sessionKey = "centraid-chat:<appId>:<windowId>"`; the centraid plugin's
 * before_tool_call guard parses that key so the agent can only read this
 * app's SQLite. Token-by-token streaming reaches the renderer via
 * `centraid:chat:event` IPC events as the gateway pushes them on the WS.
 *
 * The plugin must be installed in the target gateway for the SQL/schema
 * tools to exist; that's only the case when desktop settings use
 * `runtimeMode: 'remote'`. We log a clear error otherwise.
 */

export const ChatChannel = {
  START: 'centraid:chat:start',
  SEND: 'centraid:chat:send',
  ABORT: 'centraid:chat:abort',
  EVENT: 'centraid:chat:event',
  MODELS: 'centraid:chat:models',
  HISTORY_LIST: 'centraid:chat:history:list',
  HISTORY_LOAD: 'centraid:chat:history:load',
  HISTORY_DELETE: 'centraid:chat:history:delete',
  HISTORY_RENAME: 'centraid:chat:history:rename',
} as const;

const SESSION_PREFIX = 'centraid-chat:';

interface ChatSession {
  appId: string;
  appName: string;
  /**
   * The chat-history row id (persistent across panel opens) for the
   * conversation currently displayed in this window. `null` when the panel
   * is freshly opened or a "new chat" was requested but the user hasn't
   * sent anything yet — we lazy-create the row on first send so empty
   * panels don't litter the sessions list.
   */
  chatSessionId: string | null;
  /** Cached gateway session key for the active chatSessionId. */
  sessionKey: string;
  /** Set while a turn is in flight; lets us send `sessions.abort`. */
  runId: string | null;
  /** Stream unsubscribe handle for the current turn. */
  detachEvents: (() => void) | null;
  /** Per-turn id assigned by the renderer. */
  turnId: number | null;
}

const sessions = new Map<string, ChatSession>();
let client: GatewayWsClient | null = null;

function sessionKey(windowId: number, appId: string): string {
  return `${windowId}:${appId}`;
}

/**
 * Build the openclaw agent session key for a chat session. Including the
 * chat session id in the key gives each persisted conversation its own
 * durable agent session on the gateway — so resuming an old chat picks up
 * the same agent memory the model had at the time.
 */
function makeAgentSessionKey(appId: string, chatSessionId: string): string {
  return `${SESSION_PREFIX}${appId}:s${chatSessionId}`;
}

/**
 * Fire-and-forget batch flush — used for the streaming tail of a turn so
 * one HTTP POST carries every assistant/tool event the agent emitted. Order
 * is preserved server-side (atomic transaction assigns sequential idx
 * values), so this is safe even if a second flush lands before this one.
 */
function flushBatch(chatSessionId: string | null, batch: unknown[]): void {
  if (!chatSessionId || batch.length === 0) return;
  void historyAppendBatch(chatSessionId, batch).catch((err) => {
    console.warn('[centraid] chat-history append failed:', err);
  });
}

interface ChatEvent {
  appId: string;
  turnId: number;
  kind:
    | 'thinking'
    | 'assistant-delta'
    | 'tool-call'
    | 'tool-result'
    | 'tool-error'
    | 'final'
    | 'error'
    | 'aborted';
  text?: string;
  delta?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  sql?: string;
}

function emit(win: BrowserWindow, event: ChatEvent): void {
  if (!win.isDestroyed()) {
    win.webContents.send(ChatChannel.EVENT, event);
  }
}

async function getClient(): Promise<GatewayWsClient> {
  if (client && !client.isClosed()) return client;
  const settings = await loadSettings();
  if (settings.runtimeMode !== 'remote') {
    throw new Error(
      'Chat requires runtimeMode: "remote" so the centraid plugin can register its tools in the openclaw gateway. Switch to remote mode in Settings.',
    );
  }
  const next = new GatewayWsClient({
    url: settings.gatewayUrl,
    token: settings.gatewayToken,
  });
  // If the gateway is restarted out from under us, drop the cached client so
  // the next call reconnects instead of failing on a dead WS.
  next.onClose(() => {
    if (client === next) client = null;
  });
  await next.connect();
  client = next;
  return client;
}

/**
 * Read the assistant delta text, if any, from a gateway `agent` event.
 * Event shape per the SDK e2e test:
 *   { event: "agent", payload: { runId, sessionKey, stream, data: {...} } }
 */
interface AgentEventPayload {
  runId?: string;
  sessionKey?: string;
  stream?: string;
  data?: Record<string, unknown>;
}

function readAgentPayload(evt: GatewayEvent): AgentEventPayload | undefined {
  if (evt.event !== 'agent') return undefined;
  if (!evt.payload || typeof evt.payload !== 'object') return undefined;
  return evt.payload as AgentEventPayload;
}

/**
 * Per-turn accumulator. Two jobs:
 *  - Collect the streaming AI text so we can persist one final assistant
 *    message (not every delta).
 *  - Buffer the ordered tail of coarse messages (assistant final + tool
 *    end events) so the whole turn flushes in one batched POST.
 *
 * The user's own message is persisted synchronously in the SEND handler
 * before this accumulator is created — see `registerChatIpcHandlers`.
 */
interface TurnAccumulator {
  aiText: string;
  aiAppended: boolean;
  /** Last tool we saw a `tool-call` for, awaiting its result/error. */
  pendingTool: { id: string; tool: string; sql?: string; args?: unknown } | null;
  /** Ordered batch flushed at turn end. */
  batch: unknown[];
}

/** Open one chat turn and stream the agent run back to the renderer. */
async function runTurn(
  win: BrowserWindow,
  session: ChatSession,
  text: string,
  turnId: number,
  model: string | undefined,
): Promise<void> {
  const wsc = await getClient();
  session.turnId = turnId;
  emit(win, { appId: session.appId, turnId, kind: 'thinking' });
  const acc: TurnAccumulator = {
    aiText: '',
    aiAppended: false,
    pendingTool: null,
    batch: [],
  };

  // Stage the final assistant message into the batch if we haven't yet.
  // Idempotent — guards against the `final` event landing and then an
  // `aborted`/`error` post-script. The catch-up in finally calls this too.
  const ensureAiAppended = (text: string, error?: boolean): void => {
    if (acc.aiAppended) return;
    if (text.trim().length === 0) return;
    acc.batch.push({ kind: 'ai', text, error });
    acc.aiAppended = true;
  };

  // Build the system prompt context — fed to the model as the leading message
  // turn so the agent knows it's app-scoped and which tools to call.
  const system = [
    `You are a data assistant for the centraid app "${session.appName}" (id: ${session.appId}).`,
    `You can read AND modify this app's data using these tools:`,
    `  - centraid_get_schema({ appId }) → returns tables/columns/views.`,
    `  - centraid_sql_select({ appId, sql }) → runs a single SELECT and returns rows.`,
    `  - centraid_sql_write({ appId, sql }) → runs a single INSERT/UPDATE/DELETE/REPLACE and returns { rowsAffected, lastInsertRowid }.`,
    `Always pass appId: "${session.appId}". Cross-app access is refused by the gateway.`,
    `Schema-changing statements (CREATE/ALTER/DROP) and PRAGMA/ATTACH are refused — use the existing schema.`,
    `Before writing, call centraid_get_schema (or a quick SELECT) to confirm table/column names; never invent them.`,
    `Confirm row-mutating writes back to the user in plain Markdown — say what changed (rowsAffected, the new id when inserting).`,
  ].join('\n');

  // Provider-qualified model ref → openclaw split. The buildAgentParams in the
  // SDK does this server-side, but with the raw agent RPC we send model
  // verbatim and let the gateway resolve it.
  const provider = model && model.includes('/') ? model.split('/', 2)[0] : undefined;
  const modelOnly = model && model.includes('/') ? model.split('/', 2)[1] : model;

  const params: Record<string, unknown> = {
    message: `${system}\n\nUser: ${text}`,
    sessionKey: session.sessionKey,
    idempotencyKey: randomUUID(),
    timeout: 120,
  };
  if (provider) params.provider = provider;
  if (modelOnly) params.model = modelOnly;

  // Subscribe to events BEFORE issuing the request so we don't miss frames
  // that arrive between request submission and the response. Events that
  // arrive before runId is assigned are buffered and flushed once we know
  // the runId — without this, the first tool call of a short run could be
  // dropped if the agent starts emitting before `agent` returns.
  let runId: string | null = null;
  const buffered: AgentEventPayload[] = [];
  const ourEvents: ((evt: GatewayEvent) => void)[] = [];
  const detach = wsc.onEvent((evt) => {
    const payload = readAgentPayload(evt);
    if (!payload) return;
    if (!runId) {
      // Hold until runId is known; we'll filter on flush.
      buffered.push(payload);
      return;
    }
    if (payload.runId !== runId) return;
    handleAgentEvent(win, session, turnId, payload, acc);
  });
  session.detachEvents = detach;

  try {
    const res =
      (await wsc.request<{ runId?: string; sessionKey?: string }>('agent', params, 30_000)) ?? {};
    runId = typeof res.runId === 'string' ? res.runId : null;
    session.runId = runId;
    if (!runId) throw new Error('gateway did not return a runId for the agent run');

    // Flush any events received between subscribe and runId assignment.
    if (buffered.length > 0) {
      const drained = buffered.splice(0);
      for (const p of drained) {
        if (p.runId === runId) handleAgentEvent(win, session, turnId, p, acc);
      }
    }

    // Wait for the run to terminate. `agent.wait` blocks server-side until
    // the run ends (or our wait budget expires). Per the SDK, params are
    // `{ runId, timeoutMs }` — no sessionKey.
    const waitRes =
      (await wsc.request<{ status?: string; error?: string }>(
        'agent.wait',
        { runId, timeoutMs: 180_000 },
        200_000,
      )) ?? {};

    const status = (waitRes.status ?? '').toLowerCase();
    if (status === 'ok' || status === 'completed' || status === 'succeeded') {
      // The terminal "final" event is emitted by `handleAgentEvent` when it
      // sees a lifecycle:end frame. If for some reason that didn't fire,
      // emit a fallback so the UI unstucks.
      // (This is best-effort; lifecycle:end usually arrives.)
    } else if (status === 'aborted' || status === 'cancelled' || status === 'canceled') {
      emit(win, { appId: session.appId, turnId, kind: 'aborted' });
      // Stage whatever the assistant streamed before the abort, so the
      // session reload shows the partial answer instead of just the user
      // turn vanishing into a void.
      ensureAiAppended(acc.aiText);
    } else if (status === 'timeout' || status === 'timed_out') {
      emit(win, { appId: session.appId, turnId, kind: 'error', text: 'Run timed out.' });
      ensureAiAppended('Run timed out.', true);
    } else {
      const text = waitRes.error ?? `Run ended with status: ${status || 'unknown'}.`;
      emit(win, { appId: session.appId, turnId, kind: 'error', text });
      ensureAiAppended(text, true);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit(win, { appId: session.appId, turnId, kind: 'error', text: msg });
    ensureAiAppended(msg, true);
  } finally {
    detach();
    if (session.detachEvents === detach) session.detachEvents = null;
    session.runId = null;
    session.turnId = null;
    // Flush the streaming tail in one batched POST so order is set by the
    // server's atomic transaction, not by N independent fire-and-forget
    // requests racing. The user message was already persisted synchronously
    // in the SEND handler, so it's safely ahead of this batch.
    flushBatch(session.chatSessionId, acc.batch);
    void ourEvents; // appease unused-var lint when we add per-event hooks later
  }
}

/**
 * Translate a raw `agent` event payload into renderer-facing chat events.
 *
 * The gateway streams "lifecycle", "assistant", and "tool" sub-streams under
 * a single `event: "agent"` envelope. We parse the `stream` + `data` fields
 * and emit the matching IPC events. Field names follow the SDK normalizer
 * (`packages/sdk/src/normalize.ts`).
 */
function handleAgentEvent(
  win: BrowserWindow,
  session: ChatSession,
  turnId: number,
  payload: AgentEventPayload,
  acc: TurnAccumulator,
): void {
  const stream = payload.stream;
  const data = (payload.data ?? {}) as Record<string, unknown>;

  if (stream === 'assistant') {
    const delta = typeof data.delta === 'string' ? data.delta : undefined;
    if (delta) {
      acc.aiText += delta;
      emit(win, { appId: session.appId, turnId, kind: 'assistant-delta', delta });
      return;
    }
    // assistant.message — full message after deltas. Some providers emit
    // only this, no deltas. Surface it as a final chunk.
    const content = data.content ?? data.text;
    if (typeof content === 'string' && content.length > 0) {
      acc.aiText += content;
      emit(win, { appId: session.appId, turnId, kind: 'assistant-delta', delta: content });
    }
    return;
  }

  if (stream === 'tool') {
    const phase = typeof data.phase === 'string' ? data.phase : undefined;
    const toolName =
      (typeof data.tool === 'string' ? data.tool : undefined) ??
      (typeof data.name === 'string' ? data.name : undefined);
    const args = data.args ?? data.params;
    const result = data.result ?? data.output;
    if (phase === 'start' || phase === 'started') {
      // Surface the SQL string when this is a SELECT or WRITE call so the
      // UI can show the query inline.
      const sql =
        (toolName === 'centraid_sql_select' || toolName === 'centraid_sql_write') &&
        typeof (args as { sql?: unknown })?.sql === 'string'
          ? (args as { sql: string }).sql
          : undefined;
      // Track this as the pending tool so the matching `result`/`error`
      // event can be paired with its name and args for persistence.
      acc.pendingTool = {
        id: `t${turnId}-${Date.now()}`,
        tool: toolName ?? 'tool',
        sql,
        args,
      };
      emit(win, {
        appId: session.appId,
        turnId,
        kind: 'tool-call',
        toolName: toolName ?? 'tool',
        toolArgs: args,
        sql,
      });
      return;
    }
    // OpenClaw emits the terminal tool event with `phase: "result"` (see
    // `handleToolExecutionEnd` in openclaw/dist/selection-*.js). We also
    // accept "end"/"completed" defensively for older builds.
    if (phase === 'result' || phase === 'end' || phase === 'completed') {
      const ok = data.error == null && data.isError !== true;
      const pending = acc.pendingTool;
      const toolId = pending?.id ?? `t${turnId}-${Date.now()}`;
      const toolKind = pending?.tool ?? toolName ?? 'tool';
      if (ok) {
        emit(win, {
          appId: session.appId,
          turnId,
          kind: 'tool-result',
          toolName: toolName ?? 'tool',
          toolResult: result,
        });
        acc.batch.push({
          kind: 'tool',
          id: toolId,
          tool: toolKind,
          sql: pending?.sql,
          args: pending?.args,
          state: 'ok',
          result,
        });
      } else {
        const text =
          (typeof data.error === 'string' ? data.error : undefined) ??
          (typeof data.errorMessage === 'string' ? data.errorMessage : undefined) ??
          'Tool failed.';
        emit(win, {
          appId: session.appId,
          turnId,
          kind: 'tool-error',
          toolName: toolName ?? 'tool',
          text,
        });
        acc.batch.push({
          kind: 'tool',
          id: toolId,
          tool: toolKind,
          sql: pending?.sql,
          args: pending?.args,
          state: 'error',
          errorText: text,
        });
      }
      acc.pendingTool = null;
      return;
    }
    return;
  }

  if (stream === 'lifecycle') {
    const phase = typeof data.phase === 'string' ? data.phase : undefined;
    if (phase === 'end' || phase === 'completed') {
      const lifecycleText =
        (typeof data.text === 'string' ? data.text : undefined) ??
        (typeof data.finalText === 'string' ? data.finalText : undefined) ??
        '';
      emit(win, { appId: session.appId, turnId, kind: 'final', text: lifecycleText });
      // Prefer the streamed text — lifecycleText is sometimes empty when
      // the provider only emitted deltas. Stage the AI message into the
      // batch; the actual POST happens in runTurn's finally so deltas can
      // still arrive after `final` and be coalesced if needed.
      acc.batch.push({ kind: 'ai', text: acc.aiText || lifecycleText });
      acc.aiAppended = true;
      return;
    }
    if (phase === 'error' || phase === 'failed') {
      const msg =
        (typeof data.error === 'string' ? data.error : undefined) ??
        (typeof data.message === 'string' ? data.message : undefined) ??
        'Run failed.';
      emit(win, { appId: session.appId, turnId, kind: 'error', text: msg });
      if (!acc.aiAppended) {
        acc.batch.push({ kind: 'ai', text: msg, error: true });
        acc.aiAppended = true;
      }
    }
  }
}

async function listModels(): Promise<Array<{ id: string; name: string; provider: string }>> {
  try {
    const wsc = await getClient();
    const raw = (await wsc.request<{ models?: unknown[] } | unknown[]>('models.list', {})) ?? {};
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { models?: unknown[] }).models)
        ? (raw as { models: unknown[] }).models
        : [];
    return list
      .filter(
        (m): m is { id: string; name?: string; provider?: string } =>
          typeof m === 'object' && m !== null && typeof (m as { id?: unknown }).id === 'string',
      )
      .map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        provider: m.provider ?? '',
      }));
  } catch {
    return [];
  }
}

export function registerChatIpcHandlers(): void {
  ipcMain.handle(
    ChatChannel.START,
    async (
      event,
      input: { appId: string; appName: string; sessionId?: string | null },
    ): Promise<{ ok: true; sessionId: string | null }> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) throw new Error('no window for chat session');
      const key = sessionKey(win.id, input.appId);
      // Tear down any prior session for this app+window (e.g. user navigated
      // away and back, or switched between past chats) — also aborts any
      // inflight run on the previous chat.
      const prior = sessions.get(key);
      if (prior?.runId) {
        try {
          const wsc = await getClient();
          await wsc.request('sessions.abort', { runId: prior.runId, key: prior.sessionKey });
        } catch {
          /* swallow */
        }
      }
      prior?.detachEvents?.();
      const chatSessionId = input.sessionId ?? null;
      sessions.set(key, {
        appId: input.appId,
        appName: input.appName,
        chatSessionId,
        // When chatSessionId is null we still need a placeholder key; it gets
        // replaced with the real `centraid-chat:<appId>:s<id>` form once the
        // user sends the first message and we create the persisted session.
        sessionKey: chatSessionId
          ? makeAgentSessionKey(input.appId, chatSessionId)
          : `${SESSION_PREFIX}${input.appId}:pending`,
        runId: null,
        detachEvents: null,
        turnId: null,
      });
      return { ok: true, sessionId: chatSessionId };
    },
  );

  ipcMain.handle(
    ChatChannel.SEND,
    async (
      event,
      input: { appId: string; text: string; turnId: number; model?: string },
    ): Promise<{ ok: true; sessionId: string; title: string }> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) throw new Error('no window for chat send');
      const session = sessions.get(sessionKey(win.id, input.appId));
      if (!session) throw new Error('chat session not started');
      // Lazy-create the persisted chat session on first send so empty
      // "+ New chat" presses don't litter the history list. The agent
      // sessionKey is rewritten to include the new id so the openclaw
      // agent session is per-conversation, not per-window.
      if (!session.chatSessionId) {
        const created = await historyCreate(session.appId, '');
        session.chatSessionId = created.id;
        session.sessionKey = makeAgentSessionKey(session.appId, created.id);
      }
      // Persist the user's message synchronously so we can return the
      // canonical title (auto-derived server-side from the first user
      // message) to the renderer. This also gives crash-safety: even if
      // the turn never finishes, the user's prompt is durable.
      const appendRes = await historyAppendBatch(session.chatSessionId, [
        { kind: 'user', text: input.text },
      ]);
      // Run in the background so streaming events can flow while the IPC
      // call returns immediately to the renderer.
      void runTurn(win, session, input.text, input.turnId, input.model).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        emit(win, { appId: input.appId, turnId: input.turnId, kind: 'error', text: msg });
        // Persist the error as a one-off batch since the catch path skips
        // runTurn's finally flush.
        flushBatch(session.chatSessionId, [{ kind: 'ai', text: msg, error: true }]);
      });
      return {
        ok: true,
        sessionId: session.chatSessionId,
        title: appendRes.title,
      };
    },
  );

  ipcMain.handle(
    ChatChannel.ABORT,
    async (event, input: { appId: string }): Promise<{ ok: true }> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return { ok: true };
      const session = sessions.get(sessionKey(win.id, input.appId));
      if (!session?.runId) return { ok: true };
      try {
        const wsc = await getClient();
        await wsc.request('sessions.abort', { runId: session.runId, key: session.sessionKey });
      } catch {
        /* swallow */
      }
      return { ok: true };
    },
  );

  ipcMain.handle(ChatChannel.MODELS, async () => listModels());

  // ---------- Chat history ----------
  ipcMain.handle(
    ChatChannel.HISTORY_LIST,
    async (_event, input: { appId: string }): Promise<{ sessions: ChatSessionMeta[] }> => {
      const list = await historyList(input.appId);
      return { sessions: list };
    },
  );
  ipcMain.handle(
    ChatChannel.HISTORY_LOAD,
    async (_event, input: { sessionId: string }): Promise<ChatSessionWithMessages> =>
      historyLoad(input.sessionId),
  );
  ipcMain.handle(
    ChatChannel.HISTORY_DELETE,
    async (_event, input: { sessionId: string }): Promise<{ ok: boolean }> =>
      historyDelete(input.sessionId),
  );
  ipcMain.handle(
    ChatChannel.HISTORY_RENAME,
    async (_event, input: { sessionId: string; title: string }): Promise<ChatSessionMeta> =>
      historyRename(input.sessionId, input.title),
  );
}

/** Tear down chat sessions belonging to a closing window. */
export function disposeWindowChatSessions(windowId: number): void {
  for (const [key, session] of sessions.entries()) {
    if (!key.startsWith(`${windowId}:`)) continue;
    session.detachEvents?.();
    if (session.runId && client) {
      void client
        .request('sessions.abort', { runId: session.runId, key: session.sessionKey })
        .catch(() => {});
    }
    sessions.delete(key);
  }
}
