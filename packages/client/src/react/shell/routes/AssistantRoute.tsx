// governance: allow-repo-hygiene file-size-limit shared shell relocation keeps this cohesive route intact; split later under #392
import { type JSX, useEffect, useRef, useState } from 'react';
import {
  ASSISTANT_APP_ID,
  conversationStatus,
  createConversation,
  fetchAssistantAttachmentUrl,
  getUserPrefs,
  loadConversation,
  renameConversation,
  searchVaultEntities,
  setConversationFeedback,
  streamAssistantTurn,
  uploadConversationAttachment,
  MAX_ATTACHMENT_BYTES,
  type ConversationAttachmentRef,
  type TurnStreamEvent,
} from '../../../gateway-client.js';
import { openPrompt } from '../prompt.js';
import { catchUpAfterDrop } from './assistantCatchUp.js';
import { downloadConversation } from './conversationExport.js';
import { DEFAULT_STARTERS, resolveStarters } from './assistantStarters.js';
import mainScrollCss from '../../styles/mainScroll.module.css';
import type {
  AssistantSnapshot,
  AsstModelPickerDTO,
  AsstSlashCommand,
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
  const { showToast, replace, navigate, refreshAssistantThreads } = useShellActions();
  const m = useRef({
    currentId: null as string | null,
    msgs: [] as AsstMsg[],
    pendingAttachments: [] as PendingAttachment[],
    busy: false,
    abort: null as AbortController | null,
    disposed: false,
    /** Server turn count of the open thread — the reconnect catch-up baseline. */
    turnCount: 0,
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
      m.current.msgs = hydrateMessages(loaded.messages, {
        ...(loaded.hasArchivedHistory ? { hasArchivedHistory: true } : {}),
        ...(loaded.archiveUnavailable ? { archiveUnavailable: true } : {}),
      });
      m.current.turnCount = loaded.turnCount;
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
    m.current.turnCount = 0;
    push();
    if (!id) return;
    try {
      const loaded = await loadConversation(ASSISTANT_APP_ID, id);
      if (m.current.disposed || m.current.currentId !== id) return;
      m.current.msgs = hydrateMessages(loaded.messages, {
        ...(loaded.hasArchivedHistory ? { hasArchivedHistory: true } : {}),
        ...(loaded.archiveUnavailable ? { archiveUnavailable: true } : {}),
      });
      m.current.turnCount = loaded.turnCount;
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
    /** Idempotency key (issue #420). Fresh per user send; REUSED on a resend of
     *  the same message so a retry-after-drop replays instead of double-running. */
    idempotencyKey: string;
    appendUser: boolean;
    removeFromIndex?: number;
  }): Promise<void> => {
    const conversationId = m.current.currentId;
    if (!conversationId) return;
    const baselineTurnCount = m.current.turnCount;
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
    // Whether the stream produced ANY turn activity before it (maybe) dropped —
    // distinguishes a mid-turn connection loss (catch up from the ledger) from a
    // request that never started (plain failure → resend). Issue #420.
    let sawActivity = false;

    const onEvent = (event: TurnStreamEvent): void => {
      if (m.current.disposed || m.current.currentId !== conversationId) return;
      if (event.type !== 'error' && event.type !== 'aborted') sawActivity = true;
      switch (event.type) {
        case 'notice': {
          // A non-fatal runner notice (e.g. codex can't read PDF attachments).
          // Live-only — not persisted, so it won't replay on reload.
          m.current.msgs.push({ kind: 'notice', level: event.level, text: event.message });
          push();
          return;
        }
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
          // Priced server-side at the SSE seam (model-pricing.ts); the frozen
          // ledger rollup replaces it on reload.
          const costUsd = event.costUsd;
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
            idempotencyKey: opts.idempotencyKey,
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

    let streamEnded = false;
    let threw: unknown = null;
    try {
      const res = await streamAssistantTurn(
        {
          conversationId,
          message: opts.text,
          idempotencyKey: opts.idempotencyKey,
          ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
          ...(opts.attachments.length ? { attachments: opts.attachments.map((a) => a.ref) } : {}),
        },
        onEvent,
        m.current.abort.signal,
      );
      streamEnded = res.ended;
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) threw = err;
    }

    if (m.current.disposed || m.current.currentId !== conversationId) return;
    for (const msg of m.current.msgs) {
      if (msg.kind === 'thinking' && msg.streaming) msg.streaming = false;
    }
    const aborted = m.current.abort?.signal.aborted ?? false;
    // A mid-turn drop: the stream carried activity then closed WITHOUT the
    // terminal `event: end` (or threw a network error). The backend finished the
    // turn and folded it into the ledger, so catch up rather than fail (#420).
    const droppedMidTurn = !errored && !aborted && sawActivity && (threw !== null || !streamEnded);

    if (droppedMidTurn) {
      // Mark the live answer "catching up" and poll the ledger until the turn
      // settles, then reload to materialize the completed answer.
      const live = m.current.msgs.find(
        (msg): msg is Extract<AsstMsg, { kind: 'ai' }> =>
          msg.kind === 'ai' && msg.streaming === true,
      );
      if (live) live.catchingUp = true;
      else m.current.msgs.push({ kind: 'ai', text: '', streaming: true, catchingUp: true });
      push();
      const settled = await catchUpAfterDrop({
        baselineTurnCount,
        getStatus: () => conversationStatus(ASSISTANT_APP_ID, conversationId),
        isCancelled: () => m.current.disposed || m.current.currentId !== conversationId,
      });
      if (m.current.disposed || m.current.currentId !== conversationId) return;
      m.current.busy = false;
      if (settled) {
        await reloadTranscript(conversationId);
      } else {
        // Give up: drop the catch-up row and offer a one-tap resend (same key).
        m.current.msgs = m.current.msgs.filter((msg) => !(msg.kind === 'ai' && msg.catchingUp));
        m.current.msgs.push({
          kind: 'ai',
          text: "Connection lost and the turn didn't come back. You can resend.",
          error: true,
          failedText: opts.text,
          idempotencyKey: opts.idempotencyKey,
          offline: typeof navigator !== 'undefined' && navigator.onLine === false,
          ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
        });
      }
      push();
      refreshAssistantThreads?.();
      return;
    }

    const live = m.current.msgs.find(
      (msg): msg is Extract<AsstMsg, { kind: 'ai' }> => msg.kind === 'ai' && msg.streaming === true,
    );
    if (live) live.streaming = false;
    // A request that never started (threw before any activity) → resend bubble.
    if (threw !== null && !errored && !aborted) {
      m.current.msgs.push({
        kind: 'ai',
        text: threw instanceof Error ? threw.message : String(threw),
        error: true,
        failedText: opts.text,
        idempotencyKey: opts.idempotencyKey,
        offline: typeof navigator !== 'undefined' && navigator.onLine === false,
        ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
      });
      errored = true;
    }
    setBusy(false);
    push();
    refreshAssistantThreads?.();
    // On a clean turn, re-fetch so answers gain turn ids + retry pagers.
    if (!errored && !aborted) void reloadTranscript(conversationId);
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
    // Fresh idempotency key per user send (issue #420) — reused only on resend.
    await runTurn({
      text,
      attachments: ready,
      appendUser: true,
      idempotencyKey: crypto.randomUUID(),
    });
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
    // stream replaces just this turn's output. Regenerate is a deliberate NEW
    // attempt, so it gets a fresh idempotency key (issue #420).
    void runTurn({
      text: userText,
      attachments: [],
      retryOf,
      appendUser: false,
      removeFromIndex: answerIdx,
      idempotencyKey: crypto.randomUUID(),
    });
  };

  const retryError = (messageIndex: number): void => {
    if (m.current.busy) return;
    const msg = m.current.msgs[messageIndex];
    if (!msg || msg.kind !== 'ai' || !msg.error || msg.failedText === undefined) return;
    // One-tap resend REUSES the failed send's idempotency key (issue #420) so a
    // turn that actually completed server-side replays instead of double-running;
    // a legacy bubble with no key falls back to a fresh one.
    void runTurn({
      text: msg.failedText,
      attachments: [],
      idempotencyKey: msg.idempotencyKey ?? crypto.randomUUID(),
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

  // Configurable empty-state starters (§4) — from prefs `assistant.starters`,
  // defaults until they load.
  const [starters, setStarters] = useState<string[]>([...DEFAULT_STARTERS]);
  useEffect(() => {
    let cancelled = false;
    void getUserPrefs()
      .then((prefs) => {
        if (!cancelled) setStarters(resolveStarters(prefs));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // @-mention entity search (§4) — the auth-aware vault picker, mapped to the
  // composer's {type,id,title,subtitle} shape.
  const searchEntities = (
    term: string,
  ): Promise<{ type: string; id: string; title: string; subtitle?: string }[]> =>
    searchVaultEntities(term)
      .then((hits) =>
        hits.map((h) => ({
          type: h.type,
          id: h.id,
          title: h.title ?? `${h.type} ${h.id}`,
          ...(h.subtitle ? { subtitle: h.subtitle } : {}),
        })),
      )
      .catch(() => []);

  // Slash commands (§4) — minimal + extensible, each firing an existing UI
  // action. Export/Rename need an open (created) conversation.
  const hasThread = m.current.currentId !== null;
  const slashCommands: AsstSlashCommand[] = [
    { id: 'export', label: 'export', hint: 'Download as Markdown', enabled: hasThread },
    { id: 'rename', label: 'rename', hint: 'Rename this conversation', enabled: hasThread },
    { id: 'new', label: 'new', hint: 'Start a new conversation' },
  ];
  const runSlash = (id: string): void => {
    const cid = m.current.currentId;
    if (id === 'new') {
      navigate({ kind: 'assistant' });
      return;
    }
    if (!cid) return;
    if (id === 'export') {
      void loadConversation(ASSISTANT_APP_ID, cid)
        .then((conv) => downloadConversation(conv, 'markdown'))
        .catch((err: unknown) =>
          showToast(`Couldn't export: ${err instanceof Error ? err.message : String(err)}`),
        );
    } else if (id === 'rename') {
      void (async () => {
        const next = await openPrompt({
          title: 'Rename conversation',
          placeholder: 'Conversation name',
          confirmLabel: 'Rename',
        });
        if (!next) return;
        await renameConversation(ASSISTANT_APP_ID, cid, next).catch((err: unknown) =>
          showToast(`Couldn't rename: ${err instanceof Error ? err.message : String(err)}`),
        );
        refreshAssistantThreads?.();
      })();
    }
  };

  return (
    <div className={mainScrollCss.hasWall}>
      <AssistantScreen
        suggestions={starters}
        searchEntities={searchEntities}
        slashCommands={slashCommands}
        onRunSlash={runSlash}
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
