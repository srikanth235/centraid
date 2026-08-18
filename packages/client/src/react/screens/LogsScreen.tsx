import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import ChipsBlock from "../ui/ChipsBlock.js";
import NoteBlock from "../ui/NoteBlock.js";
import SectionBlock from "../ui/SectionBlock.js";

import controlsCss from "../styles/controls.module.css";
import styles from "./LogsScreen.module.css";

// System → Logs: the gateway's realtime diagnostics surface. Streams
// the gateway's log lines (SSE, replay-then-live) so a user whose
// automation/sync/outbox is misbehaving can SEE what the gateway is doing
// without hunting for a terminal. Prop-driven like the other settings
// screens: the transport is injected (`streamLogs` → gateway-client),
// this file owns the view + stream lifecycle (reconnect, follow, filter).
// Mounted from System's Logs drill-in (GatewayScreen.tsx).
//
// THE STREAM STAYS A STREAM (binding layer v11). The handoff draws Logs as
// five rows, which is what a static mock of a log looks like; two thousand
// live lines are not rows, and folding them into the row block would cost the
// windowing, the follow-the-tail behaviour and the monospace column that makes
// a timestamped stream scannable at all. What v11 fixes here is the FURNITURE
// around it: the status dot, the line count and the export verb were a bespoke
// toolbar, and are now the section head; the level filter was three hand-rolled
// chips and is now the kit's chip group. The search box, Copy and Clear stay a
// control row — they act on the pane below them, not on the section.

export type LogLevelDTO = "info" | "warn" | "error";

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
    after?: number
  ) => Promise<void>;
  /**
   * A cross-link jump into a focused search — from a failing component in
   * the Components tab, for instance. `nonce` is bumped on every jump
   * request (even a repeat of the same text) so the effect below reapplies;
   * the stream itself keeps running, only the search box changes.
   */
  focusQuery?: { text: string; nonce: number };
  /**
   * Save `/centraid/_gateway/diagnostics` through a native save dialog
   * (issue #351). Omitted → the toolbar button doesn't render (keeps this
   * screen usable standalone, e.g. in a future non-desktop host).
   */
  onExportDiagnostics?: () => Promise<
    | { ok: true; path: string }
    | { ok: false; canceled?: boolean; error?: string }
  >;
}

type StreamStatus = "connecting" | "live" | "reconnecting";

/** Client-side cap — matches the gateway ring so memory stays bounded. */
const MAX_ENTRIES = 2000;

/**
 * How many matching lines are in the DOM at once (issue #659).
 *
 * The panel holds up to {@link MAX_ENTRIES} lines and painted every one of
 * them, so a busy gateway put two thousand flex rows on screen and re-laid all
 * of them out on every arriving line — while the viewport shows perhaps forty.
 * Only the newest window is mounted; the rest are one click away rather than
 * gone, because a filtered log you cannot scroll back through is not a log.
 */
const LOG_WINDOW = 300;
const RECONNECT_MS = 2000;
/** "At the bottom" slack for the follow toggle, in px. */
const FOLLOW_SLACK = 48;

type LevelFilter = "all" | "warn" | "error";

const FILTERS: readonly { id: LevelFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "warn", label: "Warnings" },
  { id: "error", label: "Errors" },
];

function matchesFilter(entry: LogEntryDTO, filter: LevelFilter): boolean {
  if (filter === "all") return true;
  if (filter === "warn")
    return entry.level === "warn" || entry.level === "error";
  return entry.level === "error";
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The head's own word for the stream. Lower case, like every meta in the kit. */
const STATUS_WORD: Record<StreamStatus, string> = {
  connecting: "connecting…",
  live: "live",
  reconnecting: "reconnecting…",
};

export default function LogsScreen({
  streamLogs,
  focusQuery,
  onExportDiagnostics,
}: LogsBridgeProps): JSX.Element {
  const [entries, setEntries] = useState<LogEntryDTO[]>([]);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [filter, setFilter] = useState<LevelFilter>("all");
  // The search box is a controlled field whose baseline is the incoming jump
  // request: the typed value only wins while it belongs to the CURRENT nonce.
  // A fresh jump (new nonce) therefore re-applies its text even when the text
  // is unchanged, without an effect that would paint the stale value first.
  const [typed, setTyped] = useState<{
    nonce: number | undefined;
    text: string;
  } | null>(null);
  const query =
    typed !== null && typed.nonce === focusQuery?.nonce
      ? typed.text
      : (focusQuery?.text ?? "");
  const setQuery = (text: string): void =>
    setTyped({ nonce: focusQuery?.nonce, text });
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const [exportState, setExportState] = useState<
    | { kind: "idle" }
    | { kind: "pending" }
    | { kind: "done"; path: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  // The stream's resume cursor + the follow flag live in refs so the
  // long-lived stream effect never restarts on render-state changes.
  const lastSeqRef = useRef(0);
  const followRef = useRef(true);
  useEffect(() => {
    followRef.current = follow;
  }, [follow]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Guards the export flow's deferred `setExportState({kind: 'idle'})`
  // against firing after unmount (e.g. the user leaves the Logs tab right
  // after a successful export).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const onEntry = (entry: LogEntryDTO): void => {
      if (entry.seq <= lastSeqRef.current) return; // reconnect-overlap dedupe
      lastSeqRef.current = entry.seq;
      setEntries((prev) => {
        const next =
          prev.length >= MAX_ENTRIES
            ? prev.slice(prev.length - MAX_ENTRIES + 1)
            : [...prev];
        next.push(entry);
        return next;
      });
    };

    const connect = (): void => {
      if (signal.aborted) return;
      setStatus((s) => (s === "connecting" ? s : "reconnecting"));
      void streamLogs(
        (entry) => {
          // First delivered line = the stream is live.
          setStatus("live");
          onEntry(entry);
        },
        signal,
        lastSeqRef.current || undefined
      )
        .catch(() => undefined)
        .then(() => {
          if (signal.aborted) return;
          setStatus("reconnecting");
          retryTimer = setTimeout(connect, RECONNECT_MS);
        });
      // A silent-but-healthy stream (no lines yet) still counts as live.
      setStatus((s) => (s === "connecting" ? "live" : s));
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
      (e) =>
        matchesFilter(e, filter) &&
        (q === "" || e.message.toLowerCase().includes(q))
    );
  }, [entries, filter, query]);

  // Windowing (issue #659). Reading is anchored at the newest line, so the
  // window is the TAIL of the matches; asking for more grows it a page at a
  // time and a filter change starts over.
  const [windowSize, setWindowSize] = useState(LOG_WINDOW);
  const [seenWindowReset, setSeenWindowReset] = useState("");
  const windowReset = `${filter} ${query}`;
  if (seenWindowReset !== windowReset) {
    setSeenWindowReset(windowReset);
    setWindowSize(LOG_WINDOW);
  }
  const hiddenCount = Math.max(0, visible.length - windowSize);
  const windowed = useMemo(
    () => (hiddenCount > 0 ? visible.slice(-windowSize) : visible),
    [visible, windowSize, hiddenCount]
  );

  // Follow: pin the viewport to the newest line unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [windowed]);

  const onScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK;
    setFollow(atBottom);
  }, []);

  const jumpToLatest = (): void => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setFollow(true);
  };

  const copyVisible = (): void => {
    const text = visible
      .map(
        (e) =>
          `${new Date(e.ts).toISOString()} [${e.level.toUpperCase()}] ${e.message}`
      )
      .join("\n");
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const errorCount = useMemo(
    () => entries.filter((e) => e.level === "error").length,
    [entries]
  );

  const exportDiagnostics = async (): Promise<void> => {
    if (!onExportDiagnostics) return;
    setExportState({ kind: "pending" });
    try {
      const result = await onExportDiagnostics();
      if (!mountedRef.current) return;
      if (result.ok) {
        setExportState({ kind: "done", path: result.path });
        setTimeout(() => {
          if (mountedRef.current) setExportState({ kind: "idle" });
        }, 4000);
      } else if (result.canceled) {
        setExportState({ kind: "idle" });
      } else {
        setExportState({
          kind: "error",
          message: result.error ?? "Export failed.",
        });
      }
    } catch (error) {
      if (mountedRef.current) {
        setExportState({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  return (
    <div className={styles.wrap}>
      {/* Whether it is connected, how much it has, and how much of it is bad —
          the three facts the old status dot + count line carried, said in the
          head's own meta. Export is a verb about this whole stretch, so it is
          the head's quiet action rather than a fourth chip in a toolbar. */}
      <SectionBlock
        label="Logs"
        meta={`${STATUS_WORD[status]} · ${entries.length.toLocaleString()} line${
          entries.length === 1 ? "" : "s"
        }${
          errorCount > 0
            ? ` · ${errorCount} error${errorCount === 1 ? "" : "s"}`
            : ""
        }`}
        {...(onExportDiagnostics
          ? {
              action: {
                hint: "Gather this window and the component list into one file",
                label:
                  exportState.kind === "pending"
                    ? "Exporting…"
                    : "Export diagnostics",
                onClick: () => void exportDiagnostics(),
                ...(exportState.kind === "pending" ? { off: true } : {}),
              },
            }
          : {})}
      />
      <ChipsBlock
        ariaLabel="Level"
        chips={FILTERS.map((f) => ({
          id: f.id,
          label: f.label,
          on: filter === f.id,
        }))}
        onPick={(id) => setFilter(id as LevelFilter)}
      />
      {/* These act on the PANE, not on the section — a query that narrows what
          is drawn below it, and two verbs about what is drawn below it. */}
      <div className={styles.toolbar}>
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
          {copied ? "Copied" : "Copy"}
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
      {exportState.kind === "done" ? (
        <div className={styles.exportStatus} data-tone="ok">
          Saved to {exportState.path}
        </div>
      ) : exportState.kind === "error" ? (
        <div className={styles.exportStatus} data-tone="error">
          {exportState.message}
        </div>
      ) : null}

      <div className={styles.logPanel}>
        <div className={styles.logScroll} ref={scrollRef} onScroll={onScroll}>
          {hiddenCount > 0 ? (
            <button
              type="button"
              className={styles.showEarlier}
              onClick={() => setWindowSize((size) => size + LOG_WINDOW)}
            >
              {`Show ${Math.min(hiddenCount, LOG_WINDOW)} earlier lines (${hiddenCount} hidden)`}
            </button>
          ) : null}
          {visible.length === 0 ? (
            <div className={styles.empty}>
              {entries.length === 0
                ? "No log lines yet — gateway activity shows up here as it happens."
                : "No lines match the current filter."}
            </div>
          ) : (
            windowed.map((e) => (
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
          <button
            type="button"
            className={styles.jumpBtn}
            onClick={jumpToLatest}
          >
            Jump to latest
          </button>
        ) : null}
      </div>

      {/* The second sentence describes a CONTROL, so it is drawn only where
          that control is. A viewer has no export verb (GatewayScreen withholds
          `onExportDiagnostics` for a read-only seat), and a note explaining how
          to use a button that is not on the page is worse than no note: it
          reads as a control the reader has failed to find. */}
      <NoteBlock>
        The stream reads oldest first and takes a focus query, so a failing
        component can hand this page its own name.
        {onExportDiagnostics
          ? " Export diagnostics gathers this window and the component list into one file."
          : ""}
      </NoteBlock>
    </div>
  );
}
