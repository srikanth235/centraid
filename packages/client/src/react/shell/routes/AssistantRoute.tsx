// governance: allow-repo-hygiene file-size-limit shared shell relocation keeps this cohesive route intact; split later under #392
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { JSX } from "react";

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
} from "../../../gateway-client.js";
import type {
  ConversationAttachmentRef,
  TurnStreamEvent,
} from "../../../gateway-client.js";
import {
  providerConsentWire,
  withProviderConsent,
} from "../../providerConsent.js";
import type {
  AssistantSnapshot,
  AsstModelPickerDTO,
  AsstSlashCommand,
  HarnessKind,
} from "../../screen-contracts.js";
import AssistantScreen from "../../screens/AssistantScreen.js";
import Icon from "../../ui/Icon.js";
import { useShellActions } from "../actions.js";
import type { ShellMenuAnchor } from "../contextMenu.js";
import { createFrameBatch } from "../frameBatch.js";
import type { FrameBatch } from "../frameBatch.js";
import { openPrompt } from "../prompt.js";
import { useCompactLayout } from "../useCompactLayout.js";
import { useOwnerScopes } from "../useOwnerScopes.js";
import { catchUpAfterDrop } from "./assistantCatchUp.js";
import AssistantConversations from "./AssistantConversations.js";
import type { AssistantConversationEntry } from "./AssistantConversations.js";
import { createTranscriptProjection } from "./assistantProjection.js";
import { hydrateRefs, wireCodeCopy } from "./assistantRich.js";
import { DEFAULT_STARTERS, resolveStarters } from "./assistantStarters.js";
import {
  activeAttemptOf,
  hydrateMessages,
  toolOutputText,
} from "./assistantTranscript.js";
import type {
  AsstMsg,
  AsstToolCall,
  PendingAttachment,
} from "./assistantTranscript.js";
import { downloadConversation } from "./conversationExport.js";
import {
  conversationScope,
  rememberConversationScope,
} from "./conversationScopes.js";
import { rejectScopedDirectory } from "./scopedDirectory.js";
import ScopePicker from "./ScopePicker.js";
import {
  loadHarnesses,
  resolveReportedHarnessKind,
  setSubsystemConfigPin,
  setSubsystemModel,
} from "./settingsHarnessesData.js";

import mainScrollCss from "../../styles/mainScroll.module.css";
import ledgerCss from "./AssistantConversations.module.css";
import scopeBarCss from "./ScopePicker.module.css";

type ReadyAttachment = PendingAttachment & { ref: ConversationAttachmentRef };

/** Wall clock for live transcript rows, at module scope (render-purity rule). */
const nowMs = (): number => Date.now();

/** Keeps bridge callbacks stable without capturing an old render: a fresh
 *  closure per streamed frame turns state updates into a full picker/transcript
 *  refresh, because AssistantScreen uses the loader as an effect dependency. */
function useStableEvent<T extends (...args: never[]) => unknown>(
  handler: T
): T {
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  return useCallback(
    (...args: Parameters<T>) => handlerRef.current(...args),
    []
  ) as T;
}

/** Turns per request (#659): never materialize a whole thread to render the
 *  last screenful. "Show earlier messages" walks back from `oldestSeq`. */
const TRANSCRIPT_PAGE_TURNS = 40;

interface AssistantRouteProps {
  /** `undefined` is a fresh, not-yet-created conversation. */
  conversationId?: string;
  /** Newest first; omitted entirely draws no column. */
  conversations?: readonly AssistantConversationEntry[];
  /** Differs from `conversationId` only before a fresh thread is created. */
  activeConversationId?: string;
  onSelectConversation?: (id: string) => void;
  onNewChat?: () => void;
  onDeleteConversation?: (id: string) => void;
  onConversationMenu?: (id: string, anchor: ShellMenuAnchor) => void;
}

// The Assistant copilot: SSE stream, message model and rich-answer renderer,
// pushed into AssistantScreen as a derived snapshot. The mutable model lives in
// a ref — the SNAPSHOT, not React state, is the screen's source of truth. The
// conversation ledger is this route's too (#707).
export default function AssistantRoute({
  conversationId,
  conversations,
  activeConversationId: ledgerActiveId,
  onSelectConversation,
  onNewChat,
  onDeleteConversation,
  onConversationMenu,
}: AssistantRouteProps): JSX.Element {
  const { showToast, replace, navigate, confirm, refreshAssistantThreads } =
    useShellActions();
  const m = useRef({
    currentId: (conversationId ?? null) as string | null,
    msgs: [] as AsstMsg[],
    pendingAttachments: [] as PendingAttachment[],
    busy: false,
    abort: null as AbortController | null,
    disposed: false,
    context: null as { used: number; size: number } | null,
    harnessKind: null as HarnessKind | null,
    /** Unresolved while a persisted conversation's transcript loads. */
    harnessReady: conversationId === undefined,
    pickerRevision: 0,
    selectedModel: "",
    selectedEffort: "",
    workspaceKind: "vault-data" as "vault-data" | "app" | "draft",
    additionalDirectories: [] as string[],
    /** The reconnect catch-up baseline. */
    turnCount: 0,
    hasMore: false,
    oldestSeq: undefined as number | undefined,
    loadingEarlier: false,
    loadedTurns: TRANSCRIPT_PAGE_TURNS,
  });
  // Chosen once, before the first message; from then on the RECORDED scope is
  // authoritative and every request repeats it, so a conversation reads exactly
  // one vault for its life. `undefined` falls back to the default scope (#599).
  const ownerScopes = useOwnerScopes();
  const [pickedScope, setPickedScope] = useState<string | undefined>(undefined);
  const activeScopeId = conversationId
    ? conversationScope(conversationId)
    : (pickedScope ?? ownerScopes.primary?.id);
  // Render-visible mirror of `m.current.currentId !== null`: render may not
  // read the model ref.
  const [hasThread, setHasThread] = useState(Boolean(conversationId));
  // Presentation only (docs/platform-gating.md): never branch capability here.
  const compact = useCompactLayout();
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const updateRef = useRef<((s: AssistantSnapshot) => void) | null>(null);
  const suppressSelectRef = useRef<string | null>(null);
  const modelPickerHarnessRef = useRef<HarnessKind>("codex");
  const harnessRequestRef = useRef(0);
  /** Invalidates stale transcript loads, StrictMode replays included. */
  const threadRequestRef = useRef(0);
  const projectionRef = useRef(createTranscriptProjection());

  const buildSnapshot = (): AssistantSnapshot => {
    let lastAnswer = -1;
    if (!m.current.busy) {
      for (let i = m.current.msgs.length - 1; i >= 0; i--) {
        const msg = m.current.msgs[i];
        if (msg?.kind === "ai" && !msg.streaming && !msg.error) {
          lastAnswer = i;
          break;
        }
      }
    }
    return {
      empty: m.current.msgs.length === 0,
      busy: m.current.busy,
      messages: projectionRef.current.project(m.current.msgs, lastAnswer),
      pendingAttachments: m.current.pendingAttachments.map((a) => ({
        id: a.localId,
        filename: a.filename,
        sizeBytes: a.sizeBytes,
        state: a.state,
        mime: a.mime,
        ...(a.previewUrl ? { previewUrl: a.previewUrl } : {}),
        ...(a.errorText ? { errorText: a.errorText } : {}),
      })),
      ...(m.current.context ? { context: m.current.context } : {}),
      workspaceKind: m.current.workspaceKind,
      ...(m.current.additionalDirectories.length
        ? { additionalDirectories: [...m.current.additionalDirectories] }
        : {}),
      canLoadEarlier: m.current.hasMore,
      loadingEarlier: m.current.loadingEarlier,
      harnessReady: m.current.harnessReady,
      pickerRevision: m.current.pickerRevision,
    };
  };

  const isCurrent = (id: string, request: number): boolean =>
    !m.current.disposed &&
    m.current.currentId === id &&
    threadRequestRef.current === request;

  const clearPendingAttachments = (): void => {
    for (const attachment of m.current.pendingAttachments) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    m.current.pendingAttachments = [];
  };
  // One projection per FRAME, not per token: re-projecting the transcript per
  // event re-renders far more often than the display can paint (#659). The
  // batched callback reads the live model when it runs, so nothing is dropped.
  const pushNow = (): void => updateRef.current?.(buildSnapshot());
  const pushBatchRef = useRef<FrameBatch | null>(null);
  pushBatchRef.current ??= createFrameBatch(() => pushNow());
  const push = (): void => pushBatchRef.current?.schedule();
  const pushSync = (): void => {
    pushBatchRef.current?.cancel();
    pushNow();
  };
  const setBusy = (b: boolean): void => {
    m.current.busy = b;
    // Busy gates the composer and Stop, so it must never wait a frame behind
    // the model — this is the flush seam, not an exception.
    pushSync();
  };

  /** Re-fetch so answers carry turn ids + retry pagers (#420). */
  const reloadTranscript = async (
    id: string,
    request = threadRequestRef.current
  ): Promise<void> => {
    try {
      // Re-request the reader's CURRENT coverage, not just the newest page:
      // otherwise finishing a turn discards history they asked for.
      const loaded = await loadConversation(
        ASSISTANT_APP_ID,
        id,
        conversationScope(id),
        { turns: m.current.loadedTurns }
      );
      if (!isCurrent(id, request) || m.current.busy) return;
      m.current.msgs = hydrateMessages(loaded.messages, {
        ...(loaded.hasArchivedHistory ? { hasArchivedHistory: true } : {}),
        ...(loaded.archiveUnavailable ? { archiveUnavailable: true } : {}),
      });
      m.current.hasMore = loaded.hasMore ?? false;
      m.current.oldestSeq = loaded.oldestSeq;
      m.current.turnCount = loaded.turnCount;
      if (loaded.harnessKind && loaded.harnessKind !== m.current.harnessKind) {
        m.current.harnessKind = loaded.harnessKind;
        m.current.pickerRevision += 1;
        harnessRequestRef.current += 1;
      }
      if (loaded.workspace) {
        m.current.workspaceKind = loaded.workspace.primaryKind;
        m.current.additionalDirectories = [
          ...loaded.workspace.additionalDirectories,
        ];
      }
      pushSync();
    } catch {
      /* keep the live model if the reload fails */
    }
  };

  const selectThread = async (id: string | null): Promise<void> => {
    const request = ++threadRequestRef.current;
    harnessRequestRef.current += 1;
    m.current.abort?.abort();
    setBusy(false);
    setHasThread(id !== null);
    m.current.currentId = id;
    m.current.msgs = [];
    clearPendingAttachments();
    m.current.turnCount = 0;
    m.current.hasMore = false;
    m.current.oldestSeq = undefined;
    m.current.loadingEarlier = false;
    m.current.loadedTurns = TRANSCRIPT_PAGE_TURNS;
    m.current.context = null;
    m.current.harnessKind = null;
    m.current.harnessReady = id === null;
    m.current.pickerRevision += 1;
    m.current.workspaceKind = "vault-data";
    m.current.additionalDirectories = [];
    // Clear in THIS frame: a stale answer under a new header is worse than a
    // frame of blank.
    pushSync();
    if (!id) return;
    try {
      // Newest page only: a reader opens to the END of a thread (#659).
      const loaded = await loadConversation(
        ASSISTANT_APP_ID,
        id,
        conversationScope(id),
        { turns: TRANSCRIPT_PAGE_TURNS }
      );
      if (!isCurrent(id, request)) return;
      m.current.msgs = hydrateMessages(loaded.messages, {
        ...(loaded.hasArchivedHistory ? { hasArchivedHistory: true } : {}),
        ...(loaded.archiveUnavailable ? { archiveUnavailable: true } : {}),
      });
      m.current.hasMore = loaded.hasMore ?? false;
      m.current.oldestSeq = loaded.oldestSeq;
      m.current.turnCount = loaded.turnCount;
      m.current.harnessKind = loaded.harnessKind ?? null;
      m.current.harnessReady = true;
      m.current.pickerRevision += 1;
      // A picker request started while unresolved must not overwrite this
      // persisted binding with the default harness.
      harnessRequestRef.current += 1;
      if (loaded.workspace) {
        m.current.workspaceKind = loaded.workspace.primaryKind;
        m.current.additionalDirectories = [
          ...loaded.workspace.additionalDirectories,
        ];
      }
    } catch (error) {
      if (!isCurrent(id, request)) return;
      m.current.msgs = [
        { kind: "ai", text: `Failed to load: ${String(error)}`, error: true },
      ];
      m.current.harnessReady = true;
      m.current.pickerRevision += 1;
    }
    if (isCurrent(id, request)) pushSync();
  };

  /**
   * PREPEND the page, never rebuild the array: the projection keys each row on
   * its message OBJECT (a WeakMap), so a rebuild re-keys the whole transcript
   * mid-scroll. Safe because a `beforeSeq` response carries only that page.
   */
  const loadEarlier = (): void => {
    const id = m.current.currentId;
    const request = threadRequestRef.current;
    const cursor = m.current.oldestSeq;
    if (!id || cursor === undefined || m.current.loadingEarlier) return;
    m.current.loadingEarlier = true;
    pushSync();
    void (async () => {
      try {
        const page = await loadConversation(
          ASSISTANT_APP_ID,
          id,
          conversationScope(id),
          { turns: TRANSCRIPT_PAGE_TURNS, beforeSeq: cursor }
        );
        if (!isCurrent(id, request)) return;
        const older = hydrateMessages(page.messages);
        m.current.msgs = [...older, ...m.current.msgs];
        m.current.hasMore = page.hasMore ?? false;
        // An empty page cannot advance the cursor: `undefined` would silently
        // retire the control.
        if (page.oldestSeq !== undefined) m.current.oldestSeq = page.oldestSeq;
        m.current.loadedTurns += TRANSCRIPT_PAGE_TURNS;
      } catch (error) {
        if (m.current.disposed || !isCurrent(id, request)) return;
        showToast(
          `Couldn't load earlier messages: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        if (isCurrent(id, request)) {
          m.current.loadingEarlier = false;
          pushSync();
        }
      }
    })();
  };

  const attachFiles = (files: File[]): void => {
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        showToast(`"${file.name}" is over the 25MB attachment limit.`);
        continue;
      }
      const localId = crypto.randomUUID();
      const mime = file.type || "application/octet-stream";
      // A local object-URL thumbnail, so staging needs no round-trip (#420).
      const previewUrl = mime.startsWith("image/")
        ? URL.createObjectURL(file)
        : undefined;
      m.current.pendingAttachments.push({
        localId,
        filename: file.name,
        sizeBytes: file.size,
        mime,
        state: "uploading",
        ...(previewUrl ? { previewUrl } : {}),
      });
      push();
      void (async () => {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const ref = await uploadConversationAttachment(
            ASSISTANT_APP_ID,
            bytes,
            mime,
            file.name,
            activeScopeId
          );
          if (m.current.disposed) return;
          const entry = m.current.pendingAttachments.find(
            (a) => a.localId === localId
          );
          if (entry) {
            entry.state = "ready";
            entry.ref = {
              hash: ref.hash,
              mime: ref.mime,
              sizeBytes: ref.sizeBytes,
              ...(ref.filename ? { filename: ref.filename } : {}),
            };
          }
          push();
        } catch (error) {
          if (m.current.disposed) return;
          const entry = m.current.pendingAttachments.find(
            (a) => a.localId === localId
          );
          if (entry) {
            entry.state = "error";
            entry.errorText =
              error instanceof Error ? error.message : "Upload failed";
          }
          push();
        }
      })();
    }
  };

  const pickerFromStatus = (
    status: Awaited<ReturnType<typeof loadHarnesses>>,
    requestedHarness?: HarnessKind | null,
    commit = true
  ): AsstModelPickerDTO => {
    const harnessKind = resolveReportedHarnessKind(
      status,
      requestedHarness,
      "assistant"
    );
    const card = status.cards.find((c) => c.kind === harnessKind);
    const models = card?.modelConfigurable ? card.models : [];
    const defaultId = status.savedModelByKind[harnessKind] ?? "";
    const defaultModel =
      models.find((mm) => mm.id === defaultId) ??
      models.find((mm) => mm.default) ??
      models[0];
    const effortOption = card?.configOptions?.find(
      (option) => option.category === "thought_level"
    );
    const defaultEffort =
      status.defaultConfigPinsByKind[harnessKind]?.thought_level ??
      effortOption?.currentValue ??
      "";
    const selectedModel =
      status.subsystemModelByKind[harnessKind]?.assistant ?? "";
    const selectedEffort =
      status.subsystemConfigPinsByKind[harnessKind]?.assistant?.thought_level ??
      "";
    if (commit) {
      m.current.harnessKind = harnessKind;
      modelPickerHarnessRef.current = harnessKind;
      m.current.selectedModel = selectedModel;
      m.current.selectedEffort = selectedEffort;
    }
    return {
      harnesses: status.cards.map((harness) => ({
        kind: harness.kind,
        title: harness.title,
        connected: harness.connected,
        sessionReady: harness.sessionReady,
        ...(harness.sessionProbePending ? { sessionProbePending: true } : {}),
        // Breaker health belongs in every picker's hint: a tripped breaker is
        // what explains a harness that looks connected but refuses the turn.
        hint: [
          harness.subtitle,
          ...(harness.breakerStates ?? []).map(
            (state) => `${state.failureClass} ${state.state}`
          ),
        ].join(" · "),
      })),
      selectedHarnessKind: harnessKind,
      workspaceKinds: ["vault-data"],
      connected: card?.connected ?? false,
      models: models.map((mm) => ({
        id: mm.id,
        ...(mm.name ? { name: mm.name } : {}),
        ...(mm.default ? { default: true } : {}),
      })),
      defaultModelName:
        defaultModel?.name ?? defaultModel?.id ?? "gateway default",
      selectedModelId: selectedModel,
      efforts: effortOption?.values ?? [],
      defaultEffortName:
        effortOption?.values.find((value) => value.value === defaultEffort)
          ?.name ?? defaultEffort,
      selectedEffortId: selectedEffort,
      supportsAdditionalDirectories: card?.additionalDirectories === true,
      supportsAttachments: card?.supportsAttachments === true,
      supportsContext: card?.supportsContext === true,
    };
  };

  const loadModelPickerNow = async (): Promise<AsstModelPickerDTO> => {
    const harnessRequest = harnessRequestRef.current;
    const threadRequest = threadRequestRef.current;
    const requestedHarness = m.current.harnessKind;
    const status = await loadHarnesses();
    const canCommit =
      !m.current.disposed &&
      m.current.harnessReady &&
      harnessRequestRef.current === harnessRequest &&
      threadRequestRef.current === threadRequest;
    return pickerFromStatus(
      status,
      canCommit ? requestedHarness : m.current.harnessKind,
      canCommit
    );
  };
  const loadModelPicker = useStableEvent(loadModelPickerNow);

  const setModel = (modelId: string): void => {
    m.current.selectedModel = modelId;
    void setSubsystemModel(modelPickerHarnessRef.current, "assistant", modelId);
  };

  const setEffort = (effort: string): void => {
    m.current.selectedEffort = effort;
    void setSubsystemConfigPin(
      modelPickerHarnessRef.current,
      "assistant",
      "thought_level",
      effort
    );
  };

  const setHarnessNow = async (
    harnessKind: HarnessKind
  ): Promise<AsstModelPickerDTO> => {
    const harnessRequest = ++harnessRequestRef.current;
    const threadRequest = threadRequestRef.current;
    const conversationAtStart = m.current.currentId;
    const previous = m.current.harnessKind;
    // Take the cached status fast path; only an unknown/not-ready target earns
    // the expensive all-harnesses refresh.
    let status = await loadHarnesses();
    const target = status.cards.find((card) => card.kind === harnessKind);
    if (!target?.sessionReady) {
      status = await loadHarnesses({ refresh: true });
    }
    const current =
      !m.current.disposed &&
      m.current.harnessReady &&
      m.current.currentId === conversationAtStart &&
      threadRequestRef.current === threadRequest &&
      harnessRequestRef.current === harnessRequest;
    if (!current) {
      return pickerFromStatus(status, m.current.harnessKind, false);
    }
    const resolvedTarget = status.cards.find(
      (card) => card.kind === harnessKind
    );
    if (!resolvedTarget?.sessionReady) {
      showToast(
        resolvedTarget?.subtitle ??
          `${harnessKind} did not complete its session preflight.`
      );
      return pickerFromStatus(status, previous);
    }
    // Invalidate passive picker requests before committing an explicit choice.
    harnessRequestRef.current += 1;
    m.current.context = null;
    if (!resolvedTarget.supportsAttachments) {
      clearPendingAttachments();
    }
    const next = pickerFromStatus(status, harnessKind);
    push();
    return next;
  };
  const setHarness = useStableEvent(setHarnessNow);

  const removePendingAttachment = (localId: string): void => {
    const gone = m.current.pendingAttachments.find(
      (a) => a.localId === localId
    );
    if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
    m.current.pendingAttachments = m.current.pendingAttachments.filter(
      (a) => a.localId !== localId
    );
    push();
  };

  const loadAttachmentImage = (hash: string, mime: string): Promise<string> =>
    fetchAssistantAttachmentUrl(ASSISTANT_APP_ID, hash, mime);

  const runTurn = async (opts: {
    text: string;
    attachments: ReadyAttachment[];
    retryOf?: string;
    /** Fresh per user send; REUSED on a resend so a retry-after-drop replays
     *  instead of double-running (#420). */
    idempotencyKey: string;
    appendUser: boolean;
    removeFromIndex?: number;
    /** Every provider approved so far during THIS send attempt (#567). */
    providerConsent?: string[];
  }): Promise<void> => {
    const conversationIdLocal = m.current.currentId;
    if (!conversationIdLocal) return;
    const threadRequest = threadRequestRef.current;
    const baselineTurnCount = m.current.turnCount;
    if (opts.removeFromIndex !== undefined)
      m.current.msgs = m.current.msgs.slice(0, opts.removeFromIndex);
    if (opts.appendUser) {
      m.current.msgs.push({
        kind: "user",
        text: opts.text,
        // Live sends carry a timestamp so the hover clock works before reload.
        createdAt: nowMs(),
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

    let ai: Extract<AsstMsg, { kind: "ai" }> | null = null;
    const ensureAi = (): Extract<AsstMsg, { kind: "ai" }> => {
      if (!ai) {
        ai = { kind: "ai", text: "", streaming: true, createdAt: Date.now() };
        m.current.msgs.push(ai);
        push();
      }
      return ai;
    };
    // Streams `reasoning.delta`, collapses once the answer begins, and vanishes
    // on reload because reasoning is not persisted (#420).
    let thinking: {
      kind: "thinking";
      text: string;
      streaming?: boolean;
    } | null = null;
    const collapseThinking = (): void => {
      if (thinking && thinking.streaming) {
        thinking.streaming = false;
        push();
      }
    };
    const byCall = new Map<string, AsstToolCall>();
    let errored = false;
    let requiredProvider: string | undefined;
    // Distinguishes a mid-turn connection loss (catch up from the ledger) from
    // a request that never started (plain failure → resend) (#420).
    let sawActivity = false;

    const onEvent = (event: TurnStreamEvent): void => {
      if (!isCurrent(conversationIdLocal, threadRequest)) return;
      if (event.type !== "error" && event.type !== "aborted")
        sawActivity = true;
      switch (event.type) {
        case "consent.required":
          requiredProvider = event.provider;
          return;
        case "notice": {
          // Non-fatal: the ledger copy restores it after reload.
          m.current.msgs.push({
            kind: "notice",
            level: event.level,
            text: event.message,
          });
          push();
          break;
        }
        case "reasoning.delta":
          if (thinking) {
            thinking.text += event.delta;
          } else {
            thinking = { kind: "thinking", text: event.delta, streaming: true };
            m.current.msgs.push(thinking);
          }
          push();
          return;
        case "assistant.delta":
          collapseThinking();
          ensureAi().text += event.delta;
          push();
          return;
        case "usage": {
          const msg = ensureAi();
          const inputTokens = event.inputTokens;
          const outputTokens = event.outputTokens;
          // Priced server-side; the frozen ledger rollup replaces it on reload.
          const costUsd = event.costUsd;
          msg.usage = {
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
            ...(costUsd === undefined ? {} : { costUsd, estimated: true }),
            ...(event.model ? { model: event.model } : {}),
            ...(event.effort ? { effort: event.effort } : {}),
          };
          push();
          return;
        }
        case "context":
          if (event.used !== undefined && event.size !== undefined) {
            m.current.context = { used: event.used, size: event.size };
            push();
          }
          return;
        case "tool.start": {
          collapseThinking();
          const call: AsstToolCall = {
            id: event.toolCallId,
            tool: event.toolName,
            ...(event.sql ? { sql: event.sql } : {}),
            state: "run",
          };
          byCall.set(event.toolCallId, call);
          const anchor = ai
            ? m.current.msgs.indexOf(ai)
            : m.current.msgs.length;
          const prev = m.current.msgs[anchor - 1];
          if (prev?.kind === "tools") prev.calls.push(call);
          else
            m.current.msgs.splice(anchor, 0, { kind: "tools", calls: [call] });
          push();
          return;
        }
        case "tool.result": {
          const call = byCall.get(event.toolCallId);
          if (!call) return;
          call.state = event.ok ? "ok" : "error";
          if (!event.ok) call.errorText = event.errorText ?? "failed";
          const result = event.result as
            | { totalRows?: number; durationMs?: number }
            | undefined;
          if (result && typeof result.totalRows === "number")
            call.totalRows = result.totalRows;
          if (result && typeof result.durationMs === "number")
            call.durationMs = result.durationMs;
          const outputText = toolOutputText(event.result);
          if (outputText) call.outputText = outputText;
          const artifacts = [
            ...(event.locations ?? []).map((location) => ({
              label: location.path.split(/[\\/]/u).at(-1) ?? location.path,
              workspacePath: location.path,
            })),
            // Keep the live chip identical to the reload path (#567).
            ...(event.artifacts ?? []).map((artifact) => ({
              label: artifact.filename ?? "Harness artifact",
              ...(artifact.hash ? { hash: artifact.hash } : {}),
            })),
          ];
          if (artifacts.length) call.artifacts = artifacts;
          push();
          return;
        }
        case "final": {
          collapseThinking();
          const msg = ensureAi();
          msg.text ||= event.text;
          msg.streaming = false;
          push();
          return;
        }
        case "error": {
          errored = true;
          m.current.msgs.push({
            kind: "ai",
            text: event.message,
            error: true,
            failedText: opts.text,
            idempotencyKey: opts.idempotencyKey,
            ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
          });
          push();
          break;
        }
        // These event types deliberately have no transcript surface yet.
        case "assistant.start":
        case "phase":
        case "aborted":
        case "webhooks":
          break;
      }
    };

    let streamEnded = false;
    let threw: unknown = null;
    const consentWire = providerConsentWire(opts.providerConsent);
    try {
      const res = await streamAssistantTurn(
        {
          conversationId: conversationIdLocal,
          message: opts.text,
          idempotencyKey: opts.idempotencyKey,
          ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
          ...(opts.attachments.length
            ? { attachments: opts.attachments.map((a) => a.ref) }
            : {}),
          ...(consentWire === undefined
            ? {}
            : { providerConsent: consentWire }),
          ...(m.current.harnessKind
            ? { harnessKind: m.current.harnessKind }
            : {}),
          ...(m.current.selectedModel
            ? { model: m.current.selectedModel }
            : {}),
          ...(m.current.selectedEffort
            ? { thinking: m.current.selectedEffort }
            : {}),
          workspaceKind: m.current.workspaceKind,
          additionalDirectories: m.current.additionalDirectories,
          // Explicit, never ambient: the turn lands in the thread's vault (#599).
          ...(conversationScope(conversationIdLocal)
            ? { scopeId: conversationScope(conversationIdLocal) }
            : {}),
        },
        onEvent,
        m.current.abort.signal
      );
      streamEnded = res.ended;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        threw = error;
    }

    if (!isCurrent(conversationIdLocal, threadRequest)) return;
    if (requiredProvider) {
      setBusy(false);
      const approved = await confirm({
        confirmLabel: "Allow provider",
        title: `Send to ${requiredProvider}?`,
        message: `Allow this conversation to be sent to ${requiredProvider}? This can include your message, attachments, conversation handoff, and vault tool results.`,
      });
      if (!isCurrent(conversationIdLocal, threadRequest)) return;
      if (approved) {
        // Carry EVERY provider approved this attempt: dropping the first makes
        // a consent-gated failover loop forever (#567).
        await runTurn({
          ...opts,
          appendUser: false,
          providerConsent: withProviderConsent(
            opts.providerConsent ?? [],
            requiredProvider
          ),
        });
      } else {
        m.current.msgs.push({
          kind: "notice",
          level: "info",
          text: `Nothing was sent to ${requiredProvider}.`,
        });
        pushSync();
      }
      return;
    }
    m.current.msgs = m.current.msgs.map((msg) =>
      msg.kind === "thinking" && msg.streaming
        ? { ...msg, streaming: false }
        : msg
    );
    const aborted = m.current.abort?.signal.aborted ?? false;
    // A mid-turn drop: activity, then no terminal `event: end`. The backend
    // finished and folded the turn into the ledger, so catch up, never fail.
    const droppedMidTurn =
      !errored && !aborted && sawActivity && (threw !== null || !streamEnded);

    if (droppedMidTurn) {
      // Poll the ledger until the turn settles, then reload it.
      const live = m.current.msgs.find(
        (msg): msg is Extract<AsstMsg, { kind: "ai" }> =>
          msg.kind === "ai" && msg.streaming === true
      );
      if (live) live.catchingUp = true;
      else
        m.current.msgs.push({
          kind: "ai",
          text: "",
          streaming: true,
          catchingUp: true,
        });
      push();
      const settled = await catchUpAfterDrop({
        baselineTurnCount,
        getStatus: () =>
          conversationStatus(
            ASSISTANT_APP_ID,
            conversationIdLocal,
            conversationScope(conversationIdLocal)
          ),
        isCancelled: () => !isCurrent(conversationIdLocal, threadRequest),
      });
      if (!isCurrent(conversationIdLocal, threadRequest)) return;
      m.current.busy = false;
      if (settled) {
        await reloadTranscript(conversationIdLocal, threadRequest);
      } else {
        // Give up: drop the catch-up row and offer a one-tap resend (same key).
        m.current.msgs = m.current.msgs.filter(
          (msg) => !(msg.kind === "ai" && msg.catchingUp)
        );
        m.current.msgs.push({
          kind: "ai",
          text: "Connection lost — the turn didn’t come back.",
          error: true,
          failedText: opts.text,
          idempotencyKey: opts.idempotencyKey,
          offline:
            typeof navigator !== "undefined" && navigator.onLine === false,
          ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
        });
      }
      pushSync();
      refreshAssistantThreads?.();
      return;
    }

    const live = m.current.msgs.find(
      (msg): msg is Extract<AsstMsg, { kind: "ai" }> =>
        msg.kind === "ai" && msg.streaming === true
    );
    if (live) live.streaming = false;
    // Threw before any activity → resend bubble.
    if (threw !== null && !errored && !aborted) {
      const message = threw instanceof Error ? threw.message : String(threw);
      // A rejected shared folder rejects the SELECTION, not the turn: say so
      // out of band, or resend keeps failing until the chip goes (#567).
      if (/additional director/iu.test(message)) {
        showToast(
          `The gateway rejected a shared folder — remove it and try again. ${message}`
        );
      }
      m.current.msgs.push({
        kind: "ai",
        text: message,
        error: true,
        failedText: opts.text,
        idempotencyKey: opts.idempotencyKey,
        offline: typeof navigator !== "undefined" && navigator.onLine === false,
        ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
      });
      errored = true;
    }
    setBusy(false);
    pushSync();
    refreshAssistantThreads?.();
    if (!errored && !aborted)
      void reloadTranscript(conversationIdLocal, threadRequest);
  };

  const submit = async (textArg?: string): Promise<void> => {
    const text = (textArg ?? "").trim();
    if (m.current.busy) return;
    if (m.current.pendingAttachments.some((a) => a.state === "uploading")) {
      showToast("Wait for attachments to finish uploading.");
      return;
    }
    const ready = m.current.pendingAttachments.filter(
      (a): a is ReadyAttachment => a.state === "ready" && a.ref !== undefined
    );
    if (!text && ready.length === 0) return;
    if (!m.current.currentId) {
      try {
        const created = await createConversation(
          ASSISTANT_APP_ID,
          "",
          activeScopeId
        );
        if (activeScopeId) rememberConversationScope(created.id, activeScopeId);
        m.current.currentId = created.id;
        setHasThread(true);
        suppressSelectRef.current = created.id;
        replace?.({ kind: "assistant", conversationId: created.id });
        refreshAssistantThreads?.();
      } catch (error) {
        showToast(
          error instanceof Error
            ? error.message
            : "Could not start a conversation"
        );
        return;
      }
    }
    for (const attachment of m.current.pendingAttachments) {
      if (attachment.state === "ready" && attachment.previewUrl) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    }
    m.current.pendingAttachments = m.current.pendingAttachments.filter(
      (a) => a.state !== "ready"
    );
    // Fresh key per user send; reused only on resend (#420).
    await runTurn({
      text,
      attachments: ready,
      appendUser: true,
      idempotencyKey: crypto.randomUUID(),
    });
  };

  // Re-runs the last user message as a retry; reload restores it as a "<2/2>"
  // sibling pager.
  const regenerate = (): void => {
    if (m.current.busy) return;
    let answerIdx = -1;
    for (let i = m.current.msgs.length - 1; i >= 0; i--) {
      const msg = m.current.msgs[i];
      if (msg?.kind === "ai" && !msg.streaming && !msg.error) {
        answerIdx = i;
        break;
      }
    }
    if (answerIdx < 0) return;
    const answer = m.current.msgs[answerIdx] as Extract<
      AsstMsg,
      { kind: "ai" }
    >;
    const active = activeAttemptOf(answer);
    const retryOf = active ? active.turnId : answer.turnId;
    if (!retryOf) return;
    let userText = "";
    for (let i = answerIdx - 1; i >= 0; i--) {
      const msg = m.current.msgs[i];
      if (msg?.kind === "user") {
        userText = msg.text;
        break;
      }
    }
    if (!userText) return;
    // Trim from the first row after the user message so the retry replaces just
    // this turn. A deliberate NEW attempt, so a fresh idempotency key (#420).
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
    if (!msg || msg.kind !== "ai" || !msg.error || msg.failedText === undefined)
      return;
    // Resend REUSES the failed send's idempotency key so a turn that completed
    // server-side replays instead of double-running (#420).
    void runTurn({
      text: msg.failedText,
      attachments: [],
      idempotencyKey: msg.idempotencyKey ?? crypto.randomUUID(),
      ...(msg.retryOf ? { retryOf: msg.retryOf } : {}),
      appendUser: false,
      removeFromIndex: messageIndex,
    });
  };

  const setFeedback = (turnId: string, value: "up" | "down"): void => {
    const conversationIdLocal = m.current.currentId;
    if (!conversationIdLocal) return;
    let applied: "up" | "down" | null = null;
    for (const [index, msg] of m.current.msgs.entries()) {
      if (msg.kind !== "ai") continue;
      const attemptIndex =
        msg.attempts?.findIndex((attempt) => attempt.turnId === turnId) ?? -1;
      const attempt = msg.attempts?.[attemptIndex];
      if (attempt && attemptIndex >= 0) {
        const feedback = attempt.feedback === value ? null : value;
        m.current.msgs = [...m.current.msgs];
        m.current.msgs[index] = {
          ...msg,
          attempts: msg.attempts?.map((candidate, candidateIndex) =>
            candidateIndex === attemptIndex
              ? { ...candidate, feedback }
              : candidate
          ),
        };
        applied = feedback;
        break;
      }
      if (msg.turnId === turnId) {
        const feedback = msg.feedback === value ? null : value;
        m.current.msgs = [...m.current.msgs];
        m.current.msgs[index] = { ...msg, feedback };
        applied = feedback;
        break;
      }
    }
    push();
    void setConversationFeedback(
      ASSISTANT_APP_ID,
      conversationIdLocal,
      turnId,
      applied
    ).catch(() => undefined);
  };

  const pagerNav = (messageIndex: number, delta: number): void => {
    const msg = m.current.msgs[messageIndex];
    if (!msg || msg.kind !== "ai" || !msg.attempts?.length) return;
    const next = Math.min(
      Math.max((msg.activeAttempt ?? msg.attempts.length - 1) + delta, 0),
      msg.attempts.length - 1
    );
    msg.activeAttempt = next;
    push();
  };

  const copyMessage = (text: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => showToast("Copied to clipboard"),
      () => showToast("Could not copy")
    );
  };

  useEffect(() => {
    const model = m.current;
    const batch = pushBatchRef.current;
    model.disposed = false;
    return () => {
      model.disposed = true;
      harnessRequestRef.current += 1;
      threadRequestRef.current += 1;
      model.abort?.abort();
      for (const attachment of model.pendingAttachments) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      model.pendingAttachments = [];
      // A queued frame would land after the screen is gone.
      batch?.cancel();
    };
  }, []);

  useEffect(() => {
    if (conversationId && suppressSelectRef.current === conversationId) {
      suppressSelectRef.current = null;
      return;
    }
    void selectThread(conversationId ?? null);
  }, [conversationId]);

  // From prefs `assistant.starters`; defaults until they load.
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

  const searchEntities = (
    term: string
  ): Promise<
    { type: string; id: string; title: string; subtitle?: string }[]
  > =>
    searchVaultEntities(term)
      .then((hits) =>
        hits.map((h) => ({
          type: h.type,
          id: h.id,
          title: h.title ?? `${h.type} ${h.id}`,
          ...(h.subtitle ? { subtitle: h.subtitle } : {}),
        }))
      )
      .catch(() => []);

  // Export/Rename need an open (created) conversation.
  const slashCommands: AsstSlashCommand[] = [
    {
      id: "export",
      label: "export",
      hint: "Download as Markdown",
      enabled: hasThread,
    },
    {
      id: "rename",
      label: "rename",
      hint: "Rename this conversation",
      enabled: hasThread,
    },
    { id: "new", label: "new", hint: "Start a new conversation" },
  ];
  const runSlash = (id: string): void => {
    const cid = m.current.currentId;
    if (id === "new") {
      navigate({ kind: "assistant" });
      return;
    }
    if (!cid) return;
    if (id === "export") {
      void loadConversation(ASSISTANT_APP_ID, cid, conversationScope(cid))
        .then((conv) => downloadConversation(conv, "markdown"))
        .catch((error: unknown) =>
          showToast(
            `Couldn't export: ${error instanceof Error ? error.message : String(error)}`
          )
        );
    } else if (id === "rename") {
      void (async () => {
        const next = await openPrompt({
          title: "Rename conversation",
          placeholder: "Conversation name",
          confirmLabel: "Rename",
        });
        if (!next) return;
        await renameConversation(
          ASSISTANT_APP_ID,
          cid,
          next,
          conversationScope(cid)
        ).catch((error: unknown) =>
          showToast(
            `Couldn't rename: ${error instanceof Error ? error.message : String(error)}`
          )
        );
        refreshAssistantThreads?.();
      })();
    }
  };

  // Keep the bridge IDENTITY stable — `useStableEvent` still refreshes the
  // implementations — so memoized rows survive token frames.
  const screenOnReady = useStableEvent(
    (update: (s: AssistantSnapshot) => void): void => {
      updateRef.current = update;
      update(buildSnapshot());
    }
  );
  const screenOnSend = useStableEvent((text: string): void => {
    void submit(text);
  });
  const screenOnStop = useStableEvent((): void => {
    m.current.abort?.abort();
    setBusy(false);
  });
  const screenOnLoadEarlier = useStableEvent(loadEarlier);
  const screenOnAttachFiles = useStableEvent(attachFiles);
  const screenOnRemovePendingAttachment = useStableEvent(
    removePendingAttachment
  );
  const screenOnAddWorkspace = useStableEvent((): void => {
    void openPrompt({
      title: "Add a scoped workspace folder",
      placeholder: "/absolute/path/to/folder",
      confirmLabel: "Share folder",
    }).then((directory) => {
      const trimmed = directory?.trim() ?? "";
      if (!trimmed) return;
      // A bad root is a 400 on the NEXT turn, read as a failed answer: catch
      // what can be named here (#567).
      const rejection = rejectScopedDirectory(
        trimmed,
        m.current.additionalDirectories
      );
      if (rejection) {
        showToast(rejection);
        return;
      }
      m.current.additionalDirectories.push(trimmed);
      push();
    });
  });
  const screenOnRemoveWorkspace = useStableEvent((directory: string): void => {
    m.current.additionalDirectories = m.current.additionalDirectories.filter(
      (current) => current !== directory
    );
    push();
  });
  const screenHydrateRefs = useStableEvent(hydrateRefs);
  const screenWireCodeCopy = useStableEvent(wireCodeCopy);
  const screenLoadAttachmentImage = useStableEvent(loadAttachmentImage);
  const screenOnCopyMessage = useStableEvent(copyMessage);
  const screenOnFeedback = useStableEvent(setFeedback);
  const screenOnRegenerate = useStableEvent(regenerate);
  const screenOnRetryError = useStableEvent(retryError);
  const screenOnPagerNav = useStableEvent(pagerNav);
  const screenOnSetModel = useStableEvent(setModel);
  const screenOnSetEffort = useStableEvent(setEffort);
  const screenOnSetHarness = setHarness;
  const screenOnSetWorkspaceKind = useStableEvent(
    (workspaceKind: "vault-data" | "app" | "draft"): void => {
      m.current.workspaceKind = workspaceKind;
      push();
    }
  );
  const screenSearchEntities = useStableEvent(searchEntities);
  const screenRunSlash = useStableEvent(runSlash);

  return (
    <div className={mainScrollCss.hasWall}>
      {/* A picker while the conversation is hypothetical, a plain statement
          once it exists: the vault is part of the thread's identity (#599). */}
      {ownerScopes.scopes.length > 0 ? (
        <div className={scopeBarCss.bar}>
          <ScopePicker
            scopes={ownerScopes.scopes}
            value={activeScopeId}
            onChange={setPickedScope}
            label={conversationId ? "Reading" : "New conversation in"}
            locked={Boolean(conversationId)}
          />
        </div>
      ) : null}
      <div
        className={ledgerCss.split}
        data-ledger={conversations ? "true" : undefined}
        data-compact={compact ? "true" : undefined}
      >
        {conversations ? (
          <div className={ledgerCss.aside}>
            {compact ? (
              <button
                className={ledgerCss.disclosure}
                type="button"
                aria-expanded={ledgerOpen}
                onClick={() => setLedgerOpen((open) => !open)}
              >
                <Icon
                  name={ledgerOpen ? "ChevronDown" : "ChevronRight"}
                  size={13}
                />
                <span>Conversations</span>
              </button>
            ) : null}
            {compact && !ledgerOpen ? null : (
              <AssistantConversations
                conversations={conversations}
                activeConversationId={ledgerActiveId ?? conversationId}
                onSelect={onSelectConversation}
                onNewChat={onNewChat}
                onDelete={onDeleteConversation}
                onMenu={onConversationMenu}
              />
            )}
          </div>
        ) : null}
        <div className={ledgerCss.stage}>
          <AssistantScreen
            suggestions={starters}
            searchEntities={screenSearchEntities}
            slashCommands={slashCommands}
            onRunSlash={screenRunSlash}
            {...(conversationId ? { conversationId } : {})}
            onReady={screenOnReady}
            onSend={screenOnSend}
            onStop={screenOnStop}
            onLoadEarlier={screenOnLoadEarlier}
            onAttachFiles={screenOnAttachFiles}
            onRemovePendingAttachment={screenOnRemovePendingAttachment}
            onAddWorkspace={screenOnAddWorkspace}
            onRemoveWorkspace={screenOnRemoveWorkspace}
            hydrateRefs={screenHydrateRefs}
            wireCodeCopy={screenWireCodeCopy}
            loadAttachmentImage={screenLoadAttachmentImage}
            onCopyMessage={screenOnCopyMessage}
            onFeedback={screenOnFeedback}
            onRegenerate={screenOnRegenerate}
            onRetryError={screenOnRetryError}
            onPagerNav={screenOnPagerNav}
            loadModelPicker={loadModelPicker}
            onSetModel={screenOnSetModel}
            onSetEffort={screenOnSetEffort}
            onSetHarness={screenOnSetHarness}
            onSetWorkspaceKind={screenOnSetWorkspaceKind}
          />
        </div>
      </div>
    </div>
  );
}
