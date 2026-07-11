import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { cx } from '../ui/cx.js';
import styles from './LogsScreen.module.css';
import controlsCss from '../styles/controls.module.css';

// Gateway → Logs: the gateway's realtime diagnostics surface. Streams
// the gateway's log lines (SSE, replay-then-live) so a user whose
// automation/sync/outbox is misbehaving can SEE what the gateway is doing
// without hunting for a terminal. Prop-driven like the other settings
// screens: the transport is injected (`streamLogs` → gateway-client),
// this file owns the view + stream lifecycle (reconnect, follow, filter).
// Mounted from the Gateway page's Logs tab (GatewayScreen.tsx).

export type LogLevelDTO = 'info' | 'warn' | 'error';

export interface LogEntryDTO {
  /** Monotonic gateway sequence — the resume/dedupe cursor. */
  seq: number;
  /** Epoch ms the line was emitted. */
  ts: number;
  level: LogLevelDTO;
  message: string;
}

export interface LogsBridgeProps {
  /**
   * Opens the gateway log stream: replays buffered lines past `after`,
   * then live-streams until `signal` aborts. Resolves/rejects on stream
   * close — the screen schedules the reconnect.
   */
  streamLogs: (
    onEntry: (entry: LogEntryDTO) => void,
    signal: AbortSignal,
    after?: number,
  ) => Promise<void>;
  /**
   * A cross-link jump into a focused search — from a failing component in
   * the Components tab, for instance. `nonce` is bumped on every jump
   * request (even a repeat of the same text) so the effect below reapplies;
   * the stream itself keeps running, only the search box changes.
   */
  focusQuery?: { text: string; nonce: number };
}

type StreamStatus = 'connecting' | 'live' | 'reconnecting';

/** Client-side cap — matches the gateway ring so memory stays bounded. */
const MAX_ENTRIES = 2000;
const RECONNECT_MS = 2000;
/** "At the bottom" slack for the follow toggle, in px. */
const FOLLOW_SLACK = 48;

type LevelFilter = 'all' | 'warn' | 'error';

const FILTERS: readonly { id: LevelFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'warn', label: 'Warnings' },
  { id: 'error', label: 'Errors' },
];

function matchesFilter(entry: LogEntryDTO, filter: LevelFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'warn') return entry.level === 'warn' || entry.level === 'error';
  return entry.level === 'error';
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const STATUS_LABEL: Record<StreamStatus, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
};

export default function LogsScreen({ streamLogs, focusQuery }: LogsBridgeProps): JSX.Element {
  const [entries, setEntries] = useState<LogEntryDTO[]>([]);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [filter, setFilter] = useState<LevelFilter>('all');
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (focusQuery) setQuery(focusQuery.text);
    // Only the nonce identifies a fresh jump request — a repeat click with
    // the same text still needs to reapply (and re-focus the search box).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusQuery?.nonce]);

  // The stream's resume cursor + the follow flag live in refs so the
  // long-lived stream effect never restarts on render-state changes.
  const lastSeqRef = useRef(0);
  const followRef = useRef(true);
  followRef.current = follow;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const onEntry = (entry: LogEntryDTO): void => {
      if (entry.seq <= lastSeqRef.current) return; // reconnect-overlap dedupe
      lastSeqRef.current = entry.seq;
      setEntries((prev) => {
        const next =
          prev.length >= MAX_ENTRIES ? prev.slice(prev.length - MAX_ENTRIES + 1) : [...prev];
        next.push(entry);
        return next;
      });
    };

    const connect = (): void => {
      if (signal.aborted) return;
      setStatus((s) => (s === 'connecting' ? s : 'reconnecting'));
      void streamLogs(
        (entry) => {
          // First delivered line = the stream is live.
          setStatus('live');
          onEntry(entry);
        },
        signal,
        lastSeqRef.current || undefined,
      )
        .catch(() => undefined)
        .then(() => {
          if (signal.aborted) return;
          setStatus('reconnecting');
          retryTimer = setTimeout(connect, RECONNECT_MS);
        });
      // A silent-but-healthy stream (no lines yet) still counts as live.
      setStatus((s) => (s === 'connecting' ? 'live' : s));
    };

    connect();
    return () => {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      controller.abort();
    };
  }, [streamLogs]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter(
      (e) => matchesFilter(e, filter) && (q === '' || e.message.toLowerCase().includes(q)),
    );
  }, [entries, filter, query]);

  // Follow: pin the viewport to the newest line unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [visible]);

  const onScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK;
    setFollow(atBottom);
  }, []);

  const jumpToLatest = (): void => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setFollow(true);
  };

  const copyVisible = (): void => {
    const text = visible
      .map((e) => `${new Date(e.ts).toISOString()} [${e.level.toUpperCase()}] ${e.message}`)
      .join('\n');
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const errorCount = useMemo(() => entries.filter((e) => e.level === 'error').length, [entries]);

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <span className={styles.statusDot} data-status={status} />
        <span className={styles.statusLabel} data-status={status}>
          {STATUS_LABEL[status]}
        </span>
        <span className={styles.countLabel}>
          {entries.length} line{entries.length === 1 ? '' : 's'}
          {errorCount > 0 ? ` · ${errorCount} error${errorCount === 1 ? '' : 's'}` : ''}
        </span>
        <div className={styles.filters}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={cx(controlsCss.chip, filter === f.id && styles.chipActive)}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          className={styles.search}
          placeholder="Filter messages…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className={controlsCss.chip}
          onClick={copyVisible}
          disabled={visible.length === 0}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          className={controlsCss.chip}
          onClick={() => setEntries([])}
          disabled={entries.length === 0}
        >
          Clear
        </button>
      </div>

      <div className={styles.logPanel}>
        <div className={styles.logScroll} ref={scrollRef} onScroll={onScroll}>
          {visible.length === 0 ? (
            <div className={styles.empty}>
              {entries.length === 0
                ? 'No log lines yet — gateway activity shows up here as it happens.'
                : 'No lines match the current filter.'}
            </div>
          ) : (
            visible.map((e) => (
              <div key={e.seq} className={styles.line} data-level={e.level}>
                <span className={styles.lineTime}>{timeLabel(e.ts)}</span>
                <span className={styles.lineLevel} data-level={e.level}>
                  {e.level}
                </span>
                <span className={styles.lineMsg}>{e.message}</span>
              </div>
            ))
          )}
        </div>
        {!follow && visible.length > 0 ? (
          <button type="button" className={styles.jumpBtn} onClick={jumpToLatest}>
            Jump to latest
          </button>
        ) : null}
      </div>
    </div>
  );
}
