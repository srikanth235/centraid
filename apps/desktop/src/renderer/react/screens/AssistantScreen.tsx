import { useEffect, useRef, useState, type JSX } from 'react';
import type { AsstMsgDTO, AssistantBridgeProps, AssistantSnapshot } from '../screen-contracts.js';
import styles from './AssistantScreen.module.css';
import { cx } from '../ui/cx.js';

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
              {c.sql ? <pre className="cd-asst-pre">{c.sql}</pre> : <span>{c.tool}</span>}
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
        <div>{m.text}</div>
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
  const [snap, setSnap] = useState<AssistantSnapshot>({
    threads: [],
    empty: true,
    busy: false,
    messages: [],
  });
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
    <div className={styles.asst}>
      <aside className={styles.side}>
        <button type="button" className={styles.new} onClick={() => onSelectThread(null)}>
          + New conversation
        </button>
        <div className={styles.threads}>
          {snap.threads.length === 0 ? (
            <div className={styles.threadsEmpty}>No conversations yet</div>
          ) : (
            snap.threads.map((t) => (
              <button
                key={t.id}
                type="button"
                className={styles.thread}
                data-active={t.active ? 'true' : undefined}
                onClick={() => onSelectThread(t.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onDeleteThread(t.id);
                }}
              >
                <span className={styles.threadTitle}>{t.title || 'New conversation'}</span>
                <span className={styles.threadTime}>{t.timeLabel}</span>
              </button>
            ))
          )}
        </div>
      </aside>

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
      </section>
    </div>
  );
}
