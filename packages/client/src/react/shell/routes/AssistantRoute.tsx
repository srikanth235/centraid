// governance: allow-repo-hygiene file-size-limit shared shell relocation keeps this cohesive route intact; split later under #392
import { useEffect, useRef, useState } from "react";
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
  AgentRunnerKind,
} from "../../screen-contracts.js";
import AssistantScreen from "../../screens/AssistantScreen.js";
import { useShellActions } from "../actions.js";
import { openPrompt } from "../prompt.js";
import { useMemberScopes } from "../useMemberScopes.js";
import { catchUpAfterDrop } from "./assistantCatchUp.js";
import { hydrateRefs, wireCodeCopy } from "./assistantRich.js";
import { DEFAULT_STARTERS, resolveStarters } from "./assistantStarters.js";
import {
  activeAttemptOf,
  hydrateMessages,
  msgToDTO,
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
  loadProviders,
  resolveReportedRunnerKind,
  setSubsystemConfigPin,
  setSubsystemModel,
} from "./settingsProvidersData.js";

import mainScrollCss from "../../styles/mainScroll.module.css";
import scopeBarCss from "./ScopePicker.module.css";

type ReadyAttachment = PendingAttachment & { ref: ConversationAttachmentRef };

/** Wall clock for live transcript rows, at module scope (render-purity rule). */
const nowMs = (): number => Date.now();

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
export default function AssistantRoute({
  conversationId,
}: AssistantRouteProps): JSX.Element {
  const { showToast, replace, navigate, confirm, refreshAssistantThreads } =
    useShellActions();
  const m = useRef({
    currentId: null as string | null,
    msgs: [] as AsstMsg[],
    pendingAttachments: [] as PendingAttachment[],
    busy: false,
    abort: null as AbortController | null,
    disposed: false,
    context: null as { used: number; size: number } | null,
    runnerKind: null as AgentRunnerKind | null,
    selectedModel: "",
    selectedEffort: "",
    workspaceKind: "vault-data" as "vault-data" | "app" | "draft",
    additionalDirectories: [] as string[],
    /** Server turn count of the open thread — the reconnect catch-up baseline. */
    turnCount: 0,
  });
  // The space this conversation addresses (issue #599). Chosen once, before the
  // first message; from then on the recorded scope is authoritative and every
  // request the thread makes repeats it, so a conversation reads exactly ONE
  // space for its whole life. `undefined` — an older thread, or a gateway with
  // no member layer — falls back to the internal default scope.
  const memberScopes = useMemberScopes();
  const [pickedScope, setPickedScope] = useState<string | undefined>(undefined);
  const activeScopeId = conversationId
    ? conversationScope(conversationId)
    : (pickedScope ?? memberScopes.primary?.id);
  // Render-visible mirror of `m.current.currentId !== null` — the slash-command
  // list gates Export/Rename on it, and render may not read the model ref.
  const [hasThread, setHasThread] = useState(false);
  const updateRef = useRef<((s: AssistantSnapshot) => void) | null>(null);
  const suppressSelectRef = useRef<string | null>(null);
  const modelPickerRunnerRef = useRef<AgentRunnerKind>("codex");

  const buildSnapshot = (): AssistantSnapshot => {
    // The last final AI answer gates the Regenerate control — but only when
    // idle (regenerating mid-turn makes no sense).
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
      ...(m.current.context ? { context: m.current.context } : {}),
      workspaceKind: m.current.workspaceKind,
      ...(m.current.additionalDirectories.length
        ? { additionalDirectories: [...m.current.additionalDirectories] }
        : {}),
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
      const loaded = await loadConversation(
        ASSISTANT_APP_ID,
        id,
        conversationScope(id)
      );
      if (m.current.disposed || m.current.currentId !== id || m.current.busy)
        return;
      m.current.msgs = hydrateMessages(loaded.messages, {
        ...(loaded.hasArchivedHistory ? { hasArchivedHistory: true } : {}),
        ...(loaded.archiveUnavailable ? { archiveUnavailable: true } : {}),
      });
      m.current.turnCount = loaded.turnCount;
      if (loaded.adapterKind) m.current.runnerKind = loaded.adapterKind;
      if (loaded.workspace) {
        m.current.workspaceKind = loaded.workspace.primaryKind;
        m.current.additionalDirectories = [
          ...loaded.workspace.additionalDirectories,
        ];
      }
      push();
    } catch {
      /* keep the live model if the reload fails */
    }
  };

  const selectThread = async (id: string | null): Promise<void> => {
    m.current.abort?.abort();
    setBusy(false);
    setHasThread(id !== null);
    m.current.currentId = id;
    m.current.msgs = [];
    m.current.pendingAttachments = [];
    m.current.turnCount = 0;
    m.current.context = null;
    m.current.runnerKind = null;
    m.current.workspaceKind = "vault-data";
    m.current.additionalDirectories = [];
    push();
    if (!id) return;
    try {
      const loaded = await loadConversation(
        ASSISTANT_APP_ID,
        id,
        conversationScope(id)
      );
      if (m.current.disposed || m.current.currentId !== id) return;
      m.current.msgs = hydrateMessages(loaded.messages, {
        ...(loaded.hasArchivedHistory ? { hasArchivedHistory: true } : {}),
        ...(loaded.archiveUnavailable ? { archiveUnavailable: true } : {}),
      });
      m.current.turnCount = loaded.turnCount;
      if (loaded.adapterKind) m.current.runnerKind = loaded.adapterKind;
      if (loaded.workspace) {
        m.current.workspaceKind = loaded.workspace.primaryKind;
        m.current.additionalDirectories = [
          ...loaded.workspace.additionalDirectories,
        ];
      }
    } catch (error) {
      if (m.current.disposed) return;
      m.current.msgs = [
        { kind: "ai", text: `Failed to load: ${String(error)}`, error: true },
      ];
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
      const mime = file.type || "application/octet-stream";
      // Image attachments get a local object-URL thumbnail in the composer
      // staging area straight away — no round-trip needed (issue #420, W2).
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

  // Composer model picker — reuses the Settings → Models → Agents data path.
  const pickerFromStatus = (
    status: Awaited<ReturnType<typeof loadProviders>>,
    requestedRunner?: AgentRunnerKind | null
  ): AsstModelPickerDTO => {
    const runnerKind = resolveReportedRunnerKind(
      status,
      requestedRunner,
      "assistant"
    );
    m.current.runnerKind = runnerKind;
    modelPickerRunnerRef.current = runnerKind;
    const card = status.cards.find((c) => c.kind === runnerKind);
    const models = card?.modelConfigurable ? card.models : [];
    const defaultId = status.savedModelByKind[runnerKind] ?? "";
    const defaultModel =
      models.find((mm) => mm.id === defaultId) ??
      models.find((mm) => mm.default) ??
      models[0];
    const effortOption = card?.configOptions?.find(
      (option) => option.category === "thought_level"
    );
    const defaultEffort =
      status.defaultConfigPinsByKind[runnerKind]?.thought_level ??
      effortOption?.currentValue ??
      "";
    m.current.selectedModel =
      status.subsystemModelByKind[runnerKind]?.assistant ?? "";
    m.current.selectedEffort =
      status.subsystemConfigPinsByKind[runnerKind]?.assistant?.thought_level ??
      "";
    return {
      runners: status.cards.map((runner) => ({
        kind: runner.kind,
        title: runner.title,
        connected: runner.connected,
        sessionReady: runner.sessionReady,
        // Breaker health belongs in the hint on every picker — a tripped
        // breaker is exactly what explains a runner that looks connected but
        // won't take the turn (matches builder + automations).
        hint: [
          runner.subtitle,
          ...(runner.breakerStates ?? []).map(
            (state) => `${state.failureClass} ${state.state}`
          ),
        ].join(" · "),
      })),
      selectedRunnerKind: runnerKind,
      workspaceKinds: ["vault-data"],
      connected: card?.connected ?? false,
      models: models.map((mm) => ({
        id: mm.id,
        ...(mm.name ? { name: mm.name } : {}),
        ...(mm.default ? { default: true } : {}),
      })),
      defaultModelName:
        defaultModel?.name ?? defaultModel?.id ?? "gateway default",
      selectedModelId: m.current.selectedModel,
      efforts: effortOption?.values ?? [],
      defaultEffortName:
        effortOption?.values.find((value) => value.value === defaultEffort)
          ?.name ?? defaultEffort,
      selectedEffortId: m.current.selectedEffort,
      supportsAdditionalDirectories: card?.additionalDirectories === true,
      supportsAttachments: card?.supportsAttachments === true,
      supportsContext: card?.supportsContext === true,
    };
  };

  const loadModelPicker = async (): Promise<AsstModelPickerDTO> =>
    pickerFromStatus(await loadProviders(), m.current.runnerKind);

  const setModel = (modelId: string): void => {
    m.current.selectedModel = modelId;
    setSubsystemModel(modelPickerRunnerRef.current, "assistant", modelId);
  };

  const setEffort = (effort: string): void => {
    m.current.selectedEffort = effort;
    setSubsystemConfigPin(
      modelPickerRunnerRef.current,
      "assistant",
      "thought_level",
      effort
    );
  };

  const setRunner = async (
    runnerKind: AgentRunnerKind
  ): Promise<AsstModelPickerDTO> => {
    const previous = m.current.runnerKind;
    const status = await loadProviders({ refresh: true });
    const target = status.cards.find((card) => card.kind === runnerKind);
    if (!target?.sessionReady) {
      showToast(
        target?.subtitle ??
          `${runnerKind} did not complete its session preflight.`
      );
      return pickerFromStatus(status, previous);
    }
    m.current.runnerKind = runnerKind;
    m.current.context = null;
    if (!target.supportsAttachments) {
      for (const attachment of m.current.pendingAttachments) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      m.current.pendingAttachments = [];
    }
    push();
    return pickerFromStatus(status, runnerKind);
  };

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
    /** Every provider approved so far during THIS send attempt (#567). */
    providerConsent?: string[];
  }): Promise<void> => {
    const conversationId = m.current.currentId;
    if (!conversationId) return;
    const baselineTurnCount = m.current.turnCount;
    if (opts.removeFromIndex !== undefined)
      m.current.msgs = m.current.msgs.slice(0, opts.removeFromIndex);
    if (opts.appendUser) {
      m.current.msgs.push({
        kind: "user",
        text: opts.text,
        // Live sends carry a timestamp too, so the hover clock works before the
        // transcript reload replaces the row with the ledger copy.
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
    // Live reasoning row (issue #420, Wave 2) — ported from BuilderChatPane. It
    // streams `reasoning.delta`, collapses once the answer/tools begin, and (as
    // reasoning is not persisted) vanishes when the turn reloads from the ledger.
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
    // Whether the stream produced ANY turn activity before it (maybe) dropped —
    // distinguishes a mid-turn connection loss (catch up from the ledger) from a
    // request that never started (plain failure → resend). Issue #420.
    let sawActivity = false;

    const onEvent = (event: TurnStreamEvent): void => {
      if (m.current.disposed || m.current.currentId !== conversationId) return;
      if (event.type !== "error" && event.type !== "aborted")
        sawActivity = true;
      switch (event.type) {
        case "consent.required":
          requiredProvider = event.provider;
          return;
        case "notice": {
          // A non-fatal runner notice. The SSE path renders immediately and
          // the ledger copy restores it after reload.
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
          // Priced server-side at the SSE seam (model-pricing.ts); the frozen
          // ledger rollup replaces it on reload.
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
            // Keep the live chip identical to the reload path: when the runner
            // reports a content hash, the chip shows `sha256 …` (#567).
            ...(event.artifacts ?? []).map((artifact) => ({
              label: artifact.filename ?? "Agent artifact",
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
          conversationId,
          message: opts.text,
          idempotencyKey: opts.idempotencyKey,
          ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
          ...(opts.attachments.length
            ? { attachments: opts.attachments.map((a) => a.ref) }
            : {}),
          ...(consentWire === undefined
            ? {}
            : { providerConsent: consentWire }),
          ...(m.current.runnerKind ? { runnerKind: m.current.runnerKind } : {}),
          ...(m.current.selectedModel
            ? { model: m.current.selectedModel }
            : {}),
          ...(m.current.selectedEffort
            ? { thinking: m.current.selectedEffort }
            : {}),
          workspaceKind: m.current.workspaceKind,
          additionalDirectories: m.current.additionalDirectories,
          // Explicit, never ambient: the turn must land in the space the
          // conversation was created in (issue #599).
          ...(conversationScope(conversationId)
            ? { scopeId: conversationScope(conversationId) }
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

    if (m.current.disposed || m.current.currentId !== conversationId) return;
    if (requiredProvider) {
      setBusy(false);
      const approved = await confirm({
        confirmLabel: "Allow provider",
        title: `Send to ${requiredProvider}?`,
        message: `Allow this conversation to be sent to ${requiredProvider}? This can include your message, attachments, conversation handoff, and vault tool results.`,
      });
      if (m.current.disposed || m.current.currentId !== conversationId) return;
      if (approved) {
        // Carry EVERY provider approved this attempt — a consent-gated failover
        // asks twice, and dropping the first approval loops forever (#567).
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
        push();
      }
      return;
    }
    for (const msg of m.current.msgs) {
      if (msg.kind === "thinking" && msg.streaming) msg.streaming = false;
    }
    const aborted = m.current.abort?.signal.aborted ?? false;
    // A mid-turn drop: the stream carried activity then closed WITHOUT the
    // terminal `event: end` (or threw a network error). The backend finished the
    // turn and folded it into the ledger, so catch up rather than fail (#420).
    const droppedMidTurn =
      !errored && !aborted && sawActivity && (threw !== null || !streamEnded);

    if (droppedMidTurn) {
      // Mark the live answer "catching up" and poll the ledger until the turn
      // settles, then reload to materialize the completed answer.
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
            conversationId,
            conversationScope(conversationId)
          ),
        isCancelled: () =>
          m.current.disposed || m.current.currentId !== conversationId,
      });
      if (m.current.disposed || m.current.currentId !== conversationId) return;
      m.current.busy = false;
      if (settled) {
        await reloadTranscript(conversationId);
      } else {
        // Give up: drop the catch-up row and offer a one-tap resend (same key).
        m.current.msgs = m.current.msgs.filter(
          (msg) => !(msg.kind === "ai" && msg.catchingUp)
        );
        m.current.msgs.push({
          kind: "ai",
          text: "Connection lost and the turn didn't come back. You can resend.",
          error: true,
          failedText: opts.text,
          idempotencyKey: opts.idempotencyKey,
          offline:
            typeof navigator !== "undefined" && navigator.onLine === false,
          ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
        });
      }
      push();
      refreshAssistantThreads?.();
      return;
    }

    const live = m.current.msgs.find(
      (msg): msg is Extract<AsstMsg, { kind: "ai" }> =>
        msg.kind === "ai" && msg.streaming === true
    );
    if (live) live.streaming = false;
    // A request that never started (threw before any activity) → resend bubble.
    if (threw !== null && !errored && !aborted) {
      const message = threw instanceof Error ? threw.message : String(threw);
      // A rejected shared folder is a rejection of the SELECTION, not a
      // transient turn failure: say so out of band, because the resend button
      // on the error bubble will keep failing until the chip is removed (#567).
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
    push();
    refreshAssistantThreads?.();
    // On a clean turn, re-fetch so answers gain turn ids + retry pagers.
    if (!errored && !aborted) void reloadTranscript(conversationId);
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
    m.current.pendingAttachments = m.current.pendingAttachments.filter(
      (a) => a.state !== "ready"
    );
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
    if (!msg || msg.kind !== "ai" || !msg.error || msg.failedText === undefined)
      return;
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

  const setFeedback = (turnId: string, value: "up" | "down"): void => {
    const conversationId = m.current.currentId;
    if (!conversationId) return;
    let applied: "up" | "down" | null = null;
    for (const msg of m.current.msgs) {
      if (msg.kind !== "ai") continue;
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
    void setConversationFeedback(
      ASSISTANT_APP_ID,
      conversationId,
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
    model.disposed = false;
    return () => {
      model.disposed = true;
      model.abort?.abort();
    };
  }, []);

  useEffect(() => {
    if (conversationId && suppressSelectRef.current === conversationId) {
      suppressSelectRef.current = null;
      return;
    }
    void selectThread(conversationId ?? null);
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

  // Slash commands (§4) — minimal + extensible, each firing an existing UI
  // action. Export/Rename need an open (created) conversation.
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

  return (
    <div className={mainScrollCss.hasWall}>
      {/* Which space this conversation reads (issue #599). A picker while the
          conversation is still hypothetical; a plain statement once it exists,
          because the space is part of the thread's identity from then on. */}
      {memberScopes.scopes.length > 0 ? (
        <div className={scopeBarCss.bar}>
          <ScopePicker
            scopes={memberScopes.scopes}
            value={activeScopeId}
            onChange={setPickedScope}
            label={conversationId ? "Reading" : "New conversation in"}
            locked={Boolean(conversationId)}
          />
        </div>
      ) : null}
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
        onAddWorkspace={() => {
          void openPrompt({
            title: "Add a scoped workspace folder",
            placeholder: "/absolute/path/to/folder",
            confirmLabel: "Share folder",
          }).then((directory) => {
            const trimmed = directory?.trim() ?? "";
            if (!trimmed) return;
            // The gateway rejects a bad root with a 400 on the NEXT turn, which
            // reads as a failed answer. Catch what we can name here (#567).
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
        }}
        onRemoveWorkspace={(directory) => {
          m.current.additionalDirectories =
            m.current.additionalDirectories.filter(
              (current) => current !== directory
            );
          push();
        }}
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
        onSetEffort={setEffort}
        onSetRunner={setRunner}
        onSetWorkspaceKind={(workspaceKind) => {
          m.current.workspaceKind = workspaceKind;
          push();
        }}
      />
    </div>
  );
}
