import { useEffect, useRef, useState, type JSX } from 'react';
import type { AsstMsgDTO, AssistantBridgeProps, AssistantSnapshot } from '../bridge.js';

function ToolsMsg({
  label,
  calls,
}: {
  label: string;
  calls: { tool: string; sql?: string; state: string; meta: string }[];
}): JSX.Element {
  return (
    <div className="cd-asst-msg cd-asst-msg-tools">
      <details className="cd-asst-tools">
        <summary>{label}</summary>
        <div className="cd-asst-tools-body">
          {calls.map((c, i) => (
            <div key={i} className="cd-asst-tool" data-state={c.state}>
              {c.sql ? <pre className="cd-asst-pre">{c.sql}</pre> : <span>{c.tool}</span>}
              <div className="cd-asst-tool-meta">{c.meta}</div>
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
      <div className="cd-asst-msg cd-asst-msg-user">
        <div>{m.text}</div>
      </div>
    );
  }
  if (m.kind === 'tools') {
    return <ToolsMsg label={m.label} calls={m.calls} />;
  }
  if (m.streaming) {
    return (
      <div className="cd-asst-msg cd-asst-msg-ai">
        <div className="cd-asst-live">{m.text}</div>
        <span className="cd-asst-cursor" />
      </div>
    );
  }
  // Final AI answer — the vanilla `richAnswer` HTML, injected + re-hydrated.
  return (
    <div
      className="cd-asst-msg cd-asst-msg-ai"
      data-error={m.error ? 'true' : undefined}
      ref={(node) => {
        if (node) hydrateRefs(node);
      }}
      // eslint-disable-next-line react/no-danger -- markup from the trusted vanilla richAnswer renderer
      dangerouslySetInnerHTML={{ __html: m.html }}
    />
  );
}

/**
 * Assistant copilot, ported to React (issue #325, Phase 3). The vanilla side
 * owns the stream + message model + the rich-answer renderer and pushes a
 * snapshot on each change (via `onReady`); React renders the threads sidebar,
 * transcript, and composer. Final answers arrive as pre-rendered HTML that
 * React injects and re-hydrates (interactive vault refs) via `hydrateRefs`.
 */
export default function AssistantScreen({
  suggestions,
  onReady,
  onSend,
  onStop,
  onSelectThread,
  onDeleteThread,
  hydrateRefs,
}: AssistantBridgeProps): JSX.Element {
  const [snap, setSnap] = useState<AssistantSnapshot>({ threads: [], empty: true, busy: false, messages: [] });
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onReady((s) => setSnap(s));
  }, [onReady]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snap.messages]);

  const send = (): void => {
    const t = draft.trim();
    if (!t || snap.busy) return;
    setDraft('');
    onSend(t);
  };

  return (
    <div className="cd-asst">
      <aside className="cd-asst-side">
          <button type="button" className="cd-asst-new" onClick={() => onSelectThread(null)}>
            + New conversation
          </button>
          <div className="cd-asst-threads">
            {snap.threads.length === 0 ? (
              <div className="cd-asst-threads-empty">No conversations yet</div>
            ) : (
              snap.threads.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="cd-asst-thread"
                  data-active={t.active ? 'true' : undefined}
                  onClick={() => onSelectThread(t.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onDeleteThread(t.id);
                  }}
                >
                  <span className="cd-asst-thread-title">{t.title || 'New conversation'}</span>
                  <span className="cd-asst-thread-time">{t.timeLabel}</span>
                </button>
              ))
            )}
          </div>
        </aside>

        <section className="cd-asst-chat">
          <div className="cd-asst-scroll" ref={scrollRef}>
            {snap.empty ? (
              <div className="cd-asst-empty">
                <div className="cd-asst-empty-title">Ask your vault</div>
                <div className="cd-asst-empty-sub">
                  Questions can span everything the vault holds — people, notes, money, events — and
                  their connections.
                </div>
                <div className="cd-asst-suggest">
                  {suggestions.map((q) => (
                    <button
                      key={q}
                      type="button"
                      className="cd-asst-suggest-chip"
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
          <div className="cd-asst-composer">
            <textarea
              className="cd-asst-input"
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
            />
            <button
              type="button"
              className="cd-asst-send"
              aria-label={snap.busy ? 'Stop' : 'Send'}
              onClick={() => (snap.busy ? onStop() : send())}
            >
              {snap.busy ? '■' : '↑'}
            </button>
          </div>
      </section>
    </div>
  );
}
