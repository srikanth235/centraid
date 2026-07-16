import { useEffect, useRef, useState, type JSX } from 'react';
import type {
  AsstModelPickerDTO,
  AssistantBridgeProps,
  AssistantSnapshot,
} from '../screen-contracts.js';
import styles from './AssistantScreen.module.css';
import Icon from '../ui/Icon.js';
import { cx } from '../ui/cx.js';
import Message, { type MessageCallbacks } from './AssistantMessage.js';
import { useAssistantScroll } from './useAssistantScroll.js';
import { clearDraft, loadDraft, saveDraft } from './assistantDrafts.js';
import { useComposerAutocomplete } from './ComposerAutocomplete.js';

const NO_ENTITIES = async (): Promise<never[]> => [];

const EMPTY_MODEL_PICKER: AsstModelPickerDTO = {
  connected: false,
  models: [],
  defaultModelName: '',
  selectedModelId: '',
};

// Attach-clip glyph — not in @centraid/design-tokens' icon set, so a small local SVG.
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
 * Inline composer model picker (subsystem `assistant`, active runner).
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
  const [draft, setDraft] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [modelPicker, setModelPicker] = useState<AsstModelPickerDTO>(EMPTY_MODEL_PICKER);
  const [modelPickerLoaded, setModelPickerLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const { showJump, jumpToBottom } = useAssistantScroll(scrollRef, snap.messages, conversationId);

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
  useEffect(() => {
    setDraft(loadDraft(conversationId));
  }, [conversationId]);

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

  const hasReadyAttachment = snap.pendingAttachments.some((a) => a.state === 'ready');

  const send = (): void => {
    const t = draft.trim();
    if (snap.busy || (!t && !hasReadyAttachment)) return;
    clearDraft(conversationId);
    setDraft('');
    onSend(t);
  };

  const selectModel = (modelId: string): void => {
    setModelPicker((p) => ({ ...p, selectedModelId: modelId }));
    onSetModel(modelId);
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
                  Questions can span everything the vault holds — people, notes, money, events — and
                  their connections.
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
              snap.messages.map((m, i) => <Message key={i} m={m} index={i} cb={messageCallbacks} />)
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
                    className={cx(styles.attachChip, a.previewUrl && styles.attachChipImage)}
                    data-state={a.state}
                    title={a.state === 'error' ? (a.errorText ?? 'Upload failed') : a.filename}
                  >
                    {a.previewUrl ? (
                      <img className={styles.attachThumb} src={a.previewUrl} alt={a.filename} />
                    ) : null}
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
            {autocomplete.popover}
            <textarea
              ref={taRef}
              className={styles.input}
              rows={1}
              placeholder="Ask your vault anything…  (@ to mention, / for commands)"
              data-busy={snap.busy ? '' : undefined}
              value={draft}
              onChange={(e) => autocomplete.onChange(e)}
              onKeyDown={(e) => {
                // The autocomplete menu gets first crack at Arrow/Enter/Tab/Esc.
                if (autocomplete.onKeyDown(e)) return;
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onBlur={() => autocomplete.close()}
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
