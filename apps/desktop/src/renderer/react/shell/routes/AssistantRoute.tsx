import { type JSX, useEffect, useRef } from 'react';
import {
  ASSISTANT_APP_ID,
  createConversation,
  deleteConversation,
  getUserPrefs,
  listConversations,
  loadConversation,
  streamAssistantTurn,
  type TurnStreamEvent,
} from '../../../gateway-client.js';
import { relativeTime } from '../../../app-format.js';
import mainScrollCss from '../../styles/mainScroll.module.css';
import type { AssistantSnapshot, AsstMsgDTO } from '../../screen-contracts.js';
import AssistantScreen from '../../screens/AssistantScreen.js';
import { useShellActions } from '../actions.js';
import { hydrateRefs, richAnswerHtml } from './assistantRich.js';

interface AsstToolCall {
  id: string;
  tool: string;
  sql?: string;
  state: 'run' | 'ok' | 'error';
  totalRows?: number;
  durationMs?: number;
  errorText?: string;
}
type AsstMsg =
  | { kind: 'user'; text: string }
  | { kind: 'ai'; text: string; error?: boolean; streaming?: boolean }
  | { kind: 'tools'; calls: AsstToolCall[] };

// Resolves the model the user picked in Settings → Agents → "Default model
// for Claude Code" (persisted per-runner as `chatModelByRunner[kind]`) for
// whichever runner kind is currently active. Mirrors the exact read pattern
// `settingsProvidersData.ts`'s `loadProviders()` uses for the same two prefs.
// Fetched fresh on every send rather than cached in the route's ref/state:
// the user can flip this in Settings without leaving/remounting Assistant,
// and a couple of tiny IPC reads per turn-send is cheap compared to silently
// sending stale-model turns. Returns `undefined` (never `''`) when there's no
// saved preference for the active kind, so callers omit `model` entirely and
// the Claude Agent SDK's own default still applies — matching prior behavior.
async function resolveActiveChatModel(): Promise<string | undefined> {
  const [kindRaw, modelMap] = await Promise.all([
    getUserPrefs()
      .then((p) => p['agent.runner.kind'])
      .catch(() => undefined),
    window.CentraidApi.getSettings()
      .then((s) => s.chatModelByRunner)
      .catch(() => undefined),
  ]);
  const kind = kindRaw === 'claude-code' ? 'claude-code' : 'codex';
  const model = modelMap?.[kind];
  return model ? model : undefined;
}

const SUGGESTIONS = [
  'What did I spend the most on last month?',
  'Who have I not talked to in a while?',
  'What tasks are due this week?',
  'Which notes mention travel plans?',
];

// React-owned Assistant copilot — replaces the vanilla renderAssistant. Owns the
// SSE stream + thread model + the rich-answer renderer (assistantRich) and pushes
// a derived snapshot into AssistantScreen via its onReady updater (the same
// contract the vanilla side used). The mutable model lives in a ref (the
// snapshot, not React state, is the source of truth for the screen).
export default function AssistantRoute(): JSX.Element {
  const { showToast, confirm } = useShellActions();
  const m = useRef({
    threads: [] as CentraidConversationSummary[],
    currentId: null as string | null,
    msgs: [] as AsstMsg[],
    busy: false,
    abort: null as AbortController | null,
    disposed: false,
  });
  const updateRef = useRef<((s: AssistantSnapshot) => void) | null>(null);

  const toMsgDTO = (msg: AsstMsg): AsstMsgDTO => {
    if (msg.kind === 'user') return { kind: 'user', text: msg.text };
    if (msg.kind === 'tools') {
      const n = msg.calls.length;
      const running = msg.calls.some((c) => c.state === 'run');
      const failed = msg.calls.filter((c) => c.state === 'error').length;
      const ms = msg.calls.reduce((a, c) => a + (c.durationMs ?? 0), 0);
      const label = running
        ? 'querying the vault…'
        : `${n} ${n === 1 ? 'query' : 'queries'}${ms ? ` · ${ms}ms` : ''}${failed ? ` · ${failed} failed` : ''}`;
      return {
        kind: 'tools',
        label,
        calls: msg.calls.map((c) => ({
          tool: c.tool,
          ...(c.sql ? { sql: c.sql } : {}),
          state: c.state,
          meta:
            c.state === 'error'
              ? (c.errorText ?? 'failed')
              : c.state === 'ok'
                ? `${c.totalRows ?? '?'} rows${c.durationMs ? ` · ${c.durationMs}ms` : ''}`
                : 'running…',
        })),
      };
    }
    if (msg.streaming) return { kind: 'ai', streaming: true, text: msg.text };
    return {
      kind: 'ai',
      streaming: false,
      html: richAnswerHtml(msg.text),
      error: Boolean(msg.error),
    };
  };

  const buildSnapshot = (): AssistantSnapshot => ({
    threads: m.current.threads.map((t) => ({
      id: t.id,
      title: t.title || 'New conversation',
      timeLabel: relativeTime(new Date(t.updatedAt).toISOString()),
      active: t.id === m.current.currentId,
    })),
    empty: m.current.msgs.length === 0,
    busy: m.current.busy,
    messages: m.current.msgs.map(toMsgDTO),
  });
  const push = (): void => updateRef.current?.(buildSnapshot());
  const setBusy = (b: boolean): void => {
    m.current.busy = b;
    push();
  };

  const hydrate = (rows: Array<{ payload: CentraidConversationHistoryMessage }>): AsstMsg[] => {
    const out: AsstMsg[] = [];
    for (const { payload } of rows) {
      if (payload.kind === 'user') out.push({ kind: 'user', text: payload.text ?? '' });
      else if (payload.kind === 'ai')
        out.push({
          kind: 'ai',
          text: payload.text ?? '',
          ...(payload.error ? { error: true } : {}),
        });
      else if (payload.kind === 'tool') {
        const call: AsstToolCall = {
          id: payload.id ?? String(out.length),
          tool: payload.tool ?? 'vault_sql',
          ...(payload.sql ? { sql: payload.sql } : {}),
          state: payload.state === 'ok' ? 'ok' : 'error',
          ...(payload.state !== 'ok' && payload.errorText ? { errorText: payload.errorText } : {}),
        };
        const result = payload.result as { totalRows?: number; durationMs?: number } | undefined;
        if (result && typeof result.totalRows === 'number') call.totalRows = result.totalRows;
        if (result && typeof result.durationMs === 'number') call.durationMs = result.durationMs;
        const last = out.at(-1);
        if (last?.kind === 'tools') last.calls.push(call);
        else out.push({ kind: 'tools', calls: [call] });
      }
    }
    return out;
  };

  const loadThreads = async (): Promise<void> => {
    try {
      m.current.threads = await listConversations(ASSISTANT_APP_ID);
    } catch {
      m.current.threads = [];
    }
    if (!m.current.disposed) push();
  };

  const selectThread = async (id: string | null): Promise<void> => {
    m.current.abort?.abort();
    setBusy(false);
    m.current.currentId = id;
    m.current.msgs = [];
    push();
    if (!id) return;
    try {
      const loaded = await loadConversation(ASSISTANT_APP_ID, id);
      if (m.current.disposed || m.current.currentId !== id) return;
      m.current.msgs = hydrate(loaded.messages);
    } catch (err) {
      if (m.current.disposed) return;
      m.current.msgs = [{ kind: 'ai', text: `Failed to load: ${String(err)}`, error: true }];
    }
    push();
  };

  const deleteThread = async (id: string): Promise<void> => {
    const t = m.current.threads.find((x) => x.id === id);
    const yes = await confirm({
      title: 'Delete conversation?',
      message: `“${t?.title || 'New conversation'}” will be removed from this vault's history.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!yes) return;
    await deleteConversation(ASSISTANT_APP_ID, id).catch(() => undefined);
    m.current.threads = m.current.threads.filter((x) => x.id !== id);
    if (m.current.currentId === id) await selectThread(null);
    else push();
  };

  const submit = async (textArg?: string): Promise<void> => {
    const text = (textArg ?? '').trim();
    if (!text || m.current.busy) return;
    if (!m.current.currentId) {
      try {
        const created = await createConversation(ASSISTANT_APP_ID, '');
        m.current.currentId = created.id;
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Could not start a conversation');
        return;
      }
    }
    const conversationId = m.current.currentId;
    m.current.msgs.push({ kind: 'user', text });
    push();
    setBusy(true);
    m.current.abort = new AbortController();

    let ai: Extract<AsstMsg, { kind: 'ai' }> | null = null;
    const ensureAi = (): Extract<AsstMsg, { kind: 'ai' }> => {
      if (!ai) {
        ai = { kind: 'ai', text: '', streaming: true };
        m.current.msgs.push(ai);
        push();
      }
      return ai;
    };
    const byCall = new Map<string, AsstToolCall>();

    const onEvent = (event: TurnStreamEvent): void => {
      if (m.current.disposed || m.current.currentId !== conversationId) return;
      switch (event.type) {
        case 'assistant.delta': {
          ensureAi().text += event.delta;
          push();
          return;
        }
        case 'tool.start': {
          const call: AsstToolCall = {
            id: event.toolCallId,
            tool: event.toolName,
            ...(event.sql ? { sql: event.sql } : {}),
            state: 'run',
          };
          byCall.set(event.toolCallId, call);
          const anchor = ai ? m.current.msgs.indexOf(ai) : m.current.msgs.length;
          const prev = m.current.msgs[anchor - 1];
          if (prev?.kind === 'tools') prev.calls.push(call);
          else m.current.msgs.splice(anchor, 0, { kind: 'tools', calls: [call] });
          push();
          return;
        }
        case 'tool.result': {
          const call = byCall.get(event.toolCallId);
          if (!call) return;
          call.state = event.ok ? 'ok' : 'error';
          if (!event.ok) call.errorText = event.errorText ?? 'failed';
          const result = event.result as { totalRows?: number; durationMs?: number } | undefined;
          if (result && typeof result.totalRows === 'number') call.totalRows = result.totalRows;
          if (result && typeof result.durationMs === 'number') call.durationMs = result.durationMs;
          push();
          return;
        }
        case 'final': {
          const msg = ensureAi();
          msg.text = msg.text || event.text;
          msg.streaming = false;
          push();
          return;
        }
        case 'error': {
          m.current.msgs.push({ kind: 'ai', text: event.message, error: true });
          push();
          break;
        }
        case 'assistant.start':
        case 'reasoning.delta':
        case 'phase':
        case 'aborted':
        case 'usage':
        case 'webhooks':
          // No UI surface for these yet (start/phase/usage are informational,
          // reasoning traces aren't rendered, webhook minting is a builder-chat
          // concern handled elsewhere). The outer stream's `finally` already
          // clears the streaming indicator regardless of how the turn ends.
          break;
      }
    };

    try {
      const model = await resolveActiveChatModel();
      await streamAssistantTurn(
        { conversationId, message: text, ...(model ? { model } : {}) },
        onEvent,
        m.current.abort.signal,
      );
    } catch (err) {
      if (!m.current.disposed && !(err instanceof DOMException && err.name === 'AbortError')) {
        m.current.msgs.push({
          kind: 'ai',
          text: err instanceof Error ? err.message : String(err),
          error: true,
        });
      }
    } finally {
      if (!m.current.disposed && m.current.currentId === conversationId) {
        const live = m.current.msgs.find(
          (msg): msg is Extract<AsstMsg, { kind: 'ai' }> =>
            msg.kind === 'ai' && msg.streaming === true,
        );
        if (live) live.streaming = false;
        setBusy(false);
        push();
        void loadThreads();
      }
    }
  };

  useEffect(() => {
    const model = m.current;
    model.disposed = false;
    void loadThreads();
    return () => {
      model.disposed = true;
      model.abort?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#325) mount-once thread load, deliberately []
  }, []);

  return (
    <div className={mainScrollCss.hasWall}>
      <AssistantScreen
        suggestions={SUGGESTIONS}
        onReady={(update) => {
          updateRef.current = update;
          update(buildSnapshot());
        }}
        onSend={(text) => void submit(text)}
        onStop={() => {
          m.current.abort?.abort();
          setBusy(false);
        }}
        onSelectThread={(id) => void selectThread(id)}
        onDeleteThread={(id) => void deleteThread(id)}
        hydrateRefs={(node) => hydrateRefs(node)}
      />
    </div>
  );
}
