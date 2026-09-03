import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import ChipsBlock from "../ui/ChipsBlock.js";
import NoteBlock from "../ui/NoteBlock.js";
import SectionBlock from "../ui/SectionBlock.js";

import controlsCss from "../styles/controls.module.css";
import styles from "./LogsScreen.module.css";

export type LogLevelDTO = "info" | "warn" | "error";

export interface LogEntryDTO {
  seq: number;
  ts: number;
  level: LogLevelDTO;
  message: string;
}

export interface LogsBridgeProps {
  streamLogs: (
    onEntry: (entry: LogEntryDTO) => void,
    signal: AbortSignal,
    after?: number
  ) => Promise<void>;
  focusQuery?: { text: string; nonce: number };
  onExportDiagnostics?: () => Promise<
    | { ok: true; path: string }
    | { ok: false; canceled?: boolean; error?: string }
  >;
}

type StreamStatus = "connecting" | "live" | "reconnecting";

const MAX_ENTRIES = 2000;

const LOG_WINDOW = 300;
const RECONNECT_MS = 2000;
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

  const lastSeqRef = useRef(0);
  const followRef = useRef(true);
  useEffect(() => {
    followRef.current = follow;
  }, [follow]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
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
      {/* Status, count, and errors in the section head. Export is the head's quiet action. */}
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
      {/* Search/copy/clear act on the pane, not on the section. */}
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

      {/* Second sentence describes a CONTROL — draw it only where that control is. */}
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
