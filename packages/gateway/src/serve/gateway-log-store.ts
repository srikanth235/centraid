/*
 * Gateway log store — the capture point behind the realtime Logs surface.
 *
 * Every gateway log line today goes straight to `console.*` via the
 * `RuntimeLogger` threaded through `buildGateway` and dies there: when
 * something goes wrong on a user's machine there is nothing the UI can
 * show. This store fixes that with the same shape as `RunEventBus`
 * (subscribe/fan-out, ephemeral) plus a bounded ring buffer so a client
 * that opens the Logs screen AFTER the interesting lines fired still
 * sees them.
 *
 * `wrap(inner)` returns a `RuntimeLogger` that tees each line into the
 * buffer + subscribers and then forwards to `inner` (the console logger
 * or a host-injected one) — console output is unchanged. Entries carry a
 * monotonic `seq` so clients resume (`?after=`) and dedupe across
 * reconnects.
 *
 * Persistence (issue #351, Tier 3 — "logs don't survive restart, exactly
 * when you want a post-mortem") is OPTIONAL: pass `{ dir }` and every
 * appended entry is also appended as one JSON line to
 * `<dir>/gateway.jsonl`, rotated at ~4 MiB with 3 generations kept
 * (`gateway.1.jsonl` … `gateway.3.jsonl`, oldest deleted). Omitting `dir`
 * is exactly today's in-memory-only behavior — tests and disposable
 * embeds construct the store with no options and see no filesystem
 * activity. Appends are `appendFileSync` — this store sees human-rate
 * traffic (boot mounts, scheduler ticks, turn lifecycle), not a hot
 * request path, so there is no batching/flush timer to reason about: a
 * crash loses at most the in-flight line. Write failures (unwritable
 * dir, full disk) are swallowed and counted (`droppedWrites`) — logging
 * must never itself crash or recurse into logging.
 *
 * Disk-full (issue #351 wave 4) gets one extra step beyond "swallow and
 * count": once `fs.appendFileSync` reports an ENOSPC/SQLITE_FULL-shaped
 * error (`isDiskFullError`), persistence stops hammering the full disk on
 * every subsequent line — `DISK_FULL_RETRY_MS` throttles retries to once
 * per window instead of once per log line — while the in-memory ring keeps
 * working exactly as before. The event also reports into
 * `sharedDiskFullTracker` so the gateway's `disk` health probe (disk-health.
 * ts) goes red with "ENOSPC observed at <time> in gateway log persistence"
 * even if a `statfs` reading catches free space between the failure and the
 * next health tick.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeLogger } from '@centraid/app-engine';
import { isDiskFullError, sharedDiskFullTracker, type DiskFullTracker } from '@centraid/vault';

export type GatewayLogLevel = 'info' | 'warn' | 'error';

export interface GatewayLogEntry {
  /** Monotonic per-process sequence — resume/dedupe cursor. */
  seq: number;
  /** Epoch ms the line was emitted. */
  ts: number;
  level: GatewayLogLevel;
  message: string;
}

export type GatewayLogListener = (entry: GatewayLogEntry, serialized: string) => void;

export interface GatewayLogStoreOptions {
  /**
   * Optional on-disk directory for rotated JSONL persistence. Omit for
   * pure in-memory operation (today's behavior). When set, the
   * directory is created lazily and the ring is seeded from the
   * persisted tail on construction, so a restart after a crash still
   * shows the pre-restart lines.
   */
  dir?: string;
  /**
   * Where disk-full events get reported (read by the gateway's `disk`
   * health probe). Defaults to the process-wide `sharedDiskFullTracker` so
   * this wires up with no caller changes — tests inject their own
   * `new DiskFullTracker()` for isolation.
   */
  diskFullTracker?: DiskFullTracker;
}

/** How long to stop retrying disk writes after an ENOSPC/SQLITE_FULL failure. */
const DISK_FULL_RETRY_MS = 30_000;

/** Ring capacity: enough to hold a session's worth of gateway chatter
 *  (boot mounts + scheduler + outbox) without unbounded growth. */
const DEFAULT_CAPACITY = 2000;

/** Rotate the current file once it reaches ~4 MiB. */
const ROTATE_BYTES = 4 * 1024 * 1024;
/** Generations kept beyond the current file: `gateway.1.jsonl` … `gateway.<N>.jsonl`. */
const MAX_ROTATED_FILES = 3;
const CURRENT_FILE_NAME = 'gateway.jsonl';

function rotatedFileName(n: number): string {
  return `gateway.${n}.jsonl`;
}

export class GatewayLogStore {
  private readonly capacity: number;
  private readonly entries: GatewayLogEntry[] = [];
  private readonly listeners = new Set<GatewayLogListener>();
  private nextSeq = 1;
  private readonly dir: string | undefined;
  private readonly currentFile: string | undefined;
  private droppedWrites = 0;
  private readonly diskFullTracker: DiskFullTracker;
  /** Epoch ms until which disk writes are suspended after an ENOSPC hit; null = writing normally. */
  private diskFullUntil: number | null = null;

  constructor(capacity: number = DEFAULT_CAPACITY, options: GatewayLogStoreOptions = {}) {
    this.capacity = Math.max(1, capacity);
    this.dir = options.dir;
    this.diskFullTracker = options.diskFullTracker ?? sharedDiskFullTracker;
    if (this.dir) {
      this.currentFile = path.join(this.dir, CURRENT_FILE_NAME);
      try {
        fs.mkdirSync(this.dir, { recursive: true });
      } catch {
        // Directory creation failed (permissions, not-a-directory, …) — every
        // subsequent append() attempt will fail the same way and count as a
        // dropped write; persistence degrades to a no-op, never a crash.
      }
      this.loadTail();
    }
  }

  /** Record one line: buffer it (evicting the oldest past capacity),
   *  persist it (best-effort, if a dir was configured), and fan it out
   *  to every live subscriber. */
  append(level: GatewayLogLevel, message: string): GatewayLogEntry {
    const entry: GatewayLogEntry = { seq: this.nextSeq++, ts: Date.now(), level, message };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    const serialized = JSON.stringify(entry);
    this.persist(serialized);
    // Snapshot: a listener may unsubscribe itself mid-fanout.
    for (const fn of Array.from(this.listeners)) {
      try {
        fn(entry, serialized);
      } catch {
        /* one wedged subscriber must not break the fanout */
      }
    }
    return entry;
  }

  /** Buffered entries with `seq > afterSeq`, oldest first. */
  snapshot(afterSeq = 0): GatewayLogEntry[] {
    if (afterSeq <= 0) return [...this.entries];
    return this.entries.filter((e) => e.seq > afterSeq);
  }

  /** Subscribe to live entries. Returns an idempotent unsubscribe. */
  subscribe(fn: GatewayLogListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Live subscriber count — used by tests. */
  subscriberCount(): number {
    return this.listeners.size;
  }

  /** Count of appends whose on-disk write failed (unwritable dir, full
   *  disk, …). Zero when no `dir` was configured. Diagnostic surface for
   *  the health/diagnostics routes, not a functional gate — the ring +
   *  live fan-out are unaffected by a persistence failure. */
  droppedWriteCount(): number {
    return this.droppedWrites;
  }

  /** True while disk writes are backed off after an ENOSPC/SQLITE_FULL hit
   *  — `persist()` skips `appendFileSync` entirely until this window elapses,
   *  so a full disk doesn't get hammered once per log line. The ring and
   *  live fan-out are unaffected either way. */
  diskFullSuspended(): boolean {
    return this.diskFullUntil !== null && Date.now() < this.diskFullUntil;
  }

  /** Tee a `RuntimeLogger`: capture into this store, then forward to
   *  `inner` so console/host output is unchanged. */
  wrap(inner: RuntimeLogger): RuntimeLogger {
    return {
      info: (m) => {
        this.append('info', m);
        inner.info(m);
      },
      warn: (m) => {
        this.append('warn', m);
        inner.warn(m);
      },
      error: (m) => {
        this.append('error', m);
        inner.error(m);
      },
    };
  }

  private persist(serialized: string): void {
    if (!this.dir || !this.currentFile) return;
    // Backed off after a disk-full hit: count the drop but don't retry the
    // write on every single line while `diskFullUntil` is still in the
    // future — the very next `append()` past that window is what "retries
    // periodically" means here (no separate timer, no extra state machine).
    if (this.diskFullUntil !== null && Date.now() < this.diskFullUntil) {
      this.droppedWrites += 1;
      return;
    }
    try {
      fs.appendFileSync(this.currentFile, `${serialized}\n`);
      this.diskFullUntil = null;
      this.rotateIfNeeded();
    } catch (err) {
      this.droppedWrites += 1;
      if (isDiskFullError(err)) {
        this.diskFullUntil = Date.now() + DISK_FULL_RETRY_MS;
        this.diskFullTracker.report(err, 'gateway log persistence');
      }
    }
  }

  /** Size-based rotation: current file exceeds `ROTATE_BYTES` → shift
   *  every generation up one slot, dropping the oldest. Best-effort —
   *  a failed rotation just means the current file keeps growing past
   *  the target size, not a crash. */
  private rotateIfNeeded(): void {
    if (!this.dir || !this.currentFile) return;
    let size: number;
    try {
      size = fs.statSync(this.currentFile).size;
    } catch {
      return;
    }
    if (size < ROTATE_BYTES) return;
    try {
      for (let n = MAX_ROTATED_FILES; n >= 2; n--) {
        const dest = path.join(this.dir, rotatedFileName(n));
        const src = path.join(this.dir, rotatedFileName(n - 1));
        try {
          fs.rmSync(dest, { force: true });
        } catch {
          /* dest may not exist yet — fine */
        }
        try {
          fs.renameSync(src, dest);
        } catch {
          /* src may not exist yet — fine */
        }
      }
      fs.renameSync(this.currentFile, path.join(this.dir, rotatedFileName(1)));
    } catch {
      this.droppedWrites += 1;
    }
  }

  /** Boot-time load: concatenate every generation oldest-to-newest, take
   *  the last `capacity` lines, and seed the ring with them so a
   *  restarted gateway's Logs page + SSE snapshot still show pre-restart
   *  lines. Entries keep their original `seq`/`ts` — `nextSeq` resumes
   *  from the highest persisted seq so post-restart entries never
   *  collide with (or duplicate) a seq a client already saw. */
  private loadTail(): void {
    if (!this.dir || !this.currentFile) return;
    const files = [
      ...Array.from({ length: MAX_ROTATED_FILES }, (_, i) =>
        path.join(this.dir as string, rotatedFileName(MAX_ROTATED_FILES - i)),
      ),
      this.currentFile,
    ];
    const lines: string[] = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        for (const line of raw.split('\n')) {
          if (line.length > 0) lines.push(line);
        }
      } catch {
        /* generation absent — fine, most gateways have fewer than MAX */
      }
    }
    const tail = lines.slice(-this.capacity);
    let maxSeq = 0;
    for (const line of tail) {
      const entry = parseLogLine(line);
      if (!entry) continue;
      this.entries.push(entry);
      if (entry.seq > maxSeq) maxSeq = entry.seq;
    }
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    if (maxSeq > 0) this.nextSeq = maxSeq + 1;
  }
}

function parseLogLine(line: string): GatewayLogEntry | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<GatewayLogEntry>;
    if (
      typeof parsed.seq === 'number' &&
      typeof parsed.ts === 'number' &&
      typeof parsed.message === 'string' &&
      (parsed.level === 'info' || parsed.level === 'warn' || parsed.level === 'error')
    ) {
      return { seq: parsed.seq, ts: parsed.ts, level: parsed.level, message: parsed.message };
    }
    return undefined;
  } catch {
    return undefined;
  }
}
