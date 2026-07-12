import { useEffect, useRef, useState, type JSX } from 'react';
import type {
  AsstMsgDTO,
  AsstModelPickerDTO,
  AssistantBridgeProps,
  AssistantSnapshot,
} from '../screen-contracts.js';
import styles from './AssistantScreen.module.css';
import { cx } from '../ui/cx.js';
import Icon from '../ui/Icon.js';
import asstPreCss from '../styles/asstPre.module.css';

const EMPTY_MODEL_PICKER: AsstModelPickerDTO = {
  connected: false,
  models: [],
  defaultModelName: '',
  selectedModelId: '',
};

// Attach-clip glyph — not in @centraid/design-tokens' icon set (see the
// shell's chrome-local `glyphs.tsx` for the same pattern), so it's a small
// local SVG rather than a design-tokens addition for one button.
function PaperclipGlyph(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21.44 11.05l-9.19 9.19a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a1.5 1.5 0 0 1-2.12-2.12l8.49-8.48" />
    </svg>
  );
}

/**
 * Inline composer model picker (subsystem `assistant`, active runner) —
 * a quiet text control mirroring Claude Code's composer strip. Shows the
 * chosen model's name, or "Default · <default model>" when the subsystem
 * has no override. The popover is a `role="menu"` of `menuitemradio`
 * options — "Use default" first, then the runner's catalog — so a screen
 * reader announces it as a single-choice picker, not a generic action menu.
 */
function ModelPicker({
  picker,
  loaded,
  onSelect,
  busy,
}: {
  picker: AsstModelPickerDTO;
  loaded: boolean;
  onSelect: (modelId: string) => void;
  busy: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const selected = picker.models.find((m) => m.id === picker.selectedModelId);
  const label = !loaded
    ? 'Model'
    : selected
      ? (selected.name ?? selected.id)
      : `Default · ${picker.defaultModelName || 'gateway default'}`;

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
        disabled={!loaded || busy}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.modelBtnLabel}>{label}</span>
        <Icon name="ChevronDown" size={11} />
      </button>
      {open ? (
        <div className={styles.modelMenu} role="menu" aria-label="Choose the assistant model">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!picker.selectedModelId}
            className={styles.modelItem}
            data-active={!picker.selectedModelId ? 'true' : undefined}
            onClick={() => choose('')}
          >
            <span>Use default</span>
            <span className={styles.modelItemHint}>
              {picker.defaultModelName || 'gateway default'}
            </span>
          </button>
          {picker.models.length ? <div className={styles.modelDivider} /> : null}
          {picker.models.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={picker.selectedModelId === m.id}
              className={styles.modelItem}
              data-active={picker.selectedModelId === m.id ? 'true' : undefined}
              onClick={() => choose(m.id)}
            >
              <span>{m.name ?? m.id}</span>
              {m.default ? <span className={styles.modelItemHint}>default</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function ToolsMsg({
  label,
  calls,
}: {
  label: string;
  calls: { tool: string; sql?: string; state: string; meta: string }[];
}): JSX.Element {
  return (
    <div className={cx(styles.msg, styles.msgTools)}>
      <details className={styles.tools}>
        <summary>{label}</summary>
        <div className={styles.toolsBody}>
          {calls.map((c, i) => (
            <div key={i} className={styles.tool} data-state={c.state}>
              {c.sql ? <pre className={asstPreCss.asstPre}>{c.sql}</pre> : <span>{c.tool}</span>}
              <div className={styles.toolMeta}>{c.meta}</div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function Message({
  m,
  hydrateRefs,
}: {
  m: AsstMsgDTO;
  hydrateRefs: (node: HTMLElement) => void;
}): JSX.Element {
  if (m.kind === 'user') {
    return (
      <div className={cx(styles.msg, styles.msgUser)}>
        {m.attachments?.length ? (
          <div className={styles.msgAttachments}>
            {m.attachments.map((a, i) => (
              <div key={`${a.hash}-${i}`} className={styles.msgAttachChip} title={a.filename}>
                <span className={styles.attachName}>{a.filename}</span>
                <span className={styles.attachSize}>{formatBytes(a.sizeBytes)}</span>
              </div>
            ))}
          </div>
        ) : null}
        {m.text ? <div>{m.text}</div> : null}
      </div>
    );
  }
  if (m.kind === 'tools') {
    return <ToolsMsg label={m.label} calls={m.calls} />;
  }
  if (m.streaming) {
    return (
      <div className={cx(styles.msg, styles.msgAi)}>
        <div className={styles.live}>{m.text}</div>
        <span className={styles.cursor} />
      </div>
    );
  }
  // Final AI answer — the vanilla `richAnswer` HTML, injected + re-hydrated.
  return (
    <div
      className={cx(styles.msg, styles.msgAi)}
      data-error={m.error ? 'true' : undefined}
      ref={(node) => {
        if (node) hydrateRefs(node);
      }}
      // eslint-disable-next-line react/no-danger -- (#325) markup from the trusted vanilla richAnswer renderer
      dangerouslySetInnerHTML={{ __html: m.html }}
    />
  );
}

/**
 * Assistant copilot, ported to React (issue #325, Phase 3). AssistantRoute
 * owns the stream + message model + the rich-answer renderer and pushes a
 * snapshot on each change (via `onReady`); React renders the transcript and
 * composer. Final answers arrive as pre-rendered HTML that React injects and
 * re-hydrates (interactive vault refs) via `hydrateRefs`.
 *
 * The conversation list + selection live in the shell sidebar now (App.tsx +
 * Sidebar.tsx's "Chats" section) — this screen renders exactly one
 * conversation, full width.
 */
export default function AssistantScreen({
  suggestions,
  onReady,
  onSend,
  onStop,
  onAttachFiles,
  onRemovePendingAttachment,
  hydrateRefs,
  loadModelPicker,
  onSetModel,
}: AssistantBridgeProps): JSX.Element {
  const [snap, setSnap] = useState<AssistantSnapshot>({
    empty: true,
    busy: false,
    messages: [],
    pendingAttachments: [],
  });
  const [draft, setDraft] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [modelPicker, setModelPicker] = useState<AsstModelPickerDTO>(EMPTY_MODEL_PICKER);
  const [modelPickerLoaded, setModelPickerLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snap.messages]);

  const hasReadyAttachment = snap.pendingAttachments.some((a) => a.state === 'ready');

  const send = (): void => {
    const t = draft.trim();
    if (snap.busy || (!t && !hasReadyAttachment)) return;
    setDraft('');
    onSend(t);
  };

  const selectModel = (modelId: string): void => {
    // Optimistic — Settings and this picker both read `model.<kind>.assistant`,
    // so the next mount of either surface re-fetches and agrees regardless.
    setModelPicker((p) => ({ ...p, selectedModelId: modelId }));
    onSetModel(modelId);
  };

  return (
    <div className={styles.asst}>
      <section className={styles.chat}>
        <div className={styles.scroll} ref={scrollRef}>
          {snap.empty ? (
            <div className={styles.empty}>
              <div className={styles.emptyTitle}>Ask your vault</div>
              <div className={styles.emptySub}>
                Questions can span everything the vault holds — people, notes, money, events — and
                their connections.
              </div>
              <div className={styles.suggest}>
                {suggestions.map((q) => (
                  <button
                    key={q}
                    type="button"
                    className={styles.suggestChip}
                    onClick={() => setDraft(q)}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            snap.messages.map((m, i) => <Message key={i} m={m} hydrateRefs={hydrateRefs} />)
          )}
        </div>
        <div className={styles.composer}>
          {/* The one cohesive rounded composer frame — attachment chips (if
              any), the auto-growing textarea, then a slim controls strip —
              modeled on Claude Code's composer. `.composerRow` is the whole
              frame now (drop target + focus-ring host), not just the input
              row, but the class name stays so e2e drop-target selectors and
              existing tests keep working. */}
          <div
            className={styles.composerRow}
            data-dragover={dragOver ? 'true' : undefined}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const files = Array.from(e.dataTransfer.files ?? []);
              if (files.length) onAttachFiles(files);
            }}
          >
            {snap.pendingAttachments.length > 0 ? (
              <div className={styles.attachRow}>
                {snap.pendingAttachments.map((a) => (
                  <div
                    key={a.id}
                    className={styles.attachChip}
                    data-state={a.state}
                    title={a.state === 'error' ? (a.errorText ?? 'Upload failed') : a.filename}
                  >
                    {a.state === 'uploading' ? <span className={styles.attachSpinner} /> : null}
                    <span className={styles.attachName}>{a.filename}</span>
                    <span className={styles.attachSize}>
                      {a.state === 'error' ? 'failed' : formatBytes(a.sizeBytes)}
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
            <textarea
              className={styles.input}
              rows={1}
              placeholder="Ask your vault anything…"
              data-busy={snap.busy ? '' : undefined}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData?.files ?? []);
                if (files.length) onAttachFiles(files);
              }}
            />
            <div className={styles.controls}>
              <div className={styles.controlsLeft}>
                <button
                  type="button"
                  className={styles.attachBtn}
                  aria-label="Attach files"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <PaperclipGlyph />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length) onAttachFiles(files);
                    e.target.value = '';
                  }}
                />
              </div>
              <div className={styles.controlsRight}>
                <ModelPicker
                  picker={modelPicker}
                  loaded={modelPickerLoaded}
                  busy={snap.busy}
                  onSelect={selectModel}
                />
                <button
                  type="button"
                  className={styles.send}
                  aria-label={snap.busy ? 'Stop' : 'Send'}
                  onClick={() => (snap.busy ? onStop() : send())}
                >
                  {snap.busy ? '■' : '↑'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
