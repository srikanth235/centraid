// governance: allow-repo-hygiene file-size-limit per-app-chat-ipc pending split into chat-session / chat-stream / chat-history-ipc modules
import { ipcMain, BrowserWindow, app } from 'electron';
import path from 'node:path';
import { loadSettings } from './settings.js';
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
 * Per-app agentic chat over @centraid/chat-harness.
 *
 * Each window+app pair owns one pi-coding-agent session at a time. The
 * harness ships three closure-scoped SQL tools that hit the runtime's
 * `/centraid/_apps/{appId}/...` HTTP surface — that surface is identical
 * on the embedded local runtime and on the remote OpenClaw gateway, so
 * this chat path is gateway-agnostic.
 *
 * The renderer protocol (`centraid:chat:event` IPC) is preserved verbatim
 * from the previous OpenClaw-WS implementation so app-chat.ts didn't need
 * to change. Pi events are translated here:
 *   - assistant text deltas → 'assistant-delta'
 *   - tool_execution_start  → 'tool-call'   (sql extracted from args.sql)
 *   - tool_execution_end    → 'tool-result' / 'tool-error'
 *   - agent_end             → 'final'
 *
 * Chat history (sidebar) hits the same `/_centraid-chat` HTTP surface in
 * both modes: the OpenClaw plugin serves it on the remote gateway, and the
 * embedded local runtime's HTTP server serves an identical implementation
 * (both live in `@centraid/runtime-core`). No branching needed here.
 */

// Loaded lazily because @centraid/chat-harness pulls pi-coding-agent +
// typebox + a non-trivial graph; we don't want that on the main-process
// boot path for users who never open the chat panel.
type ChatHarness = typeof import('@centraid/chat-harness');
let chatHarnessPromise: Promise<ChatHarness> | undefined;
function loadChatHarness(): Promise<ChatHarness> {
  if (!chatHarnessPromise) {
    chatHarnessPromise = import('@centraid/chat-harness');
  }
  return chatHarnessPromise;
}

type AgentSession = Awaited<ReturnType<ChatHarness['createCentraidDataChatSession']>>;

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
  /** Pi-coding-agent session for the active conversation; null until the
   * first send (we want the SQL tools to bind to a known chatSessionId, and
   * creating the session lazily also avoids spinning pi up for empty panels). */
  agent: AgentSession | null;
  /** Unsubscribe handle for `agent.subscribe()`. */
  detach: (() => void) | null;
  /** Per-turn id assigned by the renderer; null while idle. */
  turnId: number | null;
  /** True while pi is streaming a turn. */
  streaming: boolean;
}

const sessions = new Map<string, ChatSession>();

function sessionKey(windowId: number, appId: string): string {
  return `${windowId}:${appId}`;
}

/**
 * pi-coding-agent needs a real directory as cwd for its session metadata,
 * even though we disable all file tools. We give each app its own sandbox
 * under userData so concurrent app chats don't share pi session files.
 */
function sandboxDirFor(appId: string): string {
  return path.join(app.getPath('userData'), 'chat-sandbox', appId);
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

/**
 * Fire-and-forget batch flush — used for the streaming tail of a turn so
 * one HTTP POST carries every assistant/tool event the agent emitted. The
 * server assigns sequential idx values inside a single transaction, so this
 * is safe even if a second flush lands before this one.
 */
function flushBatch(chatSessionId: string | null, batch: unknown[]): void {
  if (!chatSessionId || batch.length === 0) return;
  void historyAppendBatch(chatSessionId, batch).catch((err) => {
    console.warn('[centraid] chat-history append failed:', err);
  });
}

/**
 * Per-turn accumulator — collects the streamed assistant text plus an
 * ordered list of coarse persistence entries so the turn's tail flushes in
 * a single batched POST. The user message was already persisted in the SEND
 * handler before runTurn even starts.
 */
interface TurnAccumulator {
  aiText: string;
  aiAppended: boolean;
  /** Tool-call id → call metadata captured at tool_execution_start, paired
   *  with the matching tool_execution_end frame. */
  pending: Map<string, { tool: string; sql?: string; args?: unknown }>;
  batch: unknown[];
}

function newAccumulator(): TurnAccumulator {
  return { aiText: '', aiAppended: false, pending: new Map(), batch: [] };
}

/**
 * Lazily create (or return) the pi-coding-agent session for this chat.
 * The agent is bound to a single (appId, chatSessionId) — when the user
 * opens a different chat row from the sidebar, START tears the previous
 * session down so we get a fresh agent here.
 */
async function ensureAgent(session: ChatSession): Promise<AgentSession> {
  if (session.agent) return session.agent;
  const { createCentraidDataChatSession } = await loadChatHarness();
  const settings = await loadSettings();
  const agent = await createCentraidDataChatSession({
    config: settings,
    appId: session.appId,
    appName: session.appName,
    sandboxDir: sandboxDirFor(session.appId),
    sessionMode: 'in-memory',
  });
  session.agent = agent;
  return agent;
}

/**
 * Translate pi-coding-agent events into the renderer-facing ChatEvent
 * stream. Mirrors the shape produced by the previous OpenClaw-WS bridge so
 * `app-chat.ts` doesn't need to know anything changed.
 */
function handlePiEvent(
  win: BrowserWindow,
  session: ChatSession,
  turnId: number,
  acc: TurnAccumulator,
  // Typed as unknown because pi-coding-agent's event union is wider than
  // what we care about and importing the full type here would force the
  // harness import out of the lazy path.
  evt: { type: string } & Record<string, unknown>,
): void {
  switch (evt.type) {
    case 'agent_start':
    case 'turn_start':
    case 'message_start':
      // Renderer already shows a "thinking" placeholder; nothing to do here
      // beyond keeping it visible until the first delta lands.
      return;
    case 'message_update': {
      const ame = evt.assistantMessageEvent as { type: string; delta?: unknown } | undefined;
      if (!ame) return;
      if (ame.type === 'text_delta' && typeof ame.delta === 'string') {
        acc.aiText += ame.delta;
        emit(win, {
          appId: session.appId,
          turnId,
          kind: 'assistant-delta',
          delta: ame.delta,
        });
      }
      return;
    }
    case 'tool_execution_start': {
      const toolName = String(evt.toolName ?? 'tool');
      const toolCallId = String(evt.toolCallId ?? '');
      const args = evt.args as Record<string, unknown> | undefined;
      const sql =
        (toolName === 'centraid_sql_read' || toolName === 'centraid_sql_write') &&
        typeof args?.sql === 'string'
          ? (args.sql as string)
          : undefined;
      acc.pending.set(toolCallId, { tool: toolName, sql, args });
      emit(win, {
        appId: session.appId,
        turnId,
        kind: 'tool-call',
        toolName,
        toolArgs: args,
        sql,
      });
      return;
    }
    case 'tool_execution_end': {
      const toolCallId = String(evt.toolCallId ?? '');
      const toolName = String(evt.toolName ?? 'tool');
      const pending = acc.pending.get(toolCallId);
      acc.pending.delete(toolCallId);
      const result = evt.result;
      const isError = Boolean(evt.isError);
      if (!isError) {
        emit(win, {
          appId: session.appId,
          turnId,
          kind: 'tool-result',
          toolName,
          toolResult: result,
        });
        acc.batch.push({
          kind: 'tool',
          id: toolCallId || `t${turnId}-${Date.now()}`,
          tool: pending?.tool ?? toolName,
          sql: pending?.sql,
          args: pending?.args,
          state: 'ok',
          result,
        });
      } else {
        // pi's result payload for failures usually looks like
        // { content: [{ type: 'text', text: '...' }] }
        const text = extractToolErrorText(result) ?? 'Tool failed.';
        emit(win, {
          appId: session.appId,
          turnId,
          kind: 'tool-error',
          toolName,
          text,
        });
        acc.batch.push({
          kind: 'tool',
          id: toolCallId || `t${turnId}-${Date.now()}`,
          tool: pending?.tool ?? toolName,
          sql: pending?.sql,
          args: pending?.args,
          state: 'error',
          errorText: text,
        });
      }
      return;
    }
    case 'turn_end':
    case 'agent_end': {
      // The model has produced its final assistant message; stage it for the
      // batched history flush. The actual flush happens in runTurn's finally
      // so any straggler deltas after `agent_end` (rare) still merge in.
      if (!acc.aiAppended && acc.aiText.trim().length > 0) {
        acc.batch.push({ kind: 'ai', text: acc.aiText });
        acc.aiAppended = true;
      }
      emit(win, {
        appId: session.appId,
        turnId,
        kind: 'final',
        text: acc.aiText,
      });
      return;
    }
    default:
      break;
  }
}

/** Pull a plain-text error message out of pi's tool-result content array. */
function extractToolErrorText(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as { content?: unknown };
  if (!Array.isArray(r.content)) return undefined;
  const first = r.content.find(
    (c) => c && typeof c === 'object' && (c as { type?: unknown }).type === 'text',
  ) as { text?: unknown } | undefined;
  return typeof first?.text === 'string' ? first.text : undefined;
}

async function runTurn(
  win: BrowserWindow,
  session: ChatSession,
  text: string,
  turnId: number,
): Promise<void> {
  session.turnId = turnId;
  session.streaming = true;
  emit(win, { appId: session.appId, turnId, kind: 'thinking' });
  const acc = newAccumulator();

  let detach: (() => void) | null = null;
  try {
    const agent = await ensureAgent(session);
    detach = agent.subscribe((evt) => {
      handlePiEvent(win, session, turnId, acc, evt as { type: string } & Record<string, unknown>);
    });
    session.detach = detach;
    await agent.prompt(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit(win, { appId: session.appId, turnId, kind: 'error', text: msg });
    if (!acc.aiAppended) {
      acc.batch.push({ kind: 'ai', text: msg, error: true });
      acc.aiAppended = true;
    }
  } finally {
    detach?.();
    if (session.detach === detach) session.detach = null;
    session.streaming = false;
    session.turnId = null;
    flushBatch(session.chatSessionId, acc.batch);
  }
}

/**
 * Tear down a chat session's agent. Called when the panel switches to a
 * different past chat or when the window closes. Aborting an in-flight
 * turn is best-effort — pi resolves the abort once the agent goes idle.
 */
async function disposeSession(session: ChatSession): Promise<void> {
  session.detach?.();
  session.detach = null;
  if (session.agent) {
    try {
      if (session.streaming) await session.agent.abort();
    } catch {
      /* swallow */
    }
    try {
      session.agent.dispose();
    } catch {
      /* swallow */
    }
    session.agent = null;
  }
  session.streaming = false;
  session.turnId = null;
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
      const prior = sessions.get(key);
      if (prior) await disposeSession(prior);
      sessions.set(key, {
        appId: input.appId,
        appName: input.appName,
        chatSessionId: input.sessionId ?? null,
        agent: null,
        detach: null,
        turnId: null,
        streaming: false,
      });
      return { ok: true, sessionId: input.sessionId ?? null };
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

      // Lazy-create the persisted chat-history row on first send so empty
      // "+ New chat" presses don't litter the sessions list.
      if (!session.chatSessionId) {
        const created = await historyCreate(session.appId, '');
        session.chatSessionId = created.id;
      }

      // Persist the user's message synchronously so we can return the
      // canonical title (auto-derived server-side from the first user
      // message) to the renderer. This also gives crash-safety: even if
      // the turn never finishes, the user's prompt is durable.
      const appendRes = await historyAppendBatch(session.chatSessionId, [
        { kind: 'user', text: input.text },
      ]);
      const title = appendRes.title;

      void runTurn(win, session, input.text, input.turnId).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        emit(win, { appId: input.appId, turnId: input.turnId, kind: 'error', text: msg });
        flushBatch(session.chatSessionId, [{ kind: 'ai', text: msg, error: true }]);
      });

      return { ok: true, sessionId: session.chatSessionId, title };
    },
  );

  ipcMain.handle(
    ChatChannel.ABORT,
    async (event, input: { appId: string }): Promise<{ ok: true }> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return { ok: true };
      const session = sessions.get(sessionKey(win.id, input.appId));
      if (!session?.agent || !session.streaming) return { ok: true };
      try {
        await session.agent.abort();
        emit(win, {
          appId: input.appId,
          turnId: session.turnId ?? -1,
          kind: 'aborted',
        });
      } catch {
        /* swallow */
      }
      return { ok: true };
    },
  );

  // Model picker — the renderer reads this for the chat header dropdown.
  // The harness path defers model selection to pi's own settings/auth, so
  // we return an empty list for now; the renderer falls back to "default".
  ipcMain.handle(
    ChatChannel.MODELS,
    async () =>
      [] as Array<{
        id: string;
        name: string;
        provider: string;
      }>,
  );

  // ---------- Chat history ----------
  // The same `/_centraid-chat` HTTP surface backs both runtime modes — the
  // openclaw plugin serves it on the remote gateway, and the embedded local
  // runtime's HTTP server serves an identical implementation from
  // @centraid/runtime-core.
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
    void disposeSession(session);
    sessions.delete(key);
  }
}
