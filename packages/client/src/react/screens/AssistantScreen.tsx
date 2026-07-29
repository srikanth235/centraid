// governance: allow-repo-hygiene file-size-limit (#567) the Assistant screen is one stateful composition over the shared composer/status primitives; splitting its bridge state would duplicate fallible control coordination
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type {
  AsstModelPickerDTO,
  AssistantBridgeProps,
  AssistantSnapshot,
} from "../screen-contracts.js";
import { cx } from "../ui/cx.js";
import Icon from "../ui/Icon.js";
import { clearDraft, loadDraft, saveDraft } from "./assistantDrafts.js";
import Message from "./AssistantMessage.js";
import type { MessageCallbacks } from "./AssistantMessage.js";
import ChatComposer from "./ChatComposer.js";
import { useComposerAutocomplete } from "./ComposerAutocomplete.js";
import { useAssistantScroll } from "./useAssistantScroll.js";
import { workspaceKindLabel } from "./workspaceKindLabel.js";

import styles from "./AssistantScreen.module.css";

const NO_ENTITIES = async (): Promise<never[]> => [];

const EMPTY_MODEL_PICKER: AsstModelPickerDTO = {
  runners: [],
  selectedRunnerKind: "",
  workspaceKinds: ["vault-data"],
  connected: false,
  models: [],
  defaultModelName: "",
  selectedModelId: "",
  efforts: [],
  defaultEffortName: "",
  selectedEffortId: "",
};

export function RunnerPicker({
  picker,
  loaded,
  busy,
  onSelect,
}: {
  picker: AsstModelPickerDTO;
  loaded: boolean;
  busy: boolean;
  onSelect: (kind: string) => void;
}): JSX.Element | null {
  if (picker.runners.length === 0) return null;
  return (
    <label className={styles.effortPicker}>
      <span className={styles.srOnly}>Assistant runner</span>
      <select
        aria-label="Assistant runner"
        title="Switching agents creates a bounded context handoff and may require provider consent."
        value={picker.selectedRunnerKind}
        disabled={!loaded || busy}
        onChange={(event) => onSelect(event.target.value)}
      >
        {picker.runners.map((runner) => (
          <option key={runner.kind} value={runner.kind} title={runner.hint}>
            {runner.title}
            {runner.sessionReady
              ? ""
              : runner.sessionProbePending
                ? " — checking…"
                : " — setup or sign-in needed"}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Inline composer model picker (subsystem `assistant`, active runner).
 */
export function ModelPicker({
  picker,
  loaded,
  onSelect,
  busy,
}: {
  picker: AsstModelPickerDTO;
  loaded: boolean;
  onSelect: (modelId: string) => void;
  busy: boolean;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (picker.models.length === 0) return null;
  const selected = picker.models.find((m) => m.id === picker.selectedModelId);
  const label = loaded
    ? selected
      ? (selected.name ?? selected.id)
      : `Default · ${picker.defaultModelName || "gateway default"}`
    : "Model";

  const choose = (modelId: string): void => {
    onSelect(modelId);
    setOpen(false);
  };

  return (
    <div className={styles.modelPicker} ref={rootRef}>
      <button
        type="button"
        className={styles.modelBtn}
        aria-label="Assistant model"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!loaded || busy || picker.modelLocked}
        title={
          picker.modelLocked ? "Pinned by this automation manifest" : undefined
        }
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.modelBtnLabel}>{label}</span>
        <Icon name="ChevronDown" size={11} />
      </button>
      {open ? (
        <div
          className={styles.modelMenu}
          role="menu"
          aria-label="Choose the assistant model"
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!picker.selectedModelId}
            className={styles.modelItem}
            data-active={picker.selectedModelId ? undefined : "true"}
            onClick={() => choose("")}
          >
            <span>Use default</span>
            <span className={styles.modelItemHint}>
              {picker.defaultModelName || "gateway default"}
            </span>
          </button>
          {picker.models.length ? (
            <div className={styles.modelDivider} />
          ) : null}
          {picker.models.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={picker.selectedModelId === m.id}
              className={styles.modelItem}
              data-active={picker.selectedModelId === m.id ? "true" : undefined}
              onClick={() => choose(m.id)}
            >
              <span>{m.name ?? m.id}</span>
              {m.default ? (
                <span className={styles.modelItemHint}>default</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function EffortPicker({
  picker,
  loaded,
  onSelect,
  busy,
}: {
  picker: AsstModelPickerDTO;
  loaded: boolean;
  onSelect: (effort: string) => void;
  busy: boolean;
}): JSX.Element | null {
  if (picker.efforts.length === 0) return null;
  return (
    <label className={styles.effortPicker}>
      <span className={styles.srOnly}>Assistant effort</span>
      <select
        aria-label="Assistant effort"
        value={picker.selectedEffortId}
        disabled={!loaded || busy || picker.effortLocked}
        title={
          picker.effortLocked ? "Pinned by this automation manifest" : undefined
        }
        onChange={(event) => onSelect(event.target.value)}
      >
        <option value="">{`Default · ${picker.defaultEffortName || "agent effort"}`}</option>
        {picker.efforts.map((effort) => (
          <option key={effort.value} value={effort.value}>
            {effort.name ?? effort.value}
          </option>
        ))}
      </select>
    </label>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Assistant copilot screen (issue #325 Phase 3, extended by #420 Wave 1).
 * AssistantRoute owns the stream + message model; this screen renders the
 * transcript (with per-message copy / feedback / regenerate / retry / retry
 * pager / timestamps), a scroll-aware autoscroll with a jump-to-bottom pill,
 * and the composer with per-conversation draft persistence.
 */
export default function AssistantScreen({
  suggestions,
  conversationId,
  onReady,
  onSend,
  onStop,
  onAttachFiles,
  onRemovePendingAttachment,
  onAddWorkspace,
  onRemoveWorkspace,
  hydrateRefs,
  wireCodeCopy,
  loadAttachmentImage,
  onCopyMessage,
  onFeedback,
  onRegenerate,
  onRetryError,
  onPagerNav,
  loadModelPicker,
  onSetModel,
  onSetEffort,
  onSetRunner,
  onSetWorkspaceKind,
  searchEntities,
  slashCommands,
  onRunSlash,
}: AssistantBridgeProps): JSX.Element {
  const [snap, setSnap] = useState<AssistantSnapshot>({
    empty: true,
    busy: false,
    messages: [],
    pendingAttachments: [],
  });
  const [draft, setDraft] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [modelPicker, setModelPicker] =
    useState<AsstModelPickerDTO>(EMPTY_MODEL_PICKER);
  const [modelPickerLoaded, setModelPickerLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const { showJump, jumpToBottom } = useAssistantScroll(
    scrollRef,
    snap.messages,
    conversationId
  );

  useEffect(() => {
    onReady((s) => setSnap(s));
  }, [onReady]);

  useEffect(() => {
    let cancelled = false;
    void loadModelPicker().then((p) => {
      if (cancelled) return;
      setModelPicker(p);
      setModelPickerLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [loadModelPicker]);

  // Restore the per-conversation draft when the open thread changes (§4).
  // Done during render, so the composer never paints the previous thread's
  // draft for a frame after the switch.
  const [seenConversationId, setSeenConversationId] = useState(conversationId);
  if (seenConversationId !== conversationId) {
    setSeenConversationId(conversationId);
    setDraft(loadDraft(conversationId));
  }

  const changeDraft = (v: string): void => {
    setDraft(v);
    saveDraft(conversationId, v);
  };

  // @-mentions + slash-commands (issue #420). Inert when the route wires no
  // entity search / commands (older callers, tests).
  const autocomplete = useComposerAutocomplete({
    textareaRef: taRef,
    setValue: changeDraft,
    searchEntities: searchEntities ?? NO_ENTITIES,
    slashCommands: slashCommands ?? [],
    onRunSlash: onRunSlash ?? (() => undefined),
  });

  const hasReadyAttachment = snap.pendingAttachments.some(
    (a) => a.state === "ready"
  );

  const send = (): void => {
    const t = draft.trim();
    if (snap.busy || (!t && !hasReadyAttachment)) return;
    clearDraft(conversationId);
    setDraft("");
    onSend(t);
  };

  const selectModel = (modelId: string): void => {
    setModelPicker((p) => ({ ...p, selectedModelId: modelId }));
    onSetModel(modelId);
  };
  const selectEffort = (effort: string): void => {
    setModelPicker((picker) => ({ ...picker, selectedEffortId: effort }));
    onSetEffort(effort);
  };
  const selectRunner = (runnerKind: string): void => {
    setModelPickerLoaded(false);
    // `finally` is load-bearing: a rejected switch used to leave every picker
    // disabled forever (plus an unhandled rejection). Mirrors BuilderChatPane.
    void onSetRunner(runnerKind)
      .then((picker) => setModelPicker(picker))
      .catch(() => {
        // The route owns the user-facing failure (it toasts the preflight
        // reason); the screen's only job here is not to strand its controls.
      })
      .finally(() => setModelPickerLoaded(true));
  };

  const messageCallbacks: MessageCallbacks = {
    hydrateRefs,
    wireCodeCopy,
    loadAttachmentImage,
    onCopyMessage,
    onFeedback,
    onRegenerate,
    onRetryError,
    onPagerNav,
  };

  return (
    <div className={styles.asst}>
      <section className={styles.chat}>
        <div className={styles.scrollWrap}>
          <div className={styles.scroll} ref={scrollRef}>
            {snap.empty ? (
              <div className={styles.empty}>
                <div className={styles.emptyTitle}>Ask your vault</div>
                <div className={styles.emptySub}>
                  Questions can span everything the vault holds — people, notes,
                  money, events — and their connections.
                </div>
                <div className={styles.suggest}>
                  {suggestions.map((q) => (
                    <button
                      key={q}
                      type="button"
                      className={styles.suggestChip}
                      onClick={() => changeDraft(q)}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              snap.messages.map((m, i) => (
                <Message key={i} m={m} index={i} cb={messageCallbacks} />
              ))
            )}
          </div>
          {showJump ? (
            <button
              type="button"
              className={styles.jumpToBottom}
              aria-label="Jump to latest"
              onClick={jumpToBottom}
            >
              <Icon name="ArrowRight" size={15} />
            </button>
          ) : null}
        </div>
        <div className={styles.composer}>
          <div
            className={styles.composerRow}
            data-dragover={dragOver ? "true" : undefined}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (modelPicker.supportsAttachments) {
                const files = Array.from(e.dataTransfer.files ?? []);
                if (files.length) onAttachFiles(files);
              }
            }}
          >
            {snap.pendingAttachments.length > 0 ? (
              <div className={styles.attachRow}>
                {snap.pendingAttachments.map((a) => (
                  <div
                    key={a.id}
                    className={cx(
                      styles.attachChip,
                      a.previewUrl && styles.attachChipImage
                    )}
                    data-state={a.state}
                    title={
                      a.state === "error"
                        ? (a.errorText ?? "Upload failed")
                        : a.filename
                    }
                  >
                    {a.previewUrl ? (
                      <img
                        className={styles.attachThumb}
                        src={a.previewUrl}
                        alt={a.filename}
                      />
                    ) : null}
                    {a.state === "uploading" ? (
                      <span className={styles.attachSpinner} />
                    ) : null}
                    <span className={styles.attachName}>{a.filename}</span>
                    <span className={styles.attachSize}>
                      {a.state === "error"
                        ? "failed"
                        : formatBytes(a.sizeBytes)}
                    </span>
                    <button
                      type="button"
                      className={styles.attachRemove}
                      aria-label={`Remove ${a.filename}`}
                      onClick={() => onRemovePendingAttachment(a.id)}
                    >
                      <Icon name="X" size={10} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {snap.additionalDirectories?.length ? (
              <div
                className={styles.attachRow}
                aria-label="Shared workspace folders"
              >
                {snap.additionalDirectories.map((directory) => (
                  <div
                    key={directory}
                    className={styles.attachChip}
                    title={directory}
                  >
                    <Icon name="Folder" size={12} />
                    <span className={styles.attachName}>
                      {directory.match(/[^\\/]+$/u)?.[0] ?? directory}
                    </span>
                    <button
                      type="button"
                      className={styles.attachRemove}
                      aria-label={`Stop sharing ${directory}`}
                      onClick={() => onRemoveWorkspace?.(directory)}
                    >
                      <Icon name="X" size={10} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {autocomplete.popover}
            <ChatComposer
              embedded
              textareaRef={taRef}
              value={draft}
              onChange={(_value, event) => autocomplete.onChange(event)}
              onSend={send}
              onStop={onStop}
              busy={snap.busy}
              canSend={
                draft.trim().length > 0 ||
                snap.pendingAttachments.some(
                  (attachment) => attachment.state === "ready"
                )
              }
              placeholder="Ask your vault anything…  (@ to mention, / for commands)"
              ariaLabel="Ask your vault"
              onKeyDown={(event) => {
                // The autocomplete menu gets first crack at Arrow/Enter/Tab/Esc.
                if (autocomplete.onKeyDown(event)) event.preventDefault();
              }}
              onBlur={() => autocomplete.close()}
              onPaste={(event) => {
                if (modelPicker.supportsAttachments) {
                  const files = Array.from(event.clipboardData?.files ?? []);
                  if (files.length) onAttachFiles(files);
                }
              }}
              context={modelPicker.supportsContext ? snap.context : undefined}
              leading={
                <>
                  {modelPicker.supportsAttachments ? (
                    <>
                      <button
                        type="button"
                        className={styles.attachBtn}
                        aria-label="Attach files"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <Icon name="Paperclip" size={16} strokeWidth={1.7} />
                      </button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        hidden
                        onChange={(e) => {
                          const files = Array.from(e.target.files ?? []);
                          if (files.length) onAttachFiles(files);
                          e.target.value = "";
                        }}
                      />
                    </>
                  ) : null}
                  {modelPicker.supportsAdditionalDirectories ? (
                    <button
                      type="button"
                      className={styles.attachBtn}
                      aria-label="Add scoped workspace folder"
                      title="Share an additional folder with this agent"
                      disabled={snap.busy}
                      onClick={() => onAddWorkspace?.()}
                    >
                      <Icon name="Folder" size={16} />
                    </button>
                  ) : null}
                </>
              }
              model={
                <>
                  <RunnerPicker
                    picker={modelPicker}
                    loaded={modelPickerLoaded}
                    busy={snap.busy}
                    onSelect={selectRunner}
                  />
                  <ModelPicker
                    picker={modelPicker}
                    loaded={modelPickerLoaded}
                    busy={snap.busy}
                    onSelect={selectModel}
                  />
                  {/* One workspace is not a choice — a permanently single-option
                      select just showed the raw 'vault-data' token. */}
                  {modelPicker.workspaceKinds.length > 1 ? (
                    <label className={styles.effortPicker}>
                      <span className={styles.srOnly}>Assistant workspace</span>
                      <select
                        aria-label="Assistant workspace"
                        value={
                          snap.workspaceKind ?? modelPicker.workspaceKinds[0]
                        }
                        disabled={snap.busy}
                        onChange={(event) =>
                          onSetWorkspaceKind?.(
                            event.target.value as "vault-data" | "app" | "draft"
                          )
                        }
                      >
                        {modelPicker.workspaceKinds.map((kind) => (
                          <option key={kind} value={kind}>
                            {workspaceKindLabel(kind)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </>
              }
              effort={
                <EffortPicker
                  picker={modelPicker}
                  loaded={modelPickerLoaded}
                  busy={snap.busy}
                  onSelect={selectEffort}
                />
              }
            />
          </div>
        </div>
      </section>
    </div>
  );
}
