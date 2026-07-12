import { type JSX, useEffect, useRef } from 'react';
import {
  ASSISTANT_APP_ID,
  createConversation,
  loadConversation,
  streamAssistantTurn,
  uploadConversationAttachment,
  MAX_ATTACHMENT_BYTES,
  type ConversationAttachmentRef,
  type TurnStreamEvent,
} from '../../../gateway-client.js';
import mainScrollCss from '../../styles/mainScroll.module.css';
import type {
  AssistantSnapshot,
  AsstMsgDTO,
  AsstModelPickerDTO,
  AgentRunnerKind,
} from '../../screen-contracts.js';
import AssistantScreen from '../../screens/AssistantScreen.js';
import { useShellActions } from '../actions.js';
import { hydrateRefs, richAnswerHtml } from './assistantRich.js';
import { loadProviders, setSubsystemModel } from './settingsProvidersData.js';

interface AsstToolCall {
  id: string;
  tool: string;
  sql?: string;
  state: 'run' | 'ok' | 'error';
  totalRows?: number;
  durationMs?: number;
  errorText?: string;
}
interface AsstAttachment {
  hash: string;
  mime: string;
  filename?: string;
  sizeBytes: number;
}
type AsstMsg =
  | { kind: 'user'; text: string; attachments?: AsstAttachment[] }
  | { kind: 'ai'; text: string; error?: boolean; streaming?: boolean }
  | { kind: 'tools'; calls: AsstToolCall[] };

/** A file the composer has uploaded (or is uploading) ahead of the next
 *  send — issue #190. Not persisted; lives only in this route's ref model
 *  until it rides a turn (then it's folded into the sent user message) or
 *  is removed. */
interface PendingAttachment {
  localId: string;
  filename: string;
  sizeBytes: number;
  mime: string;
  state: 'uploading' | 'ready' | 'error';
  errorText?: string;
  ref?: ConversationAttachmentRef;
}

const SUGGESTIONS = [
  'What did I spend the most on last month?',
  'Who have I not talked to in a while?',
  'What tasks are due this week?',
  'Which notes mention travel plans?',
];

interface AssistantRouteProps {
  /** The open conversation's id, from the shell route (`{kind:'assistant',
   *  conversationId}`) — `undefined` is a fresh, not-yet-created
   *  conversation. Driving selection from the route (rather than an
   *  internal thread list) is what lets the shell sidebar's "Chats" list
   *  be the one place a conversation gets picked. */
  conversationId?: string;
}

// React-owned Assistant copilot — replaces the vanilla renderAssistant. Owns the
// SSE stream + message model + the rich-answer renderer and pushes a derived
// snapshot into AssistantScreen via its onReady updater. The mutable model
// lives in a ref (the snapshot, not React state, is the source of truth for
// the screen). The conversation LIST lives in the shell sidebar now (App.tsx
// owns useAssistantConversations); this route only loads/streams the ONE
// conversation named by its `conversationId` prop.
export default function AssistantRoute({ conversationId }: AssistantRouteProps): JSX.Element {
  const { showToast, replace, refreshAssistantThreads } = useShellActions();
  const m = useRef({
    currentId: null as string | null,
    msgs: [] as AsstMsg[],
    pendingAttachments: [] as PendingAttachment[],
    busy: false,
    abort: null as AbortController | null,
    disposed: false,
  });
  const updateRef = useRef<((s: AssistantSnapshot) => void) | null>(null);
  // Set right after `submit()` lazily creates a conversation and replaces
  // the route to carry its id — the resulting `conversationId` prop change
  // would otherwise re-trigger the load effect below and stomp the
  // in-progress local state with a (still-empty) server round-trip.
  const suppressSelectRef = useRef<string | null>(null);
  // The active runner kind as of the last `loadModelPicker()` — needed by
  // `onSetModel` to write the right `model.<kind>.assistant` pref key
  // without re-fetching (matches settingsProvidersData.ts's write path).
  const modelPickerRunnerRef = useRef<AgentRunnerKind>('codex');

  const toMsgDTO = (msg: AsstMsg): AsstMsgDTO => {
    if (msg.kind === 'user')
      return {
        kind: 'user',
        text: msg.text,
        ...(msg.attachments?.length
          ? {
              attachments: msg.attachments.map((a) => ({
                hash: a.hash,
                filename: a.filename ?? 'Attachment',
                mime: a.mime,
                sizeBytes: a.sizeBytes,
              })),
            }
          : {}),
      };
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
    empty: m.current.msgs.length === 0,
    busy: m.current.busy,
    messages: m.current.msgs.map(toMsgDTO),
    pendingAttachments: m.current.pendingAttachments.map((a) => ({
      id: a.localId,
      filename: a.filename,
      sizeBytes: a.sizeBytes,
      state: a.state,
      ...(a.errorText ? { errorText: a.errorText } : {}),
    })),
  });
  const push = (): void => updateRef.current?.(buildSnapshot());
  const setBusy = (b: boolean): void => {
    m.current.busy = b;
    push();
  };

  const hydrate = (rows: Array<{ payload: CentraidConversationHistoryMessage }>): AsstMsg[] => {
    const out: AsstMsg[] = [];
    for (const { payload } of rows) {
      if (payload.kind === 'user')
        out.push({
          kind: 'user',
          text: payload.text ?? '',
          // Defensive: `attachments` is a newer field on persisted user
          // turns — absent on messages sent before it existed.
          ...(payload.attachments?.length
            ? {
                attachments: payload.attachments.map((a) => ({
                  hash: a.hash,
                  mime: a.mime,
                  ...(a.filename ? { filename: a.filename } : {}),
                  sizeBytes: a.sizeBytes,
                })),
              }
            : {}),
        });
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

  const selectThread = async (id: string | null): Promise<void> => {
    m.current.abort?.abort();
    setBusy(false);
    m.current.currentId = id;
    m.current.msgs = [];
    // Files staged for a different conversation shouldn't silently ride
    // along with whichever one the user switches to next.
    m.current.pendingAttachments = [];
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

  const attachFiles = (files: File[]): void => {
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        showToast(`"${file.name}" is over the 25MB attachment limit.`);
        continue;
      }
      const localId = crypto.randomUUID();
      const mime = file.type || 'application/octet-stream';
      m.current.pendingAttachments.push({
        localId,
        filename: file.name,
        sizeBytes: file.size,
        mime,
        state: 'uploading',
      });
      push();
      void (async () => {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const ref = await uploadConversationAttachment(ASSISTANT_APP_ID, bytes, mime, file.name);
          if (m.current.disposed) return;
          const entry = m.current.pendingAttachments.find((a) => a.localId === localId);
          if (entry) {
            entry.state = 'ready';
            entry.ref = ref;
          }
          push();
        } catch (err) {
          if (m.current.disposed) return;
          const entry = m.current.pendingAttachments.find((a) => a.localId === localId);
          if (entry) {
            entry.state = 'error';
            entry.errorText = err instanceof Error ? err.message : 'Upload failed';
          }
          push();
        }
      })();
    }
  };

  // Composer model picker — reuses the exact Settings → Models → Agents data
  // path (settingsProvidersData.ts): the active runner's catalog + the
  // `model.<kind>.assistant` subsystem pref. No model field ever rides the
  // turn request — the gateway resolves the effective model server-side
  // from this same pref at turn time.
  const loadModelPicker = async (): Promise<AsstModelPickerDTO> => {
    const status = await loadProviders();
    modelPickerRunnerRef.current = status.selectedKind;
    const card = status.cards.find((c) => c.kind === status.selectedKind);
    const models = card?.models ?? [];
    const defaultId = status.savedModelByKind[status.selectedKind] ?? '';
    const defaultModel =
      models.find((m) => m.id === defaultId) ?? models.find((m) => m.default) ?? models[0];
    return {
      connected: card?.connected ?? false,
      models: models.map((m) => ({
        id: m.id,
        ...(m.name ? { name: m.name } : {}),
        ...(m.default ? { default: true } : {}),
      })),
      defaultModelName: defaultModel?.name ?? defaultModel?.id ?? 'gateway default',
      selectedModelId: status.subsystemModelByKind[status.selectedKind]?.assistant ?? '',
    };
  };

  const setModel = (modelId: string): void => {
    setSubsystemModel(modelPickerRunnerRef.current, 'assistant', modelId);
  };

  const removePendingAttachment = (localId: string): void => {
    m.current.pendingAttachments = m.current.pendingAttachments.filter(
      (a) => a.localId !== localId,
    );
    push();
  };

  const submit = async (textArg?: string): Promise<void> => {
    const text = (textArg ?? '').trim();
    if (m.current.busy) return;
    if (m.current.pendingAttachments.some((a) => a.state === 'uploading')) {
      showToast('Wait for attachments to finish uploading.');
      return;
    }
    const ready = m.current.pendingAttachments.filter(
      (a): a is PendingAttachment & { ref: ConversationAttachmentRef } =>
        a.state === 'ready' && a.ref !== undefined,
    );
    if (!text && ready.length === 0) return;
    if (!m.current.currentId) {
      try {
        const created = await createConversation(ASSISTANT_APP_ID, '');
        m.current.currentId = created.id;
        suppressSelectRef.current = created.id;
        replace?.({ kind: 'assistant', conversationId: created.id });
        refreshAssistantThreads?.();
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Could not start a conversation');
        return;
      }
    }
    const conversationId = m.current.currentId;
    m.current.msgs.push({
      kind: 'user',
      text,
      ...(ready.length
        ? {
            attachments: ready.map((a) => ({
              hash: a.ref.hash,
              mime: a.ref.mime,
              filename: a.filename,
              sizeBytes: a.ref.sizeBytes,
            })),
          }
        : {}),
    });
    m.current.pendingAttachments = m.current.pendingAttachments.filter((a) => a.state !== 'ready');
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
      await streamAssistantTurn(
        {
          conversationId,
          message: text,
          ...(ready.length ? { attachments: ready.map((a) => a.ref) } : {}),
        },
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
        // A completed turn can change the sidebar row's title (first turn)
        // and timestamp — refresh the shell's conversation list.
        refreshAssistantThreads?.();
      }
    }
  };

  // Disposal lifecycle — abort any in-flight turn and stop pushing snapshots
  // once the route unmounts (navigating away from Assistant entirely).
  useEffect(() => {
    const model = m.current;
    model.disposed = false;
    return () => {
      model.disposed = true;
      model.abort?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount lifecycle only, deliberately []
  }, []);

  // Drive which conversation is loaded from the route. Fires on mount (with
  // whatever `conversationId` the route opened with) and again whenever the
  // sidebar/route changes it — except right after `submit()` itself just
  // created + replaced to this id, which the suppress guard above skips.
  useEffect(() => {
    if (conversationId && suppressSelectRef.current === conversationId) {
      suppressSelectRef.current = null;
      return;
    }
    void selectThread(conversationId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectThread closes over the stable ref model, not React state
  }, [conversationId]);

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
        onAttachFiles={attachFiles}
        onRemovePendingAttachment={removePendingAttachment}
        hydrateRefs={(node) => hydrateRefs(node)}
        loadModelPicker={loadModelPicker}
        onSetModel={setModel}
      />
    </div>
  );
}
