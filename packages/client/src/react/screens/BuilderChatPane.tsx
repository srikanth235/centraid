import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type {
  BuilderAttachmentRef,
  BuilderChatBridgeProps,
  BuilderChatSnapshot,
} from "../screen-contracts.js";
import { cx } from "../ui/cx.js";
import { Icon } from "../ui/index.js";
import { EffortPicker, ModelPicker, RunnerPicker } from "./AssistantScreen.js";
import { BuilderChatMessage } from "./BuilderChatMessages.js";
import ChatComposer from "./ChatComposer.js";
import { workspaceKindLabel } from "./workspaceKindLabel.js";

import chatCss from "../styles/chatMessage.module.css";
import buttonCss from "../ui/Button.module.css";
import styles from "./BuilderChatPane.module.css";

/**
 * Builder chat pane, ported to React (issue #325, Phase 3 — the plan's named
 * starting point for builder.ts). The vanilla `openBuilder` closure keeps the
 * SSE agent stream, the message model, and all turn state, pushing a snapshot
 * on every `renderChat()`. React renders the transcript, the determinate
 * agent-progress strip, and the composer. The version-history view stays a
 * vanilla async renderer injected via `onMountHistory`.
 */
// One composer attachment while it uploads / after it's ready (issue #420).
interface PendingBuilderAttachment {
  localId: string;
  filename: string;
  sizeBytes: number;
  state: "uploading" | "ready" | "error";
  errorText?: string;
  ref?: BuilderAttachmentRef;
}
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function BuilderChatPane({
  onReady,
  onSend,
  onCancel,
  onToggleGroup,
  onSetView,
  onSetWorkspaceKind,
  onSetRunner,
  onSetModel,
  onSetEffort,
  onMountHistory,
  onUploadAttachment,
}: BuilderChatBridgeProps): JSX.Element {
  const [snap, setSnap] = useState<BuilderChatSnapshot>({
    view: "chat",
    messages: [],
    generating: false,
    progress: null,
    suggestions: [],
    composerDisabled: true,
    historyNonce: 0,
    workspaceKind: "draft",
    workspaceKinds: ["draft", "app", "vault-data"],
  });
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingBuilderAttachment[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pickerLoaded, setPickerLoaded] = useState(true);

  const attachFiles = (files: File[]): void => {
    if (!onUploadAttachment) return;
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) continue;
      const localId = crypto.randomUUID();
      setPending((p) => [
        ...p,
        {
          localId,
          filename: file.name,
          sizeBytes: file.size,
          state: "uploading",
        },
      ]);
      void onUploadAttachment(file).then(
        (ref) =>
          setPending((p) =>
            p.map((a) =>
              a.localId === localId ? { ...a, state: "ready", ref } : a
            )
          ),
        (error: unknown) =>
          setPending((p) =>
            p.map((a) =>
              a.localId === localId
                ? {
                    ...a,
                    state: "error",
                    errorText:
                      error instanceof Error ? error.message : "Upload failed",
                  }
                : a
            )
          )
      );
    }
  };

  useEffect(() => {
    onReady((s) => setSnap(s));
  }, [onReady]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snap.messages, snap.generating]);

  // Fill the vanilla history renderer on first switch and on each nonce bump
  // (a version op wants a fresh list). `renderHistoryInto` replaces children,
  // so re-running is idempotent.
  useEffect(() => {
    if (snap.view === "history" && historyRef.current)
      onMountHistory(historyRef.current);
  }, [snap.view, snap.historyNonce, onMountHistory]);

  if (snap.view === "history") {
    return (
      <div className={styles.chatBody}>
        <div className={styles.chatpaneHead}>
          <button
            type="button"
            className={buttonCss.icon}
            aria-label="Back to chat"
            onClick={() => onSetView("chat")}
          >
            <Icon name="ArrowLeft" size={14} />
          </button>
          <span className={styles.chatpaneHeadTitle}>Version history</span>
        </div>
        <div
          className={cx(styles.historyList, styles.chatpaneHistory)}
          ref={historyRef}
        />
      </div>
    );
  }

  const ready = pending.filter(
    (a): a is PendingBuilderAttachment & { ref: BuilderAttachmentRef } =>
      a.state === "ready" && a.ref !== undefined
  );
  const send = (): void => {
    const t = draft.trim();
    if (snap.composerDisabled) return;
    if (!t && ready.length === 0) return;
    if (pending.some((a) => a.state === "uploading")) return;
    setDraft("");
    setPending([]);
    onSend(t, ready.length ? ready.map((a) => a.ref) : undefined);
  };

  return (
    <div className={styles.chatBody}>
      <div
        className={chatCss.scroll}
        ref={scrollRef}
        data-testid="builder-chat-scroll"
      >
        {snap.messages.map((m, i) => (
          <BuilderChatMessage
            key={i}
            message={m}
            onToggleGroup={onToggleGroup}
          />
        ))}
        {snap.generating && snap.progress && (
          <output
            className={styles.abProgress}
            aria-label={`${snap.progress.verb} — running`}
          >
            <span className={styles.abProgressDots} aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <i
                  key={i}
                  data-on={i < snap.progress!.filled ? "true" : undefined}
                />
              ))}
            </span>
            <div className={styles.abProgressMain}>
              <div className={styles.abProgressLine}>
                <span className={styles.abProgressVerb}>
                  {snap.progress.verb}
                </span>
                {snap.progress.file && (
                  <code className={styles.abProgressFile}>
                    {snap.progress.file}
                  </code>
                )}
              </div>
              <div className={styles.abProgressSub}>{snap.progress.sub}</div>
            </div>
            <button
              type="button"
              className={styles.abProgressCancel}
              onClick={() => onCancel()}
            >
              Cancel
            </button>
          </output>
        )}
      </div>
      <div className={styles.chatInputWrap}>
        {snap.suggestions.length > 0 && (
          <div className={styles.promptStartersGroup}>
            <div className={styles.promptStartersLabel}>
              Suggested next moves
            </div>
            <div className={styles.promptStarters}>
              {snap.suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={styles.promptStarter}
                  onClick={() => setDraft(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        <ChatComposer
          value={draft}
          onChange={setDraft}
          onSend={send}
          onStop={onCancel}
          busy={snap.generating}
          disabled={snap.composerDisabled && !snap.generating}
          canSend={
            (draft.trim().length > 0 || ready.length > 0) &&
            !pending.some((a) => a.state === "uploading")
          }
          placeholder="Describe a change…"
          ariaLabel="Describe a builder change"
          context={
            snap.runnerConfig?.supportsContext ? snap.context : undefined
          }
          above={
            pending.length > 0 ? (
              <div className={styles.attachRow}>
                {pending.map((a) => (
                  <div
                    key={a.localId}
                    className={styles.attachChip}
                    data-state={a.state}
                    title={
                      a.state === "error"
                        ? (a.errorText ?? "Upload failed")
                        : a.filename
                    }
                  >
                    <span className={styles.attachName}>{a.filename}</span>
                    <span className={styles.attachSize}>
                      {a.state === "error"
                        ? "failed"
                        : a.state === "uploading"
                          ? "…"
                          : formatBytes(a.sizeBytes)}
                    </span>
                    <button
                      type="button"
                      className={styles.attachRemove}
                      aria-label={`Remove ${a.filename}`}
                      onClick={() =>
                        setPending((p) =>
                          p.filter((x) => x.localId !== a.localId)
                        )
                      }
                    >
                      <Icon name="X" size={10} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null
          }
          leading={
            <>
              {onUploadAttachment && snap.runnerConfig?.supportsAttachments ? (
                <>
                  <button
                    type="button"
                    className={cx(styles.inputPill, styles.inputPillIcon)}
                    aria-label="Attach"
                    title="Attach"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Icon name="Paperclip" size={14} strokeWidth={1.7} />
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    hidden
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      if (files.length) attachFiles(files);
                      e.target.value = "";
                    }}
                  />
                </>
              ) : null}
              <select
                className={styles.inputPill}
                aria-label="Workspace"
                value={snap.workspaceKind}
                onChange={(event) =>
                  onSetWorkspaceKind(
                    event.target.value as BuilderChatSnapshot["workspaceKind"]
                  )
                }
              >
                {snap.workspaceKinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {workspaceKindLabel(kind)}
                  </option>
                ))}
              </select>
            </>
          }
          model={
            snap.runnerConfig ? (
              <>
                <RunnerPicker
                  picker={snap.runnerConfig}
                  loaded={pickerLoaded}
                  busy={snap.generating}
                  onSelect={(runnerKind) => {
                    setPickerLoaded(false);
                    void onSetRunner(runnerKind)
                      .then((next) => {
                        if (!next.supportsAttachments) setPending([]);
                      })
                      .catch(() => {
                        // Same as the assistant composer: the route reports the
                        // failure, the pane only has to re-enable its controls.
                      })
                      .finally(() => setPickerLoaded(true));
                  }}
                />
                <ModelPicker
                  picker={snap.runnerConfig}
                  loaded={pickerLoaded}
                  busy={snap.generating}
                  onSelect={onSetModel}
                />
              </>
            ) : undefined
          }
          effort={
            snap.runnerConfig ? (
              <EffortPicker
                picker={snap.runnerConfig}
                loaded={pickerLoaded}
                busy={snap.generating}
                onSelect={onSetEffort}
              />
            ) : undefined
          }
          // The hint explains the runner picker, so it only makes sense once
          // that picker exists (the runner config arrives with the snapshot).
          {...(snap.runnerConfig
            ? {
                hint: "Switching agents creates a bounded context handoff and may require provider consent.",
              }
            : {})}
        />
      </div>
    </div>
  );
}
