import { useEffect, useRef, useState, type JSX } from 'react';
import { Icon } from '@centraid/desktop-ui';
import type { BuilderChatBridgeProps, BuilderChatSnapshot, BuilderMsgDTO } from '../bridge.js';

// Builder-specific glyphs not in the shared icon set (mirrors the inline SVGs
// in builder.ts), as small components so the React pane paints identically.
function BoltGlyph(): JSX.Element {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
    </svg>
  );
}
function ChevronDownGlyph(): JSX.Element {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
function FileEditGlyph(): JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
      <polyline points="14 3 14 9 20 9" />
      <path d="M18 13l3 3-5 5h-3v-3z" />
    </svg>
  );
}
function PaperclipGlyph(): JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
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
      className="tool-group"
      data-open={String(m.open)}
      data-running={String(m.running)}
      data-error={String(m.error)}
      data-has-changes={String(m.change != null)}
    >
      <button
        type="button"
        className="tool-group-pill"
        aria-expanded={m.open}
        onClick={() => onToggleGroup(m.id)}
      >
        <span className="tg-bolt">
          <BoltGlyph />
        </span>
        <span className="tg-label">{m.label}</span>
        <span className="tg-chev">
          <ChevronDownGlyph />
        </span>
      </button>
      {m.change && (
        <button
          type="button"
          className="tg-change-card"
          aria-label={`${m.change.count} file${m.change.count === 1 ? '' : 's'} updated — toggle details`}
          onClick={() => onToggleGroup(m.id)}
        >
          <span className="tg-card-icon">
            <FileEditGlyph />
          </span>
          <span className="tg-card-meta">
            <span className="tg-card-title">
              {m.change.count} file{m.change.count === 1 ? '' : 's'} updated
            </span>
            <span className="tg-card-sub">{m.change.subtitle}</span>
          </span>
          <span className="tg-card-version">→ {m.change.version}</span>
        </button>
      )}
      {m.open && (
        <div className="tg-list">
          {m.rows.map((r, i) => (
            <div key={i} className="tg-row" data-state={r.state}>
              <span className="tg-dot" data-state={r.state} />
              <span className="tg-row-name">{r.verb}</span>
              <span className="tg-row-target">{r.target}</span>
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
        <div className="chat-divider">
          <span>{m.text}</span>
        </div>
      );
    case 'status':
      return (
        <div className="chat-status-row">
          <span className="msg-status">
            {m.spinning ? <span className="pulse" /> : <Icon name="Check" size={12} strokeWidth={2.5} />}
            {' ' + m.text}
          </span>
        </div>
      );
    case 'user':
      return (
        <div className="msg-user">
          <div className="msg-user-bubble">{m.text}</div>
        </div>
      );
    case 'thinking':
      return (
        <div className="chat-thinking" data-streaming={String(m.streaming)}>
          <div className="thinking-header">
            <span className="thinking-dot" />
            <span>{m.header}</span>
          </div>
          <div className="thinking-body">{m.text}</div>
        </div>
      );
    case 'toolGroup':
      return <ToolGroup m={m} onToggleGroup={onToggleGroup} />;
    case 'ai':
      return (
        <div className="msg-ai">
          <span className="msg-ai-avatar">
            <Icon name="Sparkle" size={11} />
          </span>
          <div className="msg-ai-text">
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
export default function BuilderChatPane({
  onReady,
  onSend,
  onCancel,
  onToggleGroup,
  onSetView,
  onMountHistory,
}: BuilderChatBridgeProps): JSX.Element {
  const [snap, setSnap] = useState<BuilderChatSnapshot>({
    view: 'chat',
    messages: [],
    generating: false,
    progress: null,
    suggestions: [],
    composerDisabled: true,
    historyNonce: 0,
  });
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);

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
      <div className="chat-body">
        <div className="chatpane-head">
          <button
            type="button"
            className="btn-icon"
            aria-label="Back to chat"
            onClick={() => onSetView('chat')}
          >
            <Icon name="ArrowLeft" size={14} />
          </button>
          <span className="chatpane-head-title">Version history</span>
        </div>
        <div className="history-list chatpane-history" ref={historyRef} />
      </div>
    );
  }

  const send = (): void => {
    const t = draft.trim();
    if (!t || snap.composerDisabled) return;
    setDraft('');
    onSend(t);
  };

  return (
    <div className="chat-body">
      <div className="chat-scroll" ref={scrollRef}>
        {snap.messages.map((m, i) => (
          <Message key={i} m={m} onToggleGroup={onToggleGroup} />
        ))}
        {snap.generating && snap.progress && (
          <div className="ab-progress" role="status" aria-label={`${snap.progress.verb} — running`}>
            <span className="ab-progress-dots" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <i key={i} data-on={i < snap.progress!.filled ? 'true' : undefined} />
              ))}
            </span>
            <div className="ab-progress-main">
              <div className="ab-progress-line">
                <span className="ab-progress-verb">{snap.progress.verb}</span>
                {snap.progress.file && <code className="ab-progress-file">{snap.progress.file}</code>}
              </div>
              <div className="ab-progress-sub">{snap.progress.sub}</div>
            </div>
            <button type="button" className="ab-progress-cancel" onClick={onCancel}>
              Cancel
            </button>
          </div>
        )}
      </div>
      <div className="chat-input-wrap">
        {snap.suggestions.length > 0 && (
          <div className="prompt-starters-group">
            <div className="prompt-starters-label">Suggested next moves</div>
            <div className="prompt-starters">
              {snap.suggestions.map((s) => (
                <button key={s} type="button" className="prompt-starter" onClick={() => setDraft(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="chat-input">
          <textarea
            placeholder="Describe a change…"
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="chat-input-controls">
            <button type="button" className="input-pill input-pill-icon" aria-label="Attach" title="Attach">
              <PaperclipGlyph />
            </button>
            <div className="spacer" />
            <span className="chat-input-kbd">⌘↵</span>
            <button type="button" className="send-btn" aria-label="Send" onClick={send}>
              <Icon name="ArrowRight" size={14} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
