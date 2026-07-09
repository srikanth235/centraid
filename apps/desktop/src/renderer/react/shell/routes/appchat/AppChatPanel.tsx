import { type JSX, useEffect, useRef, useState } from 'react';
import { iconSvg } from '../../iconSvg.js';
import AgentModelPicker from './AgentModelPicker.js';
import {
  type AppConversationMsg,
  type AppToolCall,
  bucketFor,
  formatCell,
  parseToolPayload,
  relativeTime,
  safeJson,
  STARTER_PROMPTS,
  summarizeGroup,
  toolVerb,
} from './appChatModel.js';
import { useAppChat } from './useAppChat.js';

// Inline glyphs (kept tiny — the same shapes the vanilla emitted) so the panel
// doesn't need to reach through the shared Icon set for one-offs.
function BoltGlyph({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
    </svg>
  );
}
function ChevronDownGlyph({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
function BackChevronGlyph(): JSX.Element {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 6l-6 6 6 6" />
    </svg>
  );
}
function HistoryBackGlyph(): JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <path d="M10 4l-4 4 4 4" />
    </svg>
  );
}
function MoreGlyph(): JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor">
      <circle cx={5} cy={12} r={1.9} />
      <circle cx={12} cy={12} r={1.9} />
      <circle cx={19} cy={12} r={1.9} />
    </svg>
  );
}
function PaperclipGlyph(): JSX.Element {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}
function StopGlyph(): JSX.Element {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <rect x={2} y={2} width={8} height={8} rx={1.5} />
    </svg>
  );
}
function TrashGlyph(): JSX.Element {
  return (
    <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4h10M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5 4l1 9a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1l1-9" />
    </svg>
  );
}

/** SQL/args + result table for one expanded tool call. */
function ToolDetail({ c }: { c: AppToolCall }): JSX.Element {
  let body: JSX.Element;
  if (c.state === 'running') {
    body = <div className="app-chat-tool-result">Running…</div>;
  } else if (c.state === 'error') {
    body = (
      <div className="app-chat-tool-result app-chat-tool-err">
        Error: {c.errorText ?? 'Tool failed.'}
      </div>
    );
  } else {
    const parsed = parseToolPayload(c.result);
    if (parsed && Array.isArray(parsed.columns) && Array.isArray(parsed.rows)) {
      const columns = parsed.columns as string[];
      const rows = parsed.rows as Array<Record<string, unknown>>;
      body = (
        <div className="app-chat-tool-result">
          {rows.length === 0 ? (
            <div className="app-chat-rows-empty">No rows.</div>
          ) : (
            <table className="app-chat-rows">
              <thead>
                <tr>
                  {columns.map((col) => (
                    <th key={col}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 20).map((r, i) => (
                  <tr key={i}>
                    {columns.map((col) => (
                      <td key={col}>{formatCell(r[col])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {parsed.truncated ? (
            <div className="app-chat-rows-meta">
              {`Showing ${Math.min(20, rows.length)} of ${(parsed.totalRows as number) ?? rows.length} rows.`}
            </div>
          ) : null}
        </div>
      );
    } else if (c.result !== undefined) {
      body = <div className="app-chat-tool-result">{safeJson(c.result)}</div>;
    } else {
      body = <div className="app-chat-tool-result">(no result)</div>;
    }
  }
  return (
    <div className="app-chat-tool-detail">
      {c.sql ? (
        <pre className="app-chat-tool-sql">{c.sql}</pre>
      ) : c.args !== undefined ? (
        <pre className="app-chat-tool-sql">{safeJson(c.args)}</pre>
      ) : null}
      {body}
    </div>
  );
}

function ToolGroupMsg({
  m,
  onToggleGroup,
  onToggleCall,
}: {
  m: Extract<AppConversationMsg, { kind: 'toolGroup' }>;
  onToggleGroup: (id: string) => void;
  onToggleCall: (groupId: string, callId: string) => void;
}): JSX.Element {
  const isRunning = m.calls.some((c) => c.state === 'running');
  const hasError = m.calls.some((c) => c.state === 'error');
  return (
    <div
      className="tool-group"
      data-open={String(m.open)}
      data-running={String(isRunning)}
      data-error={String(hasError)}
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
        <span className="tg-label">{summarizeGroup(m.calls)}</span>
        <span className="tg-chev">
          <ChevronDownGlyph />
        </span>
      </button>
      {m.open && (
        <div className="tg-list">
          {m.calls.map((c) => (
            <div key={c.id}>
              <button
                type="button"
                className="tg-row tg-row-clickable"
                data-state={c.state}
                data-open={String(!!c.open)}
                onClick={() => onToggleCall(m.id, c.id)}
              >
                <span className="tg-dot" data-state={c.state} />
                <span className="tg-row-name">{toolVerb(c.tool)}</span>
                <span className="tg-row-target">{c.summary ?? ''}</span>
                <span className="tg-row-expand">
                  <ChevronDownGlyph size={11} />
                </span>
              </button>
              {c.open && <ToolDetail c={c} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Message({
  m,
  app,
  onToggleGroup,
  onToggleCall,
}: {
  m: AppConversationMsg;
  app: AppMetaResolvedType;
  onToggleGroup: (id: string) => void;
  onToggleCall: (groupId: string, callId: string) => void;
}): JSX.Element {
  if (m.kind === 'user') {
    return (
      <div className="msg-user">
        <div className="msg-user-bubble">{m.text}</div>
      </div>
    );
  }
  if (m.kind === 'ai') {
    const text = m.text || (m.streaming ? '…' : '');
    return (
      <div className={m.error ? 'msg-ai msg-ai-error' : 'msg-ai'}>
        <div className="msg-ai-author">
          <span className="msg-ai-author-dot" style={{ background: app.color }} />
          <span className="msg-ai-author-name">{app.name.toLowerCase()}</span>
        </div>
        <div className="msg-ai-text">
          {text.split('\n\n').map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      </div>
    );
  }
  return <ToolGroupMsg m={m} onToggleGroup={onToggleGroup} onToggleCall={onToggleCall} />;
}

/**
 * Per-app agentic chat copilot, ported to React (issue #325, full-React flip).
 * Renders the ambient FAB + slide-out panel as its own subtree using the same
 * global `.app-chat-*` classes the vanilla `window.AppChat.mount` emitted, and
 * drives an SSE turn against the app via `useAppChat`. Self-contained: it takes
 * only `{ app, appId }` and owns its own FAB/panel DOM.
 */
export default function AppChatPanel({
  app,
  appId,
}: {
  app: AppMetaResolvedType;
  appId: string;
}): JSX.Element {
  const c = useAppChat(app, appId);
  const [draft, setDraft] = useState('');
  const [overflowOpen, setOverflowOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasAtBottom = useRef(true);
  const overflowWrapRef = useRef<HTMLDivElement>(null);

  const onHistory = c.viewMode === 'history';

  // ⌘J toggles the copilot from anywhere in the app view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault();
        c.toggle();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [c]);

  // Focus the composer shortly after the panel opens.
  useEffect(() => {
    if (c.open) {
      const t = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [c.open]);

  // Close the overflow menu on any outside click.
  useEffect(() => {
    if (!overflowOpen) return undefined;
    const onDoc = (e: MouseEvent): void => {
      if (overflowWrapRef.current && !overflowWrapRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    };
    document.addEventListener('click', onDoc, { capture: true });
    return () => document.removeEventListener('click', onDoc, { capture: true });
  }, [overflowOpen]);

  // Autosize the textarea to its content (cap at 140px).
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(140, ta.scrollHeight)}px`;
  }, [draft]);

  // Sticky-bottom: only pin to the bottom on new content if the user was
  // already at (or near) the bottom before the update.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && wasAtBottom.current) el.scrollTop = el.scrollHeight;
  }, [c.messages, c.thinking, c.chatLoading]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (el) wasAtBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
  };

  const send = (): void => {
    const t = draft.trim();
    if (!t || c.busy) return;
    setDraft('');
    c.submit(t);
  };

  const setStarter = (prompt: string): void => {
    setDraft(prompt);
    inputRef.current?.focus();
  };

  // ── History list (grouped by time bucket) ─────────────────────────────────
  const historyBody = (): JSX.Element => {
    if (c.historyLoading) {
      return <div className="app-chat-history-empty">Loading…</div>;
    }
    const q = c.historySearch.trim().toLowerCase();
    const filtered = q
      ? c.historySessions.filter((s) => s.title.toLowerCase().includes(q))
      : c.historySessions;
    if (filtered.length === 0) {
      return (
        <div className="app-chat-history-empty">
          {q ? 'No chats match your search.' : 'No saved chats yet.'}
        </div>
      );
    }
    const now = Date.now();
    const out: JSX.Element[] = [];
    let currentBucket = '';
    for (const s of filtered) {
      const bucket = bucketFor(s.updatedAt, now);
      if (bucket !== currentBucket) {
        currentBucket = bucket;
        out.push(
          <div key={`b-${bucket}`} className="app-chat-history-group">
            {bucket}
          </div>,
        );
      }
      out.push(
        <div key={s.id} className="app-chat-history-row">
          <button
            type="button"
            className="app-chat-history-rowmain"
            onClick={() => c.resumeSession(s)}
          >
            <div className="app-chat-history-title">{s.title || '(untitled chat)'}</div>
            <div className="app-chat-history-meta">{relativeTime(s.updatedAt, now)}</div>
          </button>
          <button
            type="button"
            className="app-chat-history-del"
            aria-label="Delete chat"
            title="Delete chat"
            onClick={(e) => {
              e.stopPropagation();
              c.deleteSession(s);
            }}
          >
            <TrashGlyph />
          </button>
        </div>,
      );
    }
    return <>{out}</>;
  };

  // ── Chat body ─────────────────────────────────────────────────────────────
  const now = Date.now();
  const chatBody = (): JSX.Element => {
    if (c.chatLoading) {
      return (
        <div className="app-chat-loading">
          <span className="pulse" /> Loading chat…
        </div>
      );
    }
    if (c.loadError) {
      return <div className="app-chat-error">{c.loadError}</div>;
    }
    if (c.messages.length === 0) {
      return (
        <div className="app-chat-empty">
          <div className="app-chat-intro-card">
            <div className="app-chat-empty-title">
              Chat with your <span className="app-chat-empty-accent">{app.name}</span> data.
            </div>
            <p className="app-chat-empty-hint">
              Ask questions, add items by talking, or have the assistant update or delete records for
              you.
            </p>
            <div className="app-chat-starters">
              {STARTER_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="app-chat-starter"
                  onClick={() => setStarter(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          {c.recentSessions.length > 0 && (
            <div className="app-chat-recent">
              <div className="app-chat-recent-label">Recent chats</div>
              <div className="app-chat-recent-list">
                {c.recentSessions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="app-chat-recent-row"
                    onClick={() => c.resumeSession(s)}
                  >
                    <span className="app-chat-recent-dot" />
                    <span className="app-chat-recent-title">{s.title || '(untitled chat)'}</span>
                    <span className="app-chat-recent-meta">{relativeTime(s.updatedAt, now)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }
    return (
      <>
        {c.messages.map((m, i) => (
          <Message
            key={i}
            m={m}
            app={app}
            onToggleGroup={(id) => c.toggleGroup(id)}
            onToggleCall={(groupId, callId) => c.toggleCall(groupId, callId)}
          />
        ))}
        {c.thinking && (
          <div className="gen-row">
            <span className="msg-status">
              <span className="pulse" /> Thinking…
            </span>
          </div>
        )}
      </>
    );
  };

  return (
    <>
      <button
        type="button"
        className={c.open ? 'app-chat-fab hidden' : 'app-chat-fab'}
        title="Ask about this app"
        aria-label={`Ask ${app.name}`}
        onClick={() => c.toggle(true)}
      >
        <span
          className="app-chat-fab-icon"
          dangerouslySetInnerHTML={{ __html: iconSvg('Sparkle', 11) }}
        />
        <span className="app-chat-fab-label">Ask {app.name}</span>
        <span className="app-chat-fab-kbd">⌘J</span>
      </button>

      <aside
        className={`app-chat-panel${c.open ? ' open' : ''}${onHistory ? ' view-history' : ''}`}
        aria-hidden={c.open ? 'false' : 'true'}
      >
        <div className="app-chat-head">
          <button
            type="button"
            className="app-chat-icon-btn"
            hidden={!onHistory}
            aria-label="Back to chat"
            title="Back to chat"
            onClick={() => c.setView('chat')}
          >
            <HistoryBackGlyph />
          </button>
          <span
            className="app-chat-avatar"
            dangerouslySetInnerHTML={{ __html: iconSvg('Sparkle', 12) }}
          />
          <div className="app-chat-title">
            <span className="app-chat-title-text">Copilot</span>
            <span className="app-chat-sub">{c.headContext}</span>
          </div>
          <div className="app-chat-head-actions">
            <div className="app-chat-overflow-wrap" hidden={onHistory} ref={overflowWrapRef}>
              <button
                type="button"
                className="app-chat-icon-btn"
                aria-label="More actions"
                title="More"
                onClick={(e) => {
                  e.stopPropagation();
                  setOverflowOpen((o) => !o);
                }}
              >
                <MoreGlyph />
              </button>
              <div className="app-chat-overflow-menu" hidden={!overflowOpen}>
                <button
                  type="button"
                  className="app-chat-overflow-item"
                  onClick={() => {
                    setOverflowOpen(false);
                    c.startNewChat();
                  }}
                >
                  New chat
                </button>
                <button
                  type="button"
                  className="app-chat-overflow-item"
                  onClick={() => {
                    setOverflowOpen(false);
                    c.openHistory();
                  }}
                >
                  Chat history
                </button>
              </div>
            </div>
            <button
              type="button"
              className="app-chat-icon-btn app-chat-close"
              aria-label="Minimize"
              title="Minimize"
              onClick={() => c.toggle(false)}
            >
              <BackChevronGlyph />
            </button>
          </div>
        </div>

        <div
          className="chat-scroll app-chat-scroll"
          hidden={onHistory}
          ref={scrollRef}
          onScroll={onScroll}
        >
          {chatBody()}
        </div>

        <div className="app-chat-history" hidden={!onHistory}>
          <div className="app-chat-history-searchwrap">
            <input
              className="app-chat-history-search"
              type="search"
              placeholder="Search chats…"
              aria-label="Search chats"
              value={c.historySearch}
              onChange={(e) => c.setHistorySearch(e.target.value)}
            />
          </div>
          <div className="app-chat-history-list">{onHistory ? historyBody() : null}</div>
        </div>

        <form
          className="app-chat-input-wrap"
          hidden={onHistory}
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            ref={inputRef}
            className="app-chat-textarea"
            placeholder="Ask about this app’s data…"
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
          <div className="app-chat-input-tools">
            <button
              type="button"
              className="app-chat-attach"
              aria-label="Attach"
              title="Attach"
              onClick={() => fileRef.current?.click()}
            >
              <PaperclipGlyph />
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = '';
                c.addFiles(files);
              }}
            />
            <div className="app-chat-attach-chips">
              {c.attachments.map((a, i) => (
                <span
                  key={`${a.hash}-${i}`}
                  className="app-chat-attach-chip"
                  title={a.filename ?? a.mime}
                >
                  {`${a.filename ?? a.mime} `}
                  <button
                    type="button"
                    aria-label="Remove attachment"
                    onClick={() => c.removeAttachment(a)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <AgentModelPicker active={c.open} registerModelResolver={c.registerModelResolver} />
            <span className="app-chat-input-spacer" />
            <span className="app-chat-input-kbd">⌘↵</span>
            <button
              type="submit"
              className="app-chat-send"
              title="Send"
              aria-label="Send"
              hidden={c.busy}
              disabled={c.busy}
              dangerouslySetInnerHTML={{ __html: iconSvg('ArrowRight', 14) }}
            />
            <button
              type="button"
              className="app-chat-send app-chat-stop"
              title="Stop"
              aria-label="Stop"
              hidden={!c.busy}
              onClick={() => c.cancel()}
            >
              <StopGlyph />
            </button>
          </div>
        </form>
      </aside>
    </>
  );
}
