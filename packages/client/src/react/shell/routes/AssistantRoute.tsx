// governance: allow-repo-hygiene file-size-limit shared shell relocation keeps this cohesive route intact; split later under #392
import { type JSX, useEffect, useRef } from 'react';
import {
  ASSISTANT_APP_ID,
  createConversation,
  fetchAssistantAttachmentUrl,
  loadConversation,
  setConversationFeedback,
  streamAssistantTurn,
  uploadConversationAttachment,
  MAX_ATTACHMENT_BYTES,
  type ConversationAttachmentRef,
  type TurnStreamEvent,
} from '../../../gateway-client.js';
import { estimateCostUsd } from '../../screens/assistantUsage.js';
import mainScrollCss from '../../styles/mainScroll.module.css';
import type {
  AssistantSnapshot,
  AsstModelPickerDTO,
  AgentRunnerKind,
} from '../../screen-contracts.js';
import AssistantScreen from '../../screens/AssistantScreen.js';
import { useShellActions } from '../actions.js';
import { hydrateRefs, wireCodeCopy } from './assistantRich.js';
import {
  activeAttemptOf,
  hydrateMessages,
  msgToDTO,
  type AsstMsg,
  type AsstToolCall,
  type PendingAttachment,
} from './assistantTranscript.js';
import { loadProviders, setSubsystemModel } from './settingsProvidersData.js';

const SUGGESTIONS = [
  'What did I spend the most on last month?',
  'Who have I not talked to in a while?',
  'What tasks are due this week?',
  'Which notes mention travel plans?',
];

type ReadyAttachment = PendingAttachment & { ref: ConversationAttachmentRef };

interface AssistantRouteProps {
  /** The open conversation's id, from the shell route (`{kind:'assistant',
   *  conversationId}`) — `undefined` is a fresh, not-yet-created
   *  conversation. */
  conversationId?: string;
}

// React-owned Assistant copilot. Owns the SSE stream + message model + the
// rich-answer renderer and pushes a derived snapshot into AssistantScreen. The
// mutable model lives in a ref (the snapshot, not React state, is the source of
// truth for the screen). The conversation LIST lives in the shell sidebar.
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
  const suppressSelectRef = useRef<string | null>(null);
  const modelPickerRunnerRef = useRef<AgentRunnerKind>('codex');

  const buildSnapshot = (): AssistantSnapshot => {
    // The last final AI answer gates the Regenerate control — but only when
    // idle (regenerating mid-turn makes no sense).
    let lastAnswer = -1;
    if (!m.current.busy) {
      for (let i = m.current.msgs.length - 1; i >= 0; i--) {
        const msg = m.current.msgs[i];
        if (msg?.kind === 'ai' && !msg.streaming && !msg.error) {
          lastAnswer = i;
          break;
        }
      }
    }
    return {
      empty: m.current.msgs.length === 0,
      busy: m.current.busy,
      messages: m.current.msgs.map((msg, i) => msgToDTO(msg, i === lastAnswer)),
      pendingAttachments: m.current.pendingAttachments.map((a) => ({
        id: a.localId,
        filename: a.filename,
        sizeBytes: a.sizeBytes,
        state: a.state,
        mime: a.mime,
        ...(a.previewUrl ? { previewUrl: a.previewUrl } : {}),
        ...(a.errorText ? { errorText: a.errorText } : {}),
      })),
    };
  };
  const push = (): void => updateRef.current?.(buildSnapshot());
  const setBusy = (b: boolean): void => {
    m.current.busy = b;
    push();
  };

  /** Re-fetch the transcript so answers carry turn ids + retry pagers (#420). */
  const reloadTranscript = async (id: string): Promise<void> => {
    try {
      const loaded = await loadConversation(ASSISTANT_APP_ID, id);
      if (m.current.disposed || m.current.currentId !== id || m.current.busy) return;
      m.current.msgs = hydrateMessages(loaded.messages);
      push();
    } catch {
      /* keep the live model if the reload fails */
    }
  };

  const selectThread = async (id: string | null): Promise<void> => {
    m.current.abort?.abort();
    setBusy(false);
    m.current.currentId = id;
    m.current.msgs = [];
    m.current.pendingAttachments = [];
    push();
    if (!id) return;
    try {
      const loaded = await loadConversation(ASSISTANT_APP_ID, id);
      if (m.current.disposed || m.current.currentId !== id) return;
      m.current.msgs = hydrateMessages(loaded.messages);
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
      // Image attachments get a local object-URL thumbnail in the composer
      // staging area straight away — no round-trip needed (issue #420, W2).
      const previewUrl = mime.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      m.current.pendingAttachments.push({
        localId,
        filename: file.name,
        sizeBytes: file.size,
        mime,
        state: 'uploading',
        ...(previewUrl ? { previewUrl } : {}),
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
            entry.ref = {
              hash: ref.hash,
              mime: ref.mime,
              sizeBytes: ref.sizeBytes,
              ...(ref.filename ? { filename: ref.filename } : {}),
            };
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

  // Composer model picker — reuses the Settings → Models → Agents data path.
  const loadModelPicker = async (): Promise<AsstModelPickerDTO> => {
    const status = await loadProviders();
    modelPickerRunnerRef.current = status.selectedKind;
    const card = status.cards.find((c) => c.kind === status.selectedKind);
    const models = card?.models ?? [];
    const defaultId = status.savedModelByKind[status.selectedKind] ?? '';
    const defaultModel =
      models.find((mm) => mm.id === defaultId) ?? models.find((mm) => mm.default) ?? models[0];
    return {
      connected: card?.connected ?? false,
      models: models.map((mm) => ({
        id: mm.id,
        ...(mm.name ? { name: mm.name } : {}),
        ...(mm.default ? { default: true } : {}),
      })),
      defaultModelName: defaultModel?.name ?? defaultModel?.id ?? 'gateway default',
      selectedModelId: status.subsystemModelByKind[status.selectedKind]?.assistant ?? '',
    };
  };

  const setModel = (modelId: string): void =>
    setSubsystemModel(modelPickerRunnerRef.current, 'assistant', modelId);

  const removePendingAttachment = (localId: string): void => {
    const gone = m.current.pendingAttachments.find((a) => a.localId === localId);
    if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
    m.current.pendingAttachments = m.current.pendingAttachments.filter(
      (a) => a.localId !== localId,
    );
    push();
  };

  /** Auth-aware fetch of an image attachment's bytes → an object URL thumbnail. */
  const loadAttachmentImage = (hash: string, mime: string): Promise<string> =>
    fetchAssistantAttachmentUrl(ASSISTANT_APP_ID, hash, mime);

  /** The shared streaming core — every send/regenerate/retry flows through here. */
  const runTurn = async (opts: {
    text: string;
    attachments: ReadyAttachment[];
    retryOf?: string;
    appendUser: boolean;
    removeFromIndex?: number;
  }): Promise<void> => {
    const conversationId = m.current.currentId;
    if (!conversationId) return;
    if (opts.removeFromIndex !== undefined)
      m.current.msgs = m.current.msgs.slice(0, opts.removeFromIndex);
    if (opts.appendUser) {
      m.current.msgs.push({
        kind: 'user',
        text: opts.text,
        createdAt: Date.now(),
        ...(opts.attachments.length
          ? {
              attachments: opts.attachments.map((a) => ({
                hash: a.ref.hash,
                mime: a.ref.mime,
                filename: a.filename,
                sizeBytes: a.ref.sizeBytes,
              })),
            }
          : {}),
      });
    }
    push();
    setBusy(true);
    m.current.abort = new AbortController();

    let ai: Extract<AsstMsg, { kind: 'ai' }> | null = null;
    const ensureAi = (): Extract<AsstMsg, { kind: 'ai' }> => {
      if (!ai) {
        ai = { kind: 'ai', text: '', streaming: true, createdAt: Date.now() };
        m.current.msgs.push(ai);
        push();
      }
      return ai;
    };
    // Live reasoning row (issue #420, Wave 2) — ported from BuilderChatPane. It
    // streams `reasoning.delta`, collapses once the answer/tools begin, and (as
    // reasoning is not persisted) vanishes when the turn reloads from the ledger.
    let thinking: { kind: 'thinking'; text: string; streaming?: boolean } | null = null;
    const collapseThinking = (): void => {
      if (thinking && thinking.streaming) {
        thinking.streaming = false;
        push();
      }
    };
    const byCall = new Map<string, AsstToolCall>();
    let errored = false;

    const onEvent = (event: TurnStreamEvent): void => {
      if (m.current.disposed || m.current.currentId !== conversationId) return;
      switch (event.type) {
        case 'reasoning.delta':
          if (!thinking) {
            thinking = { kind: 'thinking', text: event.delta, streaming: true };
            m.current.msgs.push(thinking);
          } else {
            thinking.text += event.delta;
          }
          push();
          return;
        case 'assistant.delta':
          collapseThinking();
          ensureAi().text += event.delta;
          push();
          return;
        case 'usage': {
          const msg = ensureAi();
          const inputTokens = event.inputTokens;
          const outputTokens = event.outputTokens;
          const costUsd = estimateCostUsd(event.model, {
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
          });
          msg.usage = {
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
            ...(costUsd !== undefined ? { costUsd, estimated: true } : {}),
            ...(event.model ? { model: event.model } : {}),
          };
          push();
          return;
        }
        case 'tool.start': {
          collapseThinking();
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
          collapseThinking();
          const msg = ensureAi();
          msg.text = msg.text || event.text;
          msg.streaming = false;
          push();
          return;
        }
        case 'error': {
          errored = true;
          m.current.msgs.push({
            kind: 'ai',
            text: event.message,
            error: true,
            failedText: opts.text,
            ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
          });
          push();
          break;
        }
        default:
          // start/phase/aborted/webhooks — no UI surface yet.
          break;
      }
    };

    try {
      await streamAssistantTurn(
        {
          conversationId,
          message: opts.text,
          ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
          ...(opts.attachments.length ? { attachments: opts.attachments.map((a) => a.ref) } : {}),
        },
        onEvent,
        m.current.abort.signal,
      );
    } catch (err) {
      if (!m.current.disposed && !(err instanceof DOMException && err.name === 'AbortError')) {
        errored = true;
        m.current.msgs.push({
          kind: 'ai',
          text: err instanceof Error ? err.message : String(err),
          error: true,
          failedText: opts.text,
          ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
        });
      }
    } finally {
      if (!m.current.disposed && m.current.currentId === conversationId) {
        for (const msg of m.current.msgs) {
          if (msg.kind === 'thinking' && msg.streaming) msg.streaming = false;
        }
        const live = m.current.msgs.find(
          (msg): msg is Extract<AsstMsg, { kind: 'ai' }> =>
            msg.kind === 'ai' && msg.streaming === true,
        );
        if (live) live.streaming = false;
        setBusy(false);
        push();
        refreshAssistantThreads?.();
        // On a clean turn, re-fetch so answers gain turn ids + retry pagers.
        if (!errored) void reloadTranscript(conversationId);
      }
    }
  };

  const submit = async (textArg?: string): Promise<void> => {
    const text = (textArg ?? '').trim();
    if (m.current.busy) return;
    if (m.current.pendingAttachments.some((a) => a.state === 'uploading')) {
      showToast('Wait for attachments to finish uploading.');
      return;
    }
    const ready = m.current.pendingAttachments.filter(
      (a): a is ReadyAttachment => a.state === 'ready' && a.ref !== undefined,
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
    m.current.pendingAttachments = m.current.pendingAttachments.filter((a) => a.state !== 'ready');
    await runTurn({ text, attachments: ready, appendUser: true });
  };

  // Regenerate: re-run the most recent user message as a retry of the last
  // answer. The answer bubble is replaced by the new stream; the reload after
  // completion restores it as a "<2/2>" sibling pager.
  const regenerate = (): void => {
    if (m.current.busy) return;
    let answerIdx = -1;
    for (let i = m.current.msgs.length - 1; i >= 0; i--) {
      const msg = m.current.msgs[i];
      if (msg?.kind === 'ai' && !msg.streaming && !msg.error) {
        answerIdx = i;
        break;
      }
    }
    if (answerIdx < 0) return;
    const answer = m.current.msgs[answerIdx] as Extract<AsstMsg, { kind: 'ai' }>;
    const active = activeAttemptOf(answer);
    const retryOf = active ? active.turnId : answer.turnId;
    if (!retryOf) return;
    let userText = '';
    for (let i = answerIdx - 1; i >= 0; i--) {
      const msg = m.current.msgs[i];
      if (msg?.kind === 'user') {
        userText = msg.text;
        break;
      }
    }
    if (!userText) return;
    // Trim from the first tool/answer row after the user message so the retry
    // stream replaces just this turn's output.
    void runTurn({
      text: userText,
      attachments: [],
      retryOf,
      appendUser: false,
      removeFromIndex: answerIdx,
    });
  };

  const retryError = (messageIndex: number): void => {
    if (m.current.busy) return;
    const msg = m.current.msgs[messageIndex];
    if (!msg || msg.kind !== 'ai' || !msg.error || msg.failedText === undefined) return;
    void runTurn({
      text: msg.failedText,
      attachments: [],
      ...(msg.retryOf ? { retryOf: msg.retryOf } : {}),
      appendUser: false,
      removeFromIndex: messageIndex,
    });
  };

  const setFeedback = (turnId: string, value: 'up' | 'down'): void => {
    const conversationId = m.current.currentId;
    if (!conversationId) return;
    let applied: 'up' | 'down' | null = null;
    for (const msg of m.current.msgs) {
      if (msg.kind !== 'ai') continue;
      const attempt = msg.attempts?.find((a) => a.turnId === turnId);
      if (attempt) {
        attempt.feedback = attempt.feedback === value ? null : value;
        applied = attempt.feedback;
        break;
      }
      if (msg.turnId === turnId) {
        msg.feedback = msg.feedback === value ? null : value;
        applied = msg.feedback ?? null;
        break;
      }
    }
    push();
    void setConversationFeedback(ASSISTANT_APP_ID, conversationId, turnId, applied).catch(
      () => undefined,
    );
  };

  const pagerNav = (messageIndex: number, delta: number): void => {
    const msg = m.current.msgs[messageIndex];
    if (!msg || msg.kind !== 'ai' || !msg.attempts?.length) return;
    const next = Math.min(
      Math.max((msg.activeAttempt ?? msg.attempts.length - 1) + delta, 0),
      msg.attempts.length - 1,
    );
    msg.activeAttempt = next;
    push();
  };

  const copyMessage = (text: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => showToast('Copied to clipboard'),
      () => showToast('Could not copy'),
    );
  };

  useEffect(() => {
    const model = m.current;
    model.disposed = false;
    return () => {
      model.disposed = true;
      model.abort?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount lifecycle only, deliberately [] #392; governance: allow-no-unjustified-suppressions stable lifecycle dependency contract
  }, []);

  useEffect(() => {
    if (conversationId && suppressSelectRef.current === conversationId) {
      suppressSelectRef.current = null;
      return;
    }
    void selectThread(conversationId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectThread closes over the stable ref model, not React state #392; governance: allow-no-unjustified-suppressions stable ref model contract
  }, [conversationId]);

  return (
    <div className={mainScrollCss.hasWall}>
      <AssistantScreen
        suggestions={SUGGESTIONS}
        {...(conversationId ? { conversationId } : {})}
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
        wireCodeCopy={(node) => wireCodeCopy(node)}
        loadAttachmentImage={loadAttachmentImage}
        onCopyMessage={copyMessage}
        onFeedback={setFeedback}
        onRegenerate={regenerate}
        onRetryError={retryError}
        onPagerNav={pagerNav}
        loadModelPicker={loadModelPicker}
        onSetModel={setModel}
      />
    </div>
  );
}
