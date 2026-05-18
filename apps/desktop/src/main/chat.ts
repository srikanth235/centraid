// governance: allow-repo-hygiene file-size-limit per-app-chat-ipc pending split into chat-session / chat-stream / chat-history-ipc modules
import { ipcMain, BrowserWindow } from 'electron';
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
import type { ChatMode, ChatStreamEvent } from '@centraid/runtime-core';

/**
 * Per-app chat IPC. The desktop main process is now a thin proxy: every
 * turn POSTs to `/centraid/<appId>/_chat` on whichever gateway the user
 * has configured (OpenClaw or the embedded local runtime). The harness's
 * SSE client streams `ChatStreamEvent`s back; we translate each event to
 * the renderer's existing `centraid:chat:event` protocol so app-chat.ts
 * doesn't need to change.
 *
 * Chat-history (sidebar) still hits the gateway's `/_centraid-chat`
 * surface — same as before — for compatibility with the renderer's
 * persistent-conversations UI. Per-window transcript persistence in
 * `<appsDir>/<appId>/_chat/index.json` is owned by the runtime now;
 * the chat-history sqlite is a separate, renderer-facing log.
 */

// chat-harness imports are lazy so we don't pay the cost on cold boot
// for users who never open the chat panel.
type ChatHarness = typeof import('@centraid/chat-harness');
let chatHarnessPromise: Promise<ChatHarness> | undefined;
function loadChatHarness(): Promise<ChatHarness> {
  if (!chatHarnessPromise) chatHarnessPromise = import('@centraid/chat-harness');
  return chatHarnessPromise;
}

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
  /** Persisted chat-history row id (renderer-visible chat list). Lazy-
   *  created on first send so empty panels don't litter the sidebar. */
  chatSessionId: string | null;
  /**
   * Window id sent to the runtime's `_chat` endpoint. Pinned per
   * chat-history row so a refresh + load resumes the same CLI session
   * (codex thread / claude-code session) on the gateway side. We mint
   * one on START if the chatSessionId is null (no history row yet).
   */
  windowId: string;
  /**
   * Chat mode for this window. `full` is the default — the user's agent
   * reasons over the app with its full toolkit plus our SQL tools. `data`
   * locks the run to centraid_sql_* only (plus per-adapter sandbox flags
   * that runtime-core's runner applies). Once a window's first turn pins
   * a mode, subsequent turns inherit it — the gateway-side `_chat/index.json`
   * is the source of truth; we forward the desired mode but the runtime
   * may override if the window already exists.
   */
  mode: ChatMode;
  /** Abort handle for the currently streaming turn, or null when idle. */
  currentAbort: (() => void) | null;
  /** Per-turn id assigned by the renderer; null while idle. */
  turnId: number | null;
}

const sessions = new Map<string, ChatSession>();

function sessionKey(windowId: number, appId: string): string {
  return `${windowId}:${appId}`;
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
  if (!win.isDestroyed()) win.webContents.send(ChatChannel.EVENT, event);
}

interface TurnAccumulator {
  aiText: string;
  pending: Map<string, { tool: string; sql?: string; args?: unknown }>;
  batch: unknown[];
}

function newAccumulator(): TurnAccumulator {
  return { aiText: '', pending: new Map(), batch: [] };
}

function flushBatch(chatSessionId: string | null, batch: unknown[]): void {
  if (!chatSessionId || batch.length === 0) return;
  void historyAppendBatch(chatSessionId, batch).catch((err) => {
    console.warn('[centraid] chat-history append failed:', err);
  });
}

/**
 * Translate one `ChatStreamEvent` from the gateway's SSE stream into the
 * renderer's `centraid:chat:event` shape (kept identical to the previous
 * pi-coding-agent wiring so the renderer needed zero changes).
 */
function handleStreamEvent(
  win: BrowserWindow,
  session: ChatSession,
  turnId: number,
  acc: TurnAccumulator,
  event: ChatStreamEvent,
): void {
  switch (event.type) {
    case 'assistant.start':
      return;
    case 'assistant.delta':
      acc.aiText += event.delta;
      emit(win, {
        appId: session.appId,
        turnId,
        kind: 'assistant-delta',
        delta: event.delta,
      });
      return;
    case 'reasoning.delta':
      // The renderer's existing protocol doesn't surface reasoning
      // separately; treat as a thinking placeholder so the UI keeps a
      // sense of progress.
      emit(win, { appId: session.appId, turnId, kind: 'thinking' });
      return;
    case 'tool.start': {
      acc.pending.set(event.toolCallId, {
        tool: event.toolName,
        sql: event.sql,
        args: event.args,
      });
      emit(win, {
        appId: session.appId,
        turnId,
        kind: 'tool-call',
        toolName: event.toolName,
        toolArgs: event.args,
        sql: event.sql,
      });
      return;
    }
    case 'tool.result': {
      const pending = acc.pending.get(event.toolCallId);
      acc.pending.delete(event.toolCallId);
      if (event.ok) {
        emit(win, {
          appId: session.appId,
          turnId,
          kind: 'tool-result',
          toolName: event.toolName || pending?.tool || 'tool',
          toolResult: event.result,
        });
        acc.batch.push({
          kind: 'tool',
          id: event.toolCallId || `t${turnId}-${Date.now()}`,
          tool: pending?.tool ?? event.toolName,
          sql: pending?.sql,
          args: pending?.args,
          state: 'ok',
          result: event.result,
        });
      } else {
        const text = event.errorText ?? 'Tool failed.';
        emit(win, {
          appId: session.appId,
          turnId,
          kind: 'tool-error',
          toolName: event.toolName || pending?.tool || 'tool',
          text,
        });
        acc.batch.push({
          kind: 'tool',
          id: event.toolCallId || `t${turnId}-${Date.now()}`,
          tool: pending?.tool ?? event.toolName,
          sql: pending?.sql,
          args: pending?.args,
          state: 'error',
          errorText: text,
        });
      }
      return;
    }
    case 'final':
      if (acc.aiText.trim().length > 0 || event.text.trim().length > 0) {
        const text = acc.aiText || event.text;
        acc.batch.push({ kind: 'ai', text });
      }
      emit(win, {
        appId: session.appId,
        turnId,
        kind: 'final',
        text: acc.aiText || event.text,
      });
      return;
    case 'aborted':
      emit(win, { appId: session.appId, turnId, kind: 'aborted' });
      return;
    case 'error':
      emit(win, { appId: session.appId, turnId, kind: 'error', text: event.message });
      acc.batch.push({ kind: 'ai', text: event.message, error: true });
      return;
    case 'phase':
      // diagnostic — surface as thinking so the UI keeps a heartbeat.
      emit(win, { appId: session.appId, turnId, kind: 'thinking' });
  }
}

async function runTurn(
  win: BrowserWindow,
  session: ChatSession,
  text: string,
  turnId: number,
): Promise<void> {
  session.turnId = turnId;
  emit(win, { appId: session.appId, turnId, kind: 'thinking' });
  const acc = newAccumulator();
  const settings = await loadSettings();
  const harness = await loadChatHarness();

  try {
    const handle = await harness.openChatStream({
      config: {
        gatewayUrl: settings.gatewayUrl,
        gatewayToken: settings.gatewayToken,
      },
      appId: session.appId,
      windowId: session.windowId,
      message: text,
      mode: session.mode,
    });
    session.currentAbort = () => handle.abort();
    try {
      for await (const event of handle.events) {
        handleStreamEvent(win, session, turnId, acc, event);
      }
    } finally {
      session.currentAbort = null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit(win, { appId: session.appId, turnId, kind: 'error', text: msg });
    acc.batch.push({ kind: 'ai', text: msg, error: true });
  } finally {
    session.turnId = null;
    flushBatch(session.chatSessionId, acc.batch);
  }
}

/**
 * Mint a fresh per-pane window id. Uses chat-history row ids when
 * available so a refresh + reload reuses the same gateway window id and
 * resumes the same CLI session.
 */
function mintWindowId(chatSessionId: string | null): string {
  if (chatSessionId) {
    // Window ids are constrained to `[A-Za-z0-9_\-:]+`; UUIDs match.
    return chatSessionId.replace(/[^A-Za-z0-9_\-:]/g, '');
  }
  return `w${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function registerChatIpcHandlers(): void {
  ipcMain.handle(
    ChatChannel.START,
    async (
      event,
      input: {
        appId: string;
        appName: string;
        sessionId?: string | null;
        mode?: ChatMode;
      },
    ): Promise<{ ok: true; sessionId: string | null }> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) throw new Error('no window for chat session');
      const key = sessionKey(win.id, input.appId);
      const prior = sessions.get(key);
      if (prior?.currentAbort) prior.currentAbort();
      const chatSessionId = input.sessionId ?? null;
      sessions.set(key, {
        appId: input.appId,
        appName: input.appName,
        chatSessionId,
        windowId: mintWindowId(chatSessionId),
        mode: input.mode === 'data' ? 'data' : 'full',
        currentAbort: null,
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

      if (!session.chatSessionId) {
        const created = await historyCreate(session.appId, '');
        session.chatSessionId = created.id;
        // Rebind the window id to the freshly-created chat session so
        // subsequent reloads of this row resume the same gateway window.
        session.windowId = mintWindowId(session.chatSessionId);
      }

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
      if (!session?.currentAbort) return { ok: true };
      try {
        session.currentAbort();
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

  // Model picker — model selection is owned by the gateway-side runner
  // (OpenClaw config / codex / claude-code defaults). Return empty so the
  // renderer falls back to "default".
  ipcMain.handle(
    ChatChannel.MODELS,
    async () => [] as Array<{ id: string; name: string; provider: string }>,
  );

  // ---------- Chat history (renderer's persistent chat list) ----------
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
    if (session.currentAbort) {
      try {
        session.currentAbort();
      } catch {
        /* swallow */
      }
    }
    sessions.delete(key);
  }
}
