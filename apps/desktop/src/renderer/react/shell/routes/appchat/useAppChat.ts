import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  createConversation,
  deleteConversation,
  getUserPrefs,
  listConversations,
  loadConversation,
  streamTurn,
  uploadConversationAttachment,
  type ConversationAttachmentRef,
  type TurnStreamEvent,
} from '../../../../gateway-client.js';
import {
  type AppConversationMsg,
  type AppToolCall,
  deriveTitle,
  hydrateMessages,
  summarizeToolArgs,
} from './appChatModel.js';

/** Per-turn streaming state (mirrors the vanilla `turnState` map). */
interface TurnState {
  streamed: string;
  hadDelta: boolean;
  hadContent: boolean;
  aiIndex: number; // -1 if no AI msg yet
}

export interface AppChatModel {
  open: boolean;
  viewMode: 'chat' | 'history';
  busy: boolean;
  thinking: boolean;
  scopedContext: string;
  headContext: string;
  messages: AppConversationMsg[];
  chatLoading: boolean;
  loadError: string | null;
  attachments: ConversationAttachmentRef[];
  recentSessions: CentraidConversationSummary[];
  historySessions: CentraidConversationSummary[];
  historyLoading: boolean;
  historySearch: string;
  // actions
  toggle: (next?: boolean) => void;
  setView: (v: 'chat' | 'history') => void;
  submit: (text: string) => void;
  cancel: () => void;
  toggleGroup: (id: string) => void;
  toggleCall: (groupId: string, callId: string) => void;
  addFiles: (files: File[]) => void;
  removeAttachment: (ref: ConversationAttachmentRef) => void;
  startNewChat: () => void;
  openHistory: () => void;
  setHistorySearch: (q: string) => void;
  resumeSession: (s: CentraidConversationSummary) => void;
  deleteSession: (s: CentraidConversationSummary) => void;
  registerModelResolver: (fn: () => Promise<string | undefined>) => void;
}

/**
 * The React per-app copilot engine — a faithful port of the vanilla
 * `window.AppChat.mount` closure (app-chat.ts) minus the DOM building. It owns
 * the SSE turn stream, the typed message model, streaming indices, attachments,
 * the persisted conversation id, and the history/recent surfaces; the panel
 * (AppChatPanel) reads this view model and renders the FAB + slide-out.
 *
 * State the SSE reducer mutates synchronously across a burst of deltas lives in
 * refs (so reads/writes don't race React batching); `bump()` forces a repaint —
 * together they replace the vanilla `renderChat()` funnel.
 */
export function useAppChat(app: AppMetaResolvedType, appId: string): AppChatModel {
  const [, bump] = useReducer((n: number) => n + 1, 0);

  // ── State (refs = SSE-synchronous source of truth) ────────────────────────
  const open = useRef(false);
  const nextTurnId = useRef(1);
  const activeTurn = useRef<number | null>(null);
  const abortController = useRef<AbortController | null>(null);
  const chat = useRef<AppConversationMsg[]>([]);
  const pendingAttachments = useRef<ConversationAttachmentRef[]>([]);
  const turnState = useRef(new Map<number, TurnState>());

  const currentSessionId = useRef<string | null>(null);
  const viewMode = useRef<'chat' | 'history'>('chat');
  const headContext = useRef<string | null>(null);
  const chatLoading = useRef(false);
  const loadError = useRef<string | null>(null);

  const historySessions = useRef<CentraidConversationSummary[]>([]);
  const historyLoading = useRef(false);
  const historySearch = useRef('');
  const recentSessions = useRef<CentraidConversationSummary[]>([]);
  const recentLoaded = useRef(false);

  // Model resolution is delegated to the composer's Agent · Model picker, which
  // registers its resolver on mount; a settings/prefs fallback covers the
  // window before that happens (mirrors vanilla `resolveChatModelForActiveRunner`).
  const modelResolver = useRef<() => Promise<string | undefined>>(async () => {
    const [settings, prefs] = await Promise.all([
      window.CentraidApi.getSettings(),
      getUserPrefs().catch(() => ({}) as Record<string, unknown>),
    ]);
    const kindRaw = prefs['agent.runner.kind'];
    const kind = typeof kindRaw === 'string' && kindRaw ? kindRaw : 'codex';
    return settings.chatModelByRunner?.[kind];
  });

  const scopedContext = `scoped · ${app.name.toLowerCase().replace(/\s+/g, '-')}.app`;

  // ── Turn-state helpers ────────────────────────────────────────────────────
  const ensureTurnState = useCallback((turnId: number): TurnState => {
    const existing = turnState.current.get(turnId);
    if (existing) return existing;
    const next: TurnState = { streamed: '', hadDelta: false, hadContent: false, aiIndex: -1 };
    turnState.current.set(turnId, next);
    return next;
  }, []);

  const pushAi = useCallback((text: string, streaming: boolean): number => {
    chat.current = chat.current.concat([{ kind: 'ai', text, streaming }]);
    return chat.current.length - 1;
  }, []);

  const patchAi = useCallback(
    (idx: number, patch: Partial<Extract<AppConversationMsg, { kind: 'ai' }>>): void => {
      chat.current = chat.current.map((m, i) =>
        i === idx && m.kind === 'ai' ? { ...m, ...patch } : m,
      );
    },
    [],
  );

  const appendOrStartToolCall = useCallback((call: AppToolCall): void => {
    const lastIdx = chat.current.length - 1;
    const last = chat.current[lastIdx];
    if (last && last.kind === 'toolGroup') {
      const updated: AppConversationMsg = { ...last, calls: [...last.calls, call] };
      chat.current = chat.current.map((m, i) => (i === lastIdx ? updated : m));
    } else {
      chat.current = chat.current.concat([
        { kind: 'toolGroup', id: call.id, calls: [call], open: true },
      ]);
    }
  }, []);

  const patchToolCall = useCallback((callId: string, patch: Partial<AppToolCall>): void => {
    chat.current = chat.current.map((m) => {
      if (m.kind !== 'toolGroup') return m;
      if (!m.calls.some((c) => c.id === callId)) return m;
      return { ...m, calls: m.calls.map((c) => (c.id === callId ? { ...c, ...patch } : c)) };
    });
  }, []);

  const finishTurn = useCallback((turnId: number): void => {
    if (activeTurn.current === turnId) {
      activeTurn.current = null;
    }
  }, []);

  const announceWebhooks = useCallback(
    (minted: Array<{ automationId: string; url: string; secret: string }>): void => {
      for (const w of minted) {
        chat.current = chat.current.concat([
          {
            kind: 'ai',
            text: `Webhook created for ${w.automationId}.\nURL: ${w.url}\nSecret (shown once — copy it now): ${w.secret}`,
          },
        ]);
      }
    },
    [],
  );

  // ── SSE reducer ───────────────────────────────────────────────────────────
  const handleStreamEvent = useCallback(
    (turnId: number, event: TurnStreamEvent): void => {
      const state = ensureTurnState(turnId);
      switch (event.type) {
        case 'assistant.start':
        case 'reasoning.delta':
        case 'phase':
        case 'usage':
          return;
        case 'assistant.delta':
          state.hadDelta = true;
          state.hadContent = true;
          state.streamed += event.delta;
          if (state.aiIndex < 0) state.aiIndex = pushAi(state.streamed, true);
          else patchAi(state.aiIndex, { text: state.streamed, streaming: true });
          bump();
          return;
        case 'tool.start':
          state.hadContent = true;
          // A tool call after streamed AI text closes the bubble so later
          // deltas don't reattach to it.
          if (state.aiIndex >= 0) {
            patchAi(state.aiIndex, { streaming: false });
            state.aiIndex = -1;
          }
          appendOrStartToolCall({
            id: event.toolCallId,
            tool: event.toolName,
            sql: event.sql,
            args: event.args,
            summary: summarizeToolArgs(event.sql, event.args),
            state: 'running',
          });
          bump();
          return;
        case 'tool.result':
          patchToolCall(
            event.toolCallId,
            event.ok
              ? { state: 'ok', result: event.result }
              : { state: 'error', errorText: event.errorText ?? 'Tool failed.' },
          );
          bump();
          return;
        case 'webhooks':
          announceWebhooks(event.minted);
          bump();
          return;
        case 'final':
          if (state.aiIndex >= 0) {
            patchAi(state.aiIndex, { streaming: false });
          } else if (event.text) {
            state.aiIndex = pushAi(event.text, false);
            state.hadContent = true;
          }
          finishTurn(turnId);
          bump();
          return;
        case 'error': {
          const msg = event.message || 'Something went wrong.';
          if (state.aiIndex >= 0) {
            patchAi(state.aiIndex, { streaming: false, error: true, text: msg });
          } else {
            state.aiIndex = pushAi(msg, false);
            patchAi(state.aiIndex, { error: true });
            state.hadContent = true;
          }
          finishTurn(turnId);
          bump();
          return;
        }
        case 'aborted':
          if (state.aiIndex >= 0) {
            patchAi(state.aiIndex, { streaming: false });
          } else {
            state.aiIndex = pushAi('(stopped)', false);
            state.hadContent = true;
          }
          finishTurn(turnId);
          bump();
      }
    },
    [
      announceWebhooks,
      appendOrStartToolCall,
      ensureTurnState,
      finishTurn,
      patchAi,
      patchToolCall,
      pushAi,
    ],
  );

  // ── Submit ────────────────────────────────────────────────────────────────
  const submit = useCallback(
    (raw: string): void => {
      const text = raw.trim();
      if (!text || activeTurn.current !== null) return;
      const turnId = nextTurnId.current++;
      activeTurn.current = turnId;
      loadError.current = null;
      chat.current = chat.current.concat([{ kind: 'user', text }]);
      ensureTurnState(turnId);
      bump();
      void (async () => {
        try {
          // Lazily create the session row on first send — its id is the chat
          // session id the gateway keys the turn (+ transcript) on.
          if (!currentSessionId.current) {
            const created = await createConversation(appId, deriveTitle(text));
            currentSessionId.current = created.id;
            headContext.current = created.title || null;
          }
          const model = await modelResolver.current();
          abortController.current = new AbortController();
          await streamTurn(
            appId,
            {
              conversationId: currentSessionId.current,
              message: text,
              // The copilot is the ASK register (issue #286 phase 2): the
              // gateway routes vault-backed apps onto the vault tools.
              register: 'ask',
              ...(model ? { model } : {}),
              ...(pendingAttachments.current.length
                ? { attachments: pendingAttachments.current }
                : {}),
            },
            (evt) => handleStreamEvent(turnId, evt),
            abortController.current.signal,
          );
          pendingAttachments.current = [];
          // Stream ended; finalize in case it closed without a terminal event.
          finishTurn(turnId);
          bump();
        } catch (err) {
          if (abortController.current?.signal.aborted) {
            handleStreamEvent(turnId, { type: 'aborted' });
            return;
          }
          const state = ensureTurnState(turnId);
          const msg = `Send failed: ${String(err)}`;
          if (state.aiIndex >= 0) {
            patchAi(state.aiIndex, { text: msg, error: true, streaming: false });
          } else {
            state.aiIndex = pushAi(msg, false);
            patchAi(state.aiIndex, { error: true });
            state.hadContent = true;
          }
          finishTurn(turnId);
          bump();
        }
      })();
    },
    [appId, ensureTurnState, finishTurn, handleStreamEvent, patchAi, pushAi],
  );

  const cancel = useCallback((): void => {
    abortController.current?.abort();
  }, []);

  /** Cancel any in-flight turn so a session switch doesn't keep streaming
   *  into a now-orphaned conversation. */
  const abortActiveTurn = useCallback((): void => {
    if (activeTurn.current !== null) {
      abortController.current?.abort();
      activeTurn.current = null;
    }
  }, []);

  // ── View / group toggles ──────────────────────────────────────────────────
  const toggleGroup = useCallback((id: string): void => {
    chat.current = chat.current.map((x) =>
      x.kind === 'toolGroup' && x.id === id ? { ...x, open: !x.open } : x,
    );
    bump();
  }, []);

  const toggleCall = useCallback((groupId: string, callId: string): void => {
    chat.current = chat.current.map((x) => {
      if (x.kind !== 'toolGroup' || x.id !== groupId) return x;
      return {
        ...x,
        calls: x.calls.map((cc) => (cc.id === callId ? { ...cc, open: !cc.open } : cc)),
      };
    });
    bump();
  }, []);

  const setView = useCallback((next: 'chat' | 'history'): void => {
    viewMode.current = next;
    bump();
  }, []);

  // ── Attachments ───────────────────────────────────────────────────────────
  const addFiles = useCallback(
    (files: File[]): void => {
      void Promise.all(
        files.map(async (file) => {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const ref = await uploadConversationAttachment(
            appId,
            bytes,
            file.type || 'application/octet-stream',
            file.name,
          );
          pendingAttachments.current.push(ref);
          bump();
        }),
      ).catch(() => undefined);
    },
    [appId],
  );

  const removeAttachment = useCallback((ref: ConversationAttachmentRef): void => {
    pendingAttachments.current = pendingAttachments.current.filter((p) => p !== ref);
    bump();
  }, []);

  // ── History / recent ──────────────────────────────────────────────────────
  const loadRecentChats = useCallback(async (): Promise<void> => {
    if (recentLoaded.current) return;
    recentLoaded.current = true;
    try {
      const sessions = (await listConversations(appId)).slice(0, 4);
      recentSessions.current = sessions;
      bump();
    } catch {
      /* swallow — recent list stays hidden */
    }
  }, [appId]);

  const startNewChat = useCallback((): void => {
    abortActiveTurn();
    currentSessionId.current = null;
    chat.current = [];
    turnState.current.clear();
    headContext.current = null;
    loadError.current = null;
    viewMode.current = 'chat';
    bump();
  }, [abortActiveTurn]);

  const openHistory = useCallback((): void => {
    viewMode.current = 'history';
    historyLoading.current = true;
    bump();
    void (async () => {
      try {
        historySessions.current = await listConversations(appId);
      } catch (err) {
        historySessions.current = [];
        console.warn('chat history list failed', err);
      } finally {
        historyLoading.current = false;
        bump();
      }
    })();
  }, [appId]);

  const setHistorySearch = useCallback((q: string): void => {
    historySearch.current = q;
    bump();
  }, []);

  const resumeSession = useCallback(
    (meta: CentraidConversationSummary): void => {
      abortActiveTurn();
      currentSessionId.current = meta.id;
      chat.current = [];
      turnState.current.clear();
      headContext.current = meta.title || null;
      viewMode.current = 'chat';
      chatLoading.current = true;
      loadError.current = null;
      bump();
      void (async () => {
        try {
          const loaded = await loadConversation(appId, meta.id);
          chat.current = hydrateMessages(loaded.messages);
        } catch (err) {
          loadError.current = `Failed to load chat: ${String(err)}`;
        } finally {
          chatLoading.current = false;
          bump();
        }
      })();
    },
    [abortActiveTurn, appId],
  );

  const deleteSession = useCallback(
    (s: CentraidConversationSummary): void => {
      void (async () => {
        try {
          await deleteConversation(appId, s.id);
          historySessions.current = historySessions.current.filter((x) => x.id !== s.id);
          recentSessions.current = recentSessions.current.filter((x) => x.id !== s.id);
          bump();
          // If we just deleted the chat the user is viewing, reset to a fresh
          // chat so they don't keep sending into a dead gateway session.
          if (currentSessionId.current === s.id) startNewChat();
        } catch (err) {
          console.warn('chat history delete failed', err);
        }
      })();
    },
    [appId, startNewChat],
  );

  // ── Open / toggle ─────────────────────────────────────────────────────────
  const toggle = useCallback(
    (next?: boolean): void => {
      open.current = next ?? !open.current;
      bump();
      if (open.current) void loadRecentChats();
    },
    [loadRecentChats],
  );

  const registerModelResolver = useCallback(
    (fn: () => Promise<string | undefined>): void => {
      modelResolver.current = fn;
    },
    [],
  );

  // Abort an in-flight turn on unmount.
  useEffect(() => {
    return () => {
      try {
        if (activeTurn.current !== null) abortController.current?.abort();
      } catch {
        /* swallow */
      }
    };
  }, []);

  // ── Derived render values ─────────────────────────────────────────────────
  const busy = activeTurn.current !== null;
  const active = activeTurn.current;
  const thinking =
    active !== null ? turnState.current.get(active)?.hadContent === false : false;

  return {
    open: open.current,
    viewMode: viewMode.current,
    busy,
    thinking,
    scopedContext,
    headContext:
      headContext.current && headContext.current.trim() ? headContext.current : scopedContext,
    messages: chat.current,
    chatLoading: chatLoading.current,
    loadError: loadError.current,
    attachments: pendingAttachments.current,
    recentSessions: recentSessions.current,
    historySessions: historySessions.current,
    historyLoading: historyLoading.current,
    historySearch: historySearch.current,
    toggle,
    setView,
    submit,
    cancel,
    toggleGroup,
    toggleCall,
    addFiles,
    removeAttachment,
    startNewChat,
    openHistory,
    setHistorySearch,
    resumeSession,
    deleteSession,
    registerModelResolver,
  };
}
