import { useEffect, useRef, useState, type JSX } from 'react';
import { Icon } from '../ui/index.js';
import type {
  BuilderAttachmentRef,
  BuilderChatBridgeProps,
  BuilderChatSnapshot,
  BuilderMsgDTO,
} from '../screen-contracts.js';
import styles from './BuilderChatPane.module.css';
import buttonCss from '../ui/Button.module.css';
import { cx } from '../ui/cx.js';
import tgCss from '../styles/toolGroup.module.css';
import chatCss from '../styles/chatMessage.module.css';
import ChatComposer from './ChatComposer.js';
import { EffortPicker, ModelPicker, RunnerPicker } from './AssistantScreen.js';
import { workspaceKindLabel } from './workspaceKindLabel.js';

// Builder-specific status glyphs not yet in the shared icon set.
function BoltGlyph(): JSX.Element {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
    </svg>
  );
}
function ChevronDownGlyph(): JSX.Element {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
function ToolGroup({
  m,
  onToggleGroup,
}: {
  m: Extract<BuilderMsgDTO, { kind: 'toolGroup' }>;
  onToggleGroup: (id: string) => void;
}): JSX.Element {
  return (
    <div
      className={tgCss.group}
      data-testid="tool-group"
      data-open={String(m.open)}
      data-running={String(m.running)}
      data-error={String(m.error)}
      data-has-changes={String(m.change != null)}
    >
      <button
        type="button"
        className={tgCss.groupPill}
        aria-expanded={m.open}
        onClick={() => onToggleGroup(m.id)}
      >
        <span className={tgCss.bolt}>
          <BoltGlyph />
        </span>
        <span className={tgCss.label}>{m.label}</span>
        <span className={tgCss.chev}>
          <ChevronDownGlyph />
        </span>
      </button>
      {m.change && (
        <button
          type="button"
          className={styles.tgChangeCard}
          aria-label={`${m.change.count} file${m.change.count === 1 ? '' : 's'} updated — toggle details`}
          onClick={() => onToggleGroup(m.id)}
        >
          <span className={styles.tgCardIcon}>
            <Icon name="FileEdit" size={14} strokeWidth={1.7} />
          </span>
          <span className={styles.tgCardMeta}>
            <span className={styles.tgCardTitle}>
              {m.change.count} file{m.change.count === 1 ? '' : 's'} updated
            </span>
            <span className={styles.tgCardSub}>{m.change.subtitle}</span>
          </span>
          <span className={styles.tgCardVersion}>→ {m.change.version}</span>
        </button>
      )}
      {m.open && (
        <div className={tgCss.list}>
          {m.rows.map((r, i) => (
            <div key={i} className={tgCss.row} data-state={r.state}>
              <span className={tgCss.dot} data-state={r.state} />
              <span className={tgCss.rowName}>{r.verb}</span>
              <span className={tgCss.rowTarget}>{r.target}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Message({
  m,
  onToggleGroup,
}: {
  m: BuilderMsgDTO;
  onToggleGroup: (id: string) => void;
}): JSX.Element {
  switch (m.kind) {
    case 'divider':
      return (
        <div className={styles.chatDivider}>
          <span>{m.text}</span>
        </div>
      );
    case 'status':
      return (
        <div className={styles.chatStatusRow}>
          <span className={chatCss.status}>
            {m.spinning ? (
              <span className={chatCss.pulse} />
            ) : (
              <Icon name="Check" size={12} strokeWidth={2.5} />
            )}
            {' ' + m.text}
          </span>
        </div>
      );
    case 'user':
      return (
        <div className={chatCss.user}>
          <div className={chatCss.userBubble}>{m.text}</div>
        </div>
      );
    case 'thinking':
      return (
        <div className={styles.chatThinking} data-streaming={String(m.streaming)}>
          <div className={styles.thinkingHeader}>
            <span className={styles.thinkingDot} />
            <span>{m.header}</span>
          </div>
          <div className={styles.thinkingBody}>{m.text}</div>
        </div>
      );
    case 'toolGroup':
      return <ToolGroup m={m} onToggleGroup={onToggleGroup} />;
    case 'ai':
      return (
        <div className={chatCss.ai}>
          <span className={styles.msgAiAvatar}>
            <Icon name="Sparkle" size={11} />
          </span>
          <div className={chatCss.aiText} data-testid="builder-ai-text">
            {m.paras.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        </div>
      );
  }
}

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
  state: 'uploading' | 'ready' | 'error';
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
    view: 'chat',
    messages: [],
    generating: false,
    progress: null,
    suggestions: [],
    composerDisabled: true,
    historyNonce: 0,
    workspaceKind: 'draft',
    workspaceKinds: ['draft', 'app', 'vault-data'],
  });
  const [draft, setDraft] = useState('');
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
        { localId, filename: file.name, sizeBytes: file.size, state: 'uploading' },
      ]);
      void onUploadAttachment(file).then(
        (ref) =>
          setPending((p) =>
            p.map((a) => (a.localId === localId ? { ...a, state: 'ready', ref } : a)),
          ),
        (err: unknown) =>
          setPending((p) =>
            p.map((a) =>
              a.localId === localId
                ? {
                    ...a,
                    state: 'error',
                    errorText: err instanceof Error ? err.message : 'Upload failed',
                  }
                : a,
            ),
          ),
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
    if (snap.view === 'history' && historyRef.current) onMountHistory(historyRef.current);
  }, [snap.view, snap.historyNonce, onMountHistory]);

  if (snap.view === 'history') {
    return (
      <div className={styles.chatBody}>
        <div className={styles.chatpaneHead}>
          <button
            type="button"
            className={buttonCss.icon}
            aria-label="Back to chat"
            onClick={() => onSetView('chat')}
          >
            <Icon name="ArrowLeft" size={14} />
          </button>
          <span className={styles.chatpaneHeadTitle}>Version history</span>
        </div>
        <div className={cx(styles.historyList, styles.chatpaneHistory)} ref={historyRef} />
      </div>
    );
  }

  const ready = pending.filter(
    (a): a is PendingBuilderAttachment & { ref: BuilderAttachmentRef } =>
      a.state === 'ready' && a.ref !== undefined,
  );
  const send = (): void => {
    const t = draft.trim();
    if (snap.composerDisabled) return;
    if (!t && ready.length === 0) return;
    if (pending.some((a) => a.state === 'uploading')) return;
    setDraft('');
    setPending([]);
    onSend(t, ready.length ? ready.map((a) => a.ref) : undefined);
  };

  return (
    <div className={styles.chatBody}>
      <div className={chatCss.scroll} ref={scrollRef} data-testid="builder-chat-scroll">
        {snap.messages.map((m, i) => (
          <Message key={i} m={m} onToggleGroup={onToggleGroup} />
        ))}
        {snap.generating && snap.progress && (
          <output className={styles.abProgress} aria-label={`${snap.progress.verb} — running`}>
            <span className={styles.abProgressDots} aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <i key={i} data-on={i < snap.progress!.filled ? 'true' : undefined} />
              ))}
            </span>
            <div className={styles.abProgressMain}>
              <div className={styles.abProgressLine}>
                <span className={styles.abProgressVerb}>{snap.progress.verb}</span>
                {snap.progress.file && (
                  <code className={styles.abProgressFile}>{snap.progress.file}</code>
                )}
              </div>
              <div className={styles.abProgressSub}>{snap.progress.sub}</div>
            </div>
            <button type="button" className={styles.abProgressCancel} onClick={onCancel}>
              Cancel
            </button>
          </output>
        )}
      </div>
      <div className={styles.chatInputWrap}>
        {snap.suggestions.length > 0 && (
          <div className={styles.promptStartersGroup}>
            <div className={styles.promptStartersLabel}>Suggested next moves</div>
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
            !pending.some((a) => a.state === 'uploading')
          }
          placeholder="Describe a change…"
          ariaLabel="Describe a builder change"
          context={snap.runnerConfig?.supportsContext ? snap.context : undefined}
          above={
            pending.length > 0 ? (
              <div className={styles.attachRow}>
                {pending.map((a) => (
                  <div
                    key={a.localId}
                    className={styles.attachChip}
                    data-state={a.state}
                    title={a.state === 'error' ? (a.errorText ?? 'Upload failed') : a.filename}
                  >
                    <span className={styles.attachName}>{a.filename}</span>
                    <span className={styles.attachSize}>
                      {a.state === 'error'
                        ? 'failed'
                        : a.state === 'uploading'
                          ? '…'
                          : formatBytes(a.sizeBytes)}
                    </span>
                    <button
                      type="button"
                      className={styles.attachRemove}
                      aria-label={`Remove ${a.filename}`}
                      onClick={() => setPending((p) => p.filter((x) => x.localId !== a.localId))}
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
                      e.target.value = '';
                    }}
                  />
                </>
              ) : null}
              <select
                className={styles.inputPill}
                aria-label="Workspace"
                value={snap.workspaceKind}
                onChange={(event) =>
                  onSetWorkspaceKind(event.target.value as BuilderChatSnapshot['workspaceKind'])
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
                hint: 'Switching agents creates a bounded context handoff and may require provider consent.',
              }
            : {})}
        />
      </div>
    </div>
  );
}
