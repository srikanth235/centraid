// governance: allow-repo-hygiene file-size-limit (#408) the WAL capture loop is one correctness argument — detectors, capture, rollover, generation lifecycle and crash-ordering rules all lean on each other's invariants; splitting them would scatter the proof across files that only ever change together
/*
 * In-process WAL segment shipper (#408): each tick copies the committed
 * byte-delta of `vault.db-wal` into local segment files, which the gateway's
 * uploader seals and drains (`@centraid/backup` wal-format owns the object
 * format).
 *
 * ONE FILE (#916): the audit and ledger bands live in `vault.db`, so there is
 * one stream, one generation and one base — and no cross-database instant to
 * coordinate. What used to be the pair's whole argument (cut the journal
 * first, re-base both together, seal a pair marker) is now a property of the
 * file: a receipt and the row it names commit in ONE transaction, so no cut
 * can separate them.
 *
 * Two invariants carry the correctness argument. I1 — the gateway's
 * synchronous command pipeline is the only IN-PROCESS writer (app-engine
 * workers and the key-admin CLI write out of process; tolerated below). I2 —
 * nobody checkpoints but this shipper, always TRUNCATE, so the WAL is
 * append-only between our checkpoints and offsets are never reused within a
 * group.
 *
 * I2 is VERIFIED, NOT ENFORCED (#411 action 1): every capture re-checks WAL
 * salts, the offset chain and main-file identity, and ANY foreign checkpoint
 * breaks the generation — a fresh base, never a silent gap. Correctness
 * therefore does not rest on the `wal_autocheckpoint = 0` convention, which
 * only keeps churn near zero. Keep every path here SYNCHRONOUS: the guarantee
 * that no gateway write interleaves is event-loop atomicity over a synchronous
 * `node:sqlite`, so one `await` destroys it with every test still green.
 *
 * The subprocess writers make two defenses load-bearing: segments end on
 * COMMIT boundaries (`lastCommitBoundary`), and every TRUNCATE is bracketed by
 * a `PRAGMA data_version` reading (`settleWal` + `truncate`) — see those
 * functions for why.
 *
 * Crash ordering (G7): segment fsync happens BEFORE the state-file offset
 * fsync, so a crash between them re-captures from the same start (which is why
 * the object nonce includes the end offset) and duplicate uploads stay
 * prefix-compatible. A hole is unreachable: `offset` never passes bytes that
 * are not durably in a local segment, and nothing checkpoints bytes that are
 * not durably at or behind `offset`.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  newWalGeneration,
  parseWalCloserKey,
  parseWalSegmentKey,
  WAL_DB_FILES,
  walGroupCloserKey,
  WAL_HEADER_BYTES,
  scanWalPrefix,
  walSalts,
  walSegmentKey,
  walTickMarkerKey,
} from "@centraid/backup";
import type {
  WalGroupCloser,
  WalSegmentAddress,
  WalStreamPosition,
  WalTickMarker,
} from "@centraid/backup";

import type { VaultDb } from "./db.js";
import { sha256File } from "./gateway/custody.js";
import { writeReceipt } from "./gateway/evidence.js";

export interface WalShipperLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface WalShipperOptions {
  db: VaultDb;
  /** Defaults to `<vaultDir>/wal-ship`. */
  dir?: string;
  /** WAL size that triggers a group rollover (checkpoint). Default 16 MiB. */
  walSizeThresholdBytes?: number | (() => number);
  /** Base-snapshot cadence (generation roll). Default 24 h. */
  baseIntervalMs?: number | (() => number);
  /** Local segment-dir budget while offline. Default 2 GiB. */
  localBudgetBytes?: number;
  now?: () => number;
  random?: (n: number) => Uint8Array;
  log?: WalShipperLogger;
}

interface DbStreamState {
  generation: string;
  group: number;
  /** Bytes of the current group durably captured into local segments. */
  offset: number;
  /** Last observed WAL file size — the shrink detector's memory. */
  lastSize: number;
  /** The current group's WAL salts once observed (header ≥ 32 bytes). */
  salt1: number | null;
  salt2: number | null;
  /** The database's WAL page size once observed (fixed per file). */
  pageSize: number | null;
  /** Main-db identity after our last checkpoint. It MUST NOT change between
   *  our checkpoints — a change means a foreign checkpoint backfilled frames
   *  we may never have seen. */
  dbSize: number;
  dbMtimeMs: number;
  /** Hash of SQLite's 100-byte header: catches a foreign checkpoint even
   *  where coarse mtime and a stable size hide it. */
  dbHeaderSha256: string;
  /** Relative path of the pinned base clone for this generation. */
  baseName: string;
  /**
   * The SUPERSEDED generation's base clone, kept one break longer: the
   * snapshot engine may still be streaming it when a roll lands mid-run, and
   * deleting it now would ENOENT a running backup.
   */
  retiredBaseName?: string;
  baseCreatedAtMs: number;
  /** SHA-256 of the base clone; computed at roll time, not lazily. */
  baseSha256: string;
  /** True until the gateway registers a snapshot anchoring this base. */
  basePending: boolean;
  /** Set by `close()` after a final ship+truncate; cleared on next start. */
  closedClean: boolean;
  /**
   * Captured files were deleted without upload (backup unconfigured). The
   * stream has holes, so the moment a backend appears it MUST break to a fresh
   * generation BEFORE its stale base is registered — a restore of a holed
   * stream silently lands on the old base. Persisted: the transition can span
   * restarts.
   */
  discarded?: boolean;
  /**
   * A break that could not complete (the checkpoint came back busy). The stream
   * is FROZEN until it lands: nothing captures, rolls, or ships. Persisted —
   * otherwise the next boot resumes a stream whose base was never re-cloned.
   */
  breakPending?: string;
}

type CaptureResult =
  | { kind: "ok" }
  | { kind: "error" }
  | { kind: "break"; reason: string };

type SettleResult =
  | { kind: "ready"; dataVersion: number }
  | { kind: "retry" }
  | { kind: "break"; reason: string };

interface TruncateResult {
  raced: boolean;
  untrustedReason?: string;
}

interface ShipperState {
  version: 1;
  /** Monotonicized tick clock — survives restarts and wall-clock rewinds. */
  lastTickMs: number;
  /** The one stream. Absent before the first-run base is minted. */
  stream?: DbStreamState;
  /**
   * Foreign checkpoints detected and healed across ALL generations (#411
   * action 1; see `FOREIGN_CHECKPOINT_REASONS`). TOP-LEVEL, not inside the
   * stream record: a break REPLACES that record (`mintBase`), so a counter
   * living in it would reset on the very event it counts.
   */
  foreignCheckpointCount?: number;
  /** The most recent foreign checkpoint: when (tick ms) and the break reason —
   *  drives the gateway's degraded window. */
  lastForeignCheckpoint?: { atMs: number; reason: string };
}

/**
 * Break reasons meaning SOMETHING ELSE checkpointed one of our databases —
 * salts jumped, offsets were reused, or frames were folded into the main file
 * unobserved. Their whole cost is a base re-clone, i.e. churn, not a
 * correctness threat; they feed `ShipperState.foreignCheckpointCount` (#411).
 *
 * DELIBERATELY EXCLUDED, each for its own reason: `first-run`/`base-cadence`/
 * `local-budget`/`key-epoch-rotation`/`journal-archival`/
 * `backup-enabled-after-discard` are OUR OWN re-bases;
 * `checkpoint-raced-writer` is a foreign WRITER inside OUR checkpoint's lock
 * window, not a foreign checkpointer; `wal-exceeds-safe-capture-window` is an
 * oversized transaction we chose to re-base past; and
 * `wal-checksum-invalid-before-captured-offset` is corruption of ambiguous
 * cause.
 */
const FOREIGN_CHECKPOINT_REASONS: ReadonlySet<string> = new Set([
  "main-db-file-changed-without-our-checkpoint",
  "wal-file-vanished",
  "wal-shrank-without-our-checkpoint",
  "wal-salts-changed-without-our-checkpoint",
  "wal-reset-during-capture",
]);

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isStreamState(value: unknown): value is DbStreamState {
  if (typeof value !== "object" || value === null) return false;
  const stream = value as Record<string, unknown>;
  if (
    typeof stream["generation"] !== "string" ||
    !/^[0-9a-f]{32}$/u.test(stream["generation"])
  ) {
    return false;
  }
  const generation = stream["generation"];
  if (stream["baseName"] !== `bases/${generation}.db`) return false;
  if (
    stream["retiredBaseName"] !== undefined &&
    (typeof stream["retiredBaseName"] !== "string" ||
      !/^bases\/[0-9a-f]{32}\.db$/u.test(stream["retiredBaseName"]))
  ) {
    return false;
  }
  if (
    !isNonNegativeInteger(stream["group"]) ||
    !isNonNegativeInteger(stream["offset"]) ||
    !isNonNegativeInteger(stream["lastSize"]) ||
    !isNonNegativeInteger(stream["dbSize"]) ||
    !isNonNegativeInteger(stream["baseCreatedAtMs"])
  ) {
    return false;
  }
  if (
    (stream["salt1"] !== null && !isNonNegativeInteger(stream["salt1"])) ||
    (stream["salt2"] !== null && !isNonNegativeInteger(stream["salt2"])) ||
    (stream["pageSize"] !== null && !isNonNegativeInteger(stream["pageSize"]))
  ) {
    return false;
  }
  if (
    typeof stream["dbMtimeMs"] !== "number" ||
    !Number.isFinite(stream["dbMtimeMs"])
  )
    return false;
  if (
    typeof stream["dbHeaderSha256"] !== "string" ||
    !/^[0-9a-f]{64}$/u.test(stream["dbHeaderSha256"])
  ) {
    return false;
  }
  if (
    typeof stream["baseSha256"] !== "string" ||
    !/^[0-9a-f]{64}$/u.test(stream["baseSha256"])
  ) {
    return false;
  }
  if (
    typeof stream["basePending"] !== "boolean" ||
    typeof stream["closedClean"] !== "boolean"
  ) {
    return false;
  }
  if (
    stream["discarded"] !== undefined &&
    typeof stream["discarded"] !== "boolean"
  )
    return false;
  if (
    stream["breakPending"] !== undefined &&
    typeof stream["breakPending"] !== "string"
  )
    return false;
  return true;
}

function isShipperState(value: unknown): value is ShipperState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  if (state["version"] !== 1 || !isNonNegativeInteger(state["lastTickMs"]))
    return false;
  if (state["stream"] !== undefined && !isStreamState(state["stream"]))
    return false;
  // Optional fields, absent on pre-#411 state files: tolerate absence but
  // reject a malformed shape.
  if (
    state["foreignCheckpointCount"] !== undefined &&
    !isNonNegativeInteger(state["foreignCheckpointCount"])
  ) {
    return false;
  }
  if (state["lastForeignCheckpoint"] !== undefined) {
    const lfc = state["lastForeignCheckpoint"];
    if (typeof lfc !== "object" || lfc === null) return false;
    const rec = lfc as Record<string, unknown>;
    if (!isNonNegativeInteger(rec["atMs"]) || typeof rec["reason"] !== "string")
      return false;
  }
  return true;
}

export interface WalTickReport {
  tickMs: number;
  /** Object keys of segments captured this tick (local, durable). */
  shipped: string[];
  /** Groups closed this tick (rollover checkpoints). */
  rolled: { group: number; endOffset: number }[];
  /** Generation breaks with their reasons (fresh base minted). */
  breaks: { reason: string }[];
  /** Tick-marker object keys written this tick (at most one). */
  markers: string[];
  /** The checkpoint returned busy and is retried next tick. */
  busy: boolean;
  errors: { message: string }[];
}

export interface UploadableWalFile {
  /** Absolute path of the local plaintext file. */
  file: string;
  /** The object key it seals to. */
  key: string;
  kind: "segment" | "closer" | "marker";
  addr?: WalSegmentAddress;
  closer?: WalGroupCloser;
  marker?: WalTickMarker;
  bytes: number;
}

export interface PendingBase {
  generation: string;
  file: string;
  sha256: string;
  createdAtMs: number;
}

const DEFAULT_THRESHOLD = 16 * 1024 * 1024;
const DEFAULT_BASE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOCAL_BUDGET = 2 * 1024 * 1024 * 1024;
/** Max ms a checkpoint may block the (synchronous) tick on a busy reader. */
const CHECKPOINT_BUSY_MS = 250;
/** A single oversized transaction must not make capture an unbounded
 * allocation. Re-basing keeps its committed state, sacrificing only the PITR
 * points inside that exceptional WAL era. */
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
/**
 * Max passes `settleWal` chases a writer before giving up and leaving the WAL
 * untruncated this tick. A normal writer settles in one or two; one that
 * outruns eight is better retried than checkpointed under.
 */
const TRUNCATE_SETTLE_PASSES = 8;
const noopLog: Required<WalShipperLogger> = {
  info: () => undefined,
  warn: () => undefined,
};
/** Reflink support is a filesystem property; remember failed probes per device pair. */
const reflinkCapability = new Map<string, boolean>();

function reflinkDeviceKey(src: string, dst: string): string {
  return `${process.platform}:${statSync(src).dev}:${statSync(path.dirname(dst)).dev}`;
}

/**
 * Copy-on-write clone of a database file — the base of a new generation.
 *
 * This MUST be a reflink wherever the filesystem offers one, or the cost story
 * collapses: a base is minted at least daily, so a byte copy writes a second
 * full vault every day and carries 2x on disk forever.
 *
 * `copyFileSync(..., COPYFILE_FICLONE)` does NOT deliver that on macOS — libuv
 * implements FICLONE via ioctl on Linux only, and Darwin silently falls back to
 * a byte copy. Measured on APFS at 512 MiB: FICLONE 497 ms and a real second
 * copy, `cp -c` (clonefile(2)) 2 ms and no new blocks. So Darwin asks for
 * clonefile(2) explicitly; it fails on non-APFS or across devices, which is
 * exactly when a byte copy is the only option. `execFileSync` keeps the tick
 * synchronous — the cross-database ordering guarantee rests on this whole path
 * being one event-loop turn.
 */
export function cloneDbFile(src: string, dst: string): boolean {
  const capabilityKey = reflinkDeviceKey(src, dst);
  if (process.platform === "darwin") {
    if (reflinkCapability.get(capabilityKey) !== false) {
      try {
        execFileSync("/bin/cp", ["-c", src, dst], { stdio: "ignore" });
        reflinkCapability.set(capabilityKey, true);
        return true;
      } catch {
        reflinkCapability.set(capabilityKey, false);
        // Not a clone-capable volume — the byte copy below is the real fallback.
      }
    }
  }
  if (process.platform === "linux") {
    if (reflinkCapability.get(capabilityKey) !== false) {
      try {
        copyFileSync(src, dst, fsConstants.COPYFILE_FICLONE_FORCE);
        reflinkCapability.set(capabilityKey, true);
        return true;
      } catch {
        reflinkCapability.set(capabilityKey, false);
        // ext4 and other non-reflink filesystems take the explicit byte-copy fallback.
      }
    }
  }
  copyFileSync(src, dst);
  return false;
}

function fsyncDirBestEffort(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is not portable; the file fsyncs are the load-bearing
    // ones and this only narrows the rename-durability window.
  }
}

function writeFileDurable(file: string, data: Uint8Array): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const fd = openSync(file, "w");
  try {
    let at = 0;
    while (at < data.length) at += writeSync(fd, data, at, data.length - at);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirBestEffort(path.dirname(file));
}

export class WalShipper {
  private readonly db: VaultDb;
  private readonly dir: string;
  private readonly stateFile: string;
  private readonly threshold: () => number;
  private readonly baseIntervalMs: () => number;
  private readonly localBudgetBytes: number;
  private readonly now: () => number;
  private readonly random: (n: number) => Uint8Array;
  private readonly log: Required<WalShipperLogger>;
  private state: ShipperState;
  private stateRecovered = false;
  private closed = false;
  /**
   * Running total of local segment bytes: seeded by one walk at construction,
   * then maintained incrementally. The shipper is this tree's only writer and
   * deleter, so the counter is exact — it replaces a per-tick readdir+stat walk
   * that grew with the offline backlog the budget exists to handle.
   */
  private localSegmentBytes = 0;
  private warnedPlainClone = false;

  constructor(opts: WalShipperOptions) {
    if (opts.db.dir === ":memory:") {
      throw new Error("WalShipper needs a file-backed vault");
    }
    this.db = opts.db;
    this.dir = opts.dir ?? path.join(opts.db.dir, "wal-ship");
    this.stateFile = path.join(this.dir, "state.json");
    const threshold = opts.walSizeThresholdBytes;
    this.threshold =
      typeof threshold === "function"
        ? threshold
        : () => threshold ?? DEFAULT_THRESHOLD;
    const baseIntervalMs = opts.baseIntervalMs;
    this.baseIntervalMs =
      typeof baseIntervalMs === "function"
        ? baseIntervalMs
        : () => baseIntervalMs ?? DEFAULT_BASE_INTERVAL_MS;
    this.localBudgetBytes = opts.localBudgetBytes ?? DEFAULT_LOCAL_BUDGET;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? ((n) => new Uint8Array(randomBytes(n)));
    this.log = { ...noopLog, ...opts.log };
    mkdirSync(this.dir, { recursive: true });
    this.state = this.loadState();
    this.startupHygiene();
    this.localSegmentBytes = this.walkSegmentBytes(
      path.join(this.dir, "segments")
    );
  }

  private walkSegmentBytes(dir: string): number {
    if (!existsSync(dir)) return 0;
    let total = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      total += entry.isDirectory()
        ? this.walkSegmentBytes(full)
        : statSync(full).size;
    }
    return total;
  }

  // ──────────────────────────────────────────────────────────────────── state

  private loadState(): ShipperState {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.stateFile, "utf8"));
      if (isShipperState(parsed)) {
        this.stateRecovered = true;
        return parsed;
      }
    } catch {
      /* fresh or unreadable — start over via generation init */
    }
    return { version: 1, lastTickMs: 0 };
  }

  /** Durable state write — G7 step 2 (always AFTER the segment fsync). */
  private persistState(): void {
    const tmp = `${this.stateFile}.tmp`;
    try {
      writeFileDurable(
        tmp,
        new TextEncoder().encode(`${JSON.stringify(this.state, null, 2)}\n`)
      );
      renameSync(tmp, this.stateFile);
    } catch (error) {
      // A partial tmp on a full disk must not linger (it would accumulate
      // per tick); the state file itself is still the last good version.
      rmSync(tmp, { force: true });
      throw error;
    }
    fsyncDirBestEffort(this.dir);
  }

  /**
   * Startup hygiene: local segments ending BEYOND the persisted offset are
   * un-acknowledged rewrites from a crash between segment-fsync and
   * state-fsync. Their bytes are still in the WAL (nothing checkpointed past
   * `offset`), so the next tick re-captures them. Deleting the strays only
   * bounds duplicate uploads — hygiene, not correctness.
   */
  private startupHygiene(): void {
    if (!this.stateRecovered) {
      // Without authenticated offsets/generations no orphan segment chains
      // safely. Drop the whole unreferenced spool so the first-run base starts
      // clean instead of triggering a generation roll on every budget check.
      rmSync(path.join(this.dir, "segments"), { recursive: true, force: true });
      rmSync(path.join(this.dir, "markers"), { recursive: true, force: true });
      rmSync(path.join(this.dir, "bases"), { recursive: true, force: true });
      return;
    }
    const stream = this.state.stream;
    if (!stream) return;
    const groupDir = this.groupDir(stream.generation, stream.group);
    if (!existsSync(groupDir)) return;
    for (const name of readdirSync(groupDir)) {
      const addr = this.parseSegmentFileName(
        stream.generation,
        stream.group,
        name
      );
      if (addr && addr.endOffset > stream.offset) {
        rmSync(path.join(groupDir, name), { force: true });
        this.log.warn(
          `wal-ship: dropped unacknowledged segment ${name} (crash residue)`
        );
      }
    }
  }

  /**
   * Local filenames are the object key's basename plus an extension (see
   * `capture`), so parsing delegates to the ONE codec in wal-format — a format
   * change can never desync the builder from these parsers.
   */
  private parseSegmentFileName(
    generation: string,
    group: number,
    name: string
  ): WalSegmentAddress | null {
    if (!name.endsWith(".seg")) return null;
    return parseWalSegmentKey(
      `wal/vault/${generation}/${String(group).padStart(8, "0")}/${name.slice(0, -4)}`
    );
  }

  // ──────────────────────────────────────────────────────────────────── paths

  private walPath(): string {
    return path.join(this.db.dir, `${WAL_DB_FILES.vault}-wal`);
  }

  private dbPath(): string {
    return path.join(this.db.dir, WAL_DB_FILES.vault);
  }

  private dbHeaderSha256(): string {
    const fd = openSync(this.dbPath(), "r");
    try {
      const header = Buffer.alloc(100);
      const bytes = readSync(fd, header, 0, header.length, 0);
      return createHash("sha256")
        .update(header.subarray(0, bytes))
        .digest("hex");
    } finally {
      closeSync(fd);
    }
  }

  private groupDir(generation: string, group: number): string {
    return path.join(
      this.dir,
      "segments",
      generation,
      String(group).padStart(8, "0")
    );
  }

  private basePath(baseName: string): string {
    return path.join(this.dir, baseName);
  }

  /** `markers/{generation}/` — one dir per base. */
  private markerDir(generation: string): string {
    return path.join(this.dir, "markers", generation);
  }

  // ────────────────────────────────────────────────────────────────── ticking

  private nextTickMs(): number {
    const t = Math.max(this.now(), this.state.lastTickMs + 1);
    this.state.lastTickMs = t;
    return t;
  }

  private newReport(): WalTickReport {
    // ONE `nextTickMs()` per pass: a marker naming a different tick than the
    // segments it describes would be unsatisfiable forever.
    return {
      tickMs: this.nextTickMs(),
      shipped: [],
      rolled: [],
      breaks: [],
      markers: [],
      busy: false,
      errors: [],
    };
  }

  /**
   * One capture pass, four phases: (1) decide whether the stream must break,
   * BEFORE a byte ships under a condemned generation; (2) capture, with the
   * cadence/rollover checks (which may REQUEST a break); (3) the break if one
   * was asked for; (4) the end-of-tick marker.
   *
   * Synchronous end to end, and it must stay that way: the guarantee that no
   * gateway write lands inside a cut is event-loop atomicity over a synchronous
   * `node:sqlite` (I1), not a lock. One `await` anywhere destroys it, and no
   * test would fail.
   */
  tick(): WalTickReport {
    if (this.closed) throw new Error("WalShipper is closed");
    const report = this.newReport();
    let reason = this.resolveBreakReason();

    if (reason === undefined) {
      const stream = this.state.stream!;
      try {
        const captured = this.capture(stream, report);
        if (captured.kind === "break") reason = captured.reason;
        else if (captured.kind === "ok") {
          // A generation roll IS the base snapshot.
          if (report.tickMs - stream.baseCreatedAtMs >= this.baseIntervalMs()) {
            reason = "base-cadence";
          } else if (stream.lastSize > this.threshold()) {
            // Group rollover bounds the WAL, segment sizes and restart
            // recovery. Local-only, never network-coupled (G4); one that
            // catches a racing writer requests a break of its own.
            reason = this.rollover(stream, report);
          }
        }
      } catch (error) {
        report.errors.push({
          message: error instanceof Error ? error.message : String(error),
        });
        this.log.warn(
          `wal-ship: tick failed: ${report.errors.at(-1)!.message}`
        );
      }
    }

    if (reason !== undefined) this.breakGeneration(reason, report);
    this.enforceLocalBudget(report);
    this.writeTickMarker(report);
    this.persistState();
    return report;
  }

  /**
   * Phase 1: must the stream break, and why. Nothing ships, nothing
   * checkpoints — a stream whose detector fired must not ship another byte
   * under its current generation, and one with a deferred break must not ship
   * at all until that break lands.
   */
  private resolveBreakReason(): string | undefined {
    const stream = this.state.stream;
    if (!stream) return "first-run";
    if (stream.breakPending !== undefined) return stream.breakPending;
    if (stream.closedClean) {
      // Clean shutdown left the WAL empty, so whatever exists now is a fresh
      // WAL for the already-advanced group.
      stream.closedClean = false;
      stream.salt1 = null;
      stream.salt2 = null;
      stream.lastSize = 0;
    }
    // G5 detectors — evaluated BEFORE anything ships under this generation.
    return this.detectForeign(stream) ?? undefined;
  }

  /** Returns a break reason, or null when the stream is intact. */
  private detectForeign(stream: DbStreamState): string | null {
    // Between OUR checkpoints every write goes to the WAL, so the main file
    // must be byte-stable. A change means someone else checkpointed frames we
    // may never have observed — unrecoverable for this stream, catchable no
    // other way.
    const dbStat = statSync(this.dbPath());
    if (
      dbStat.size !== stream.dbSize ||
      dbStat.mtimeMs !== stream.dbMtimeMs ||
      this.dbHeaderSha256() !== stream.dbHeaderSha256
    ) {
      return "main-db-file-changed-without-our-checkpoint";
    }
    const walPath = this.walPath();
    if (!existsSync(walPath)) {
      return stream.offset > 0 || stream.lastSize > 0
        ? "wal-file-vanished"
        : null;
    }
    const size = statSync(walPath).size;
    if (size < stream.lastSize) return "wal-shrank-without-our-checkpoint";
    if (size >= WAL_HEADER_BYTES && stream.salt1 !== null) {
      const header = this.readWalRange(0, WAL_HEADER_BYTES);
      const salts = walSalts(header);
      if (salts.salt1 !== stream.salt1 || salts.salt2 !== stream.salt2) {
        return "wal-salts-changed-without-our-checkpoint";
      }
    }
    return null;
  }

  private readWalRange(start: number, end: number): Uint8Array {
    const fd = openSync(this.walPath(), "r");
    try {
      const buf = Buffer.alloc(end - start);
      let at = 0;
      while (at < buf.length) {
        const n = readSync(fd, buf, at, buf.length - at, start + at);
        if (n === 0) throw new Error(`wal read truncated at ${start + at}`);
        at += n;
      }
      return new Uint8Array(buf);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * A micro read-lock over the byte copy (#411 action 2) — belt-and-suspenders
   * to `capture`'s after-the-fact detection, NEVER a replacement for it. A
   * foreign checkpointer (the vault is multi-process: app-engine workers, the
   * key-admin CLI) could RESTART or TRUNCATE the WAL mid-copy; an open WAL read
   * snapshot holds a read mark no checkpointer in any process can reset past,
   * so a foreign TRUNCATE returns busy and leaves bytes and salts untouched.
   *
   * A SEPARATE read-only connection, deliberately not the gateway's shared
   * write handle: a `readOnly` connection cannot checkpoint and writes NOTHING
   * on open or close (verified — `data_version` is unmoved), and an exception
   * here can never strand the write handle inside a transaction. The lock lives
   * only for the copy and MUST be released before the shipper's own `truncate`,
   * or that TRUNCATE finds our reader and comes back busy; `capture`'s finally
   * always releases first.
   *
   * Acquisition failure is not fatal: return null and copy WITHOUT the pin —
   * post-copy detection is the correctness mechanism.
   */
  private acquireWalReadLock(): { release: () => void } | null {
    let conn: DatabaseSync | undefined;
    try {
      conn = new DatabaseSync(this.dbPath(), { readOnly: true });
      // `BEGIN` is DEFERRED and takes no read mark until a read runs; the
      // SELECT is what materializes the snapshot and grabs the WAL read mark.
      conn.exec("BEGIN");
      conn.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get();
      const held = conn;
      return {
        release: () => {
          // The snapshot ends at close anyway; ending the transaction first
          // drops the read mark immediately.
          try {
            held.exec("ROLLBACK");
          } catch {
            /* connection may already be gone — close still frees the mark */
          }
          try {
            held.close();
          } catch {
            /* best-effort: a leaked read-only handle holds no write lock */
          }
        },
      };
    } catch (error) {
      try {
        conn?.close();
      } catch {
        /* nothing was acquired */
      }
      this.log.warn(
        `wal-ship: capture read-lock unavailable ` +
          `(${error instanceof Error ? error.message : String(error)}) — ` +
          `relying on post-copy race detection`
      );
      return null;
    }
  }

  /**
   * Capture the committed delta `[offset, lastCommitBoundary(head))` into a
   * local segment. G7 ordering: segment bytes fsync, then state fsync, so after
   * this returns `offset` only ever names durably-captured bytes.
   */
  private capture(stream: DbStreamState, report: WalTickReport): CaptureResult {
    const walPath = this.walPath();
    if (!existsSync(walPath)) return { kind: "ok" };
    const fd = openSync(walPath, "r");
    let bytes: Buffer;
    let head: number;
    let headerStable = true;
    // Pinned across the byte copy only (see `acquireWalReadLock`), released in
    // the finally so it is never held during the caller's TRUNCATE.
    let readLock: { release: () => void } | null = null;
    try {
      head = fstatSync(fd).size;
      stream.lastSize = Math.max(stream.lastSize, head);
      if (head < WAL_HEADER_BYTES) return { kind: "ok" };
      if (head > MAX_CAPTURE_BYTES) {
        return { kind: "break", reason: "wal-exceeds-safe-capture-window" };
      }
      // Acquire the read mark after the size checks and before the FIRST byte
      // read. A reset in the sliver before this is still caught by the
      // re-stat/header compare below; the pin closes the far larger window of
      // the multi-syscall copy.
      readLock = this.acquireWalReadLock();
      bytes = Buffer.alloc(head);
      let at = 0;
      while (at < head) {
        const n = readSync(fd, bytes, at, head - at, at);
        if (n === 0)
          return { kind: "break", reason: "wal-reset-during-capture" };
        at += n;
      }
      const after = fstatSync(fd).size;
      if (after < head)
        return { kind: "break", reason: "wal-reset-during-capture" };
      const headerAfter = Buffer.alloc(WAL_HEADER_BYTES);
      if (
        readSync(fd, headerAfter, 0, WAL_HEADER_BYTES, 0) !== WAL_HEADER_BYTES
      ) {
        return { kind: "break", reason: "wal-reset-during-capture" };
      }
      headerStable = bytes.subarray(0, WAL_HEADER_BYTES).equals(headerAfter);
    } finally {
      closeSync(fd);
      readLock?.release();
    }
    if (!headerStable)
      return { kind: "break", reason: "wal-reset-during-capture" };

    let scan;
    try {
      scan = scanWalPrefix(bytes);
    } catch {
      return {
        kind: "break",
        reason: "wal-checksum-invalid-before-captured-offset",
      };
    }
    if (scan.validEndOffset < stream.offset) {
      return {
        kind: "break",
        reason: "wal-checksum-invalid-before-captured-offset",
      };
    }
    const header = bytes.subarray(0, WAL_HEADER_BYTES);
    const salts = walSalts(header);
    if (
      stream.salt1 !== null &&
      (salts.salt1 !== stream.salt1 || salts.salt2 !== stream.salt2)
    ) {
      return { kind: "break", reason: "wal-reset-during-capture" };
    }
    stream.salt1 = salts.salt1;
    stream.salt2 = salts.salt2;
    stream.pageSize ??= scan.pageSize;
    const boundary = scan.lastCommitOffset;
    if (boundary <= stream.offset) return { kind: "ok" };

    const addr: WalSegmentAddress = {
      db: "vault",
      generation: stream.generation,
      group: stream.group,
      startOffset: stream.offset,
      endOffset: boundary,
      tickMs: report.tickMs,
    };
    // The local filename IS the object key's basename plus an extension: one
    // codec (wal-format) owns widths and field order, so the builder and the
    // parsers in listUploadable/startupHygiene can never drift.
    const file = path.join(
      this.groupDir(stream.generation, stream.group),
      `${path.posix.basename(walSegmentKey(addr))}.seg`
    );
    try {
      writeFileDurable(file, bytes.subarray(stream.offset, boundary));
    } catch (error) {
      // G4: the segment did not become durable, so the offset must not move
      // and NOTHING may checkpoint — the failure surfaces as backpressure.
      report.errors.push({
        message: `segment write failed (${error instanceof Error ? error.message : String(error)}) — WAL retained`,
      });
      return { kind: "error" };
    }
    this.localSegmentBytes += boundary - stream.offset;
    stream.offset = boundary;
    report.shipped.push(walSegmentKey(addr));
    return { kind: "ok" };
  }

  /**
   * `PRAGMA data_version` bumps when a connection OTHER than the one queried
   * commits, and never for the querying connection's own writes — which is what
   * makes it the raced-writer detector. All three properties were MEASURED on
   * this runtime before being relied on: stable across our own
   * `wal_checkpoint(TRUNCATE)` (else every rollover would force a re-base),
   * stable across our own writes (the shipper checkpoints on the handles the
   * gateway writes through), and bumped by another connection or process — the
   * only writers we cannot see any other way.
   */
  private dataVersion(): number {
    const row = this.db.vault.prepare("PRAGMA data_version").get() as {
      data_version: number;
    };
    return row.data_version;
  }

  /**
   * Bring `stream.offset` up to everything COMMITTED, and return the
   * `data_version` reading the following TRUNCATE must be checked against. Null
   * means DO NOT TRUNCATE (retry next tick).
   *
   * THE ORDER OF THE TWO READS INSIDE THE LOOP IS THE WHOLE CORRECTNESS
   * ARGUMENT and is the easy thing to get backwards. `data_version` is read
   * FIRST, the WAL stat'd SECOND: a commit landing before the reading makes the
   * file longer than `offset`, so the stat sees it; a commit landing after it is
   * not in the reading, so the post-checkpoint reading differs and the fold is
   * DETECTED. Stat first and there is a window where a commit is invisible to
   * the stat AND already baked into the reading — folded into the main
   * database, zeroed from the WAL, never shipped, never noticed. Do not
   * "simplify" the order back.
   *
   * The loop is only an optimization. When capture stops making progress the
   * WAL's tail is UNCOMMITTED — a rolled-back transaction leaves frames behind
   * and the file's high-water size legitimately outruns `offset` forever — so
   * there is nothing left to ship and truncating destroys nothing.
   */
  private settleWal(
    stream: DbStreamState,
    report: WalTickReport
  ): SettleResult {
    const walPath = this.walPath();
    for (let pass = 0; pass < TRUNCATE_SETTLE_PASSES; pass++) {
      const dvBefore = this.dataVersion(); // BEFORE the stat — see above.
      const foreign = this.detectForeign(stream);
      if (foreign) return { kind: "break", reason: foreign };
      const size = existsSync(walPath) ? statSync(walPath).size : 0;
      if (size <= stream.offset)
        return { kind: "ready", dataVersion: dvBefore };
      const offsetBefore = stream.offset;
      const captured = this.capture(stream, report);
      if (captured.kind === "error") return { kind: "retry" };
      if (captured.kind === "break") return captured;
      if (stream.offset === offsetBefore)
        return { kind: "ready", dataVersion: dvBefore };
    }
    // A writer is committing faster than we capture. Leaving the WAL
    // untruncated is merely wasteful; truncating without a settled stat could
    // fold away committed bytes we never shipped, which is unrecoverable.
    this.log.warn(
      "wal-ship: WAL will not settle for a checkpoint — retrying next tick"
    );
    return { kind: "retry" };
  }

  /**
   * `wal_checkpoint(TRUNCATE)` with a bounded busy wait, bracketed by a
   * `data_version` reading. Null means the handle was busy (nothing truncated,
   * retry next tick); otherwise, whether a foreign connection committed inside
   * the window. `dvBefore` MUST have been read by the caller BEFORE the
   * evidence that the WAL holds nothing past `stream.offset` (see `settleWal`).
   *
   * Two alternatives are NOT usable, both measured rather than assumed. The
   * checkpoint's own `checkpointed` frame count: a successful TRUNCATE returns
   * `{busy: 0, log: 0, checkpointed: 0}` because it resets the counters, so
   * comparing it against what we shipped is dead code that looks like a hole
   * check. And a `wal_checkpoint(FULL)`/`(PASSIVE)` pre-pass to learn the frame
   * count: once FULL has backfilled, the next writer RESTARTS the WAL at offset
   * 0 and overwrites bytes IN PLACE without the file even growing, destroying
   * the append-only offset chain every segment address is built on.
   */
  private truncate(dvBefore: number): TruncateResult | null {
    const handle = this.db.vault;
    const stream = this.state.stream;
    const preflightReason = stream
      ? (this.detectForeign(stream) ?? undefined)
      : undefined;
    handle.exec(`PRAGMA busy_timeout = ${CHECKPOINT_BUSY_MS}`);
    try {
      const row = handle.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
        busy: number;
      };
      if (row.busy !== 0) return null;
      const size = existsSync(this.walPath())
        ? statSync(this.walPath()).size
        : 0;
      if (size !== 0) return null; // not fully truncated — treat as busy
      return {
        raced: this.dataVersion() !== dvBefore,
        ...(preflightReason === undefined
          ? {}
          : { untrustedReason: preflightReason }),
      };
    } finally {
      handle.exec("PRAGMA busy_timeout = 30000");
    }
  }

  /** Refresh the main-db identity right after a checkpoint we performed. */
  private recordDbStat(stream: DbStreamState): void {
    const st = statSync(this.dbPath());
    stream.dbSize = st.size;
    stream.dbMtimeMs = st.mtimeMs;
    stream.dbHeaderSha256 = this.dbHeaderSha256();
  }

  /**
   * Close the current group: capture the remainder, settle, TRUNCATE, then
   * finish the bookkeeping. Frames the checkpoint folded that we never shipped
   * become a break REQUEST — a checkpoint must never destroy unshipped
   * committed bytes SILENTLY.
   */
  private rollover(
    stream: DbStreamState,
    report: WalTickReport
  ): string | undefined {
    const captured = this.capture(stream, report);
    if (captured.kind === "error") return undefined;
    if (captured.kind === "break") return captured.reason;
    const settled = this.settleWal(stream, report);
    if (settled.kind === "break") return settled.reason;
    if (settled.kind === "retry") {
      // Either the capture failed or the WAL would not settle. Both mean: do
      // not checkpoint, and do not treat this stream as cleanly cut.
      report.busy = true;
      return undefined;
    }
    const result = this.truncate(settled.dataVersion);
    if (result === null) {
      report.busy = true;
      return undefined;
    }
    const reason = this.finishTruncate(stream, result, report, {
      trusted: true,
    });
    // Narrow the crash window between "WAL truncated" and "state knows"; a
    // crash inside it is still detected on restart (shrunken WAL ⇒ break).
    this.persistState();
    return reason;
  }

  /**
   * The post-TRUNCATE half of a rollover, extracted because a deferred break
   * reuses it: once a WAL is truncated its bookkeeping MUST catch up, or the
   * next tick reads a fresh WAL from a stale offset. Returns the break reason
   * the truncate itself established, if any.
   *
   * `result.raced` (from `truncate`'s `data_version` bracket) means another
   * connection committed between the reading that proved the WAL held nothing
   * past `offset` and the checkpoint's writer lock: its frames were folded into
   * the main file and ZEROED from the WAL. That is the hole, healed by a fresh
   * base (whose clone reads the main file, where those commits now live).
   *
   * `trusted` is whether this stream's `offset` still describes the real WAL. A
   * CONDEMNED stream must not get a group closer: the closer asserts "group N
   * ends at exactly `offset`" and a restore trusts it absolutely, so writing
   * one over folded-away frames would be a forgery. It is frozen instead.
   */
  private finishTruncate(
    stream: DbStreamState,
    result: TruncateResult,
    report: WalTickReport,
    opts: { trusted: boolean }
  ): string | undefined {
    const raced = result.raced;
    let reason = result.untrustedReason;
    if (raced) {
      this.log.warn(
        "wal-ship: checkpoint raced a foreign writer (data_version moved across the " +
          "TRUNCATE) — its committed frames may have been folded into the main database " +
          "unshipped; breaking generation"
      );
      reason = "checkpoint-raced-writer";
    }
    if (
      opts.trusted &&
      !raced &&
      result.untrustedReason === undefined &&
      stream.offset > 0
    ) {
      // Closer first, then advance: replay crosses a group boundary only
      // through this marker, so a group counter that advanced without one would
      // silently wall off everything after it.
      const closerKey = walGroupCloserKey({
        db: "vault",
        generation: stream.generation,
        group: stream.group,
        endOffset: stream.offset,
      });
      writeFileDurable(
        path.join(
          this.groupDir(stream.generation, stream.group),
          `${path.posix.basename(closerKey)}.mrk`
        ),
        new Uint8Array(0)
      );
      report.rolled.push({ group: stream.group, endOffset: stream.offset });
      stream.group += 1;
      stream.offset = 0;
    }
    // A truncate with nothing shipped keeps the SAME group: no closer exists
    // for it, and an advance would make later groups unreachable.
    stream.lastSize = 0;
    stream.salt1 = null;
    stream.salt2 = null;
    this.recordDbStat(stream);
    return reason;
  }

  /**
   * Re-base: TRUNCATE, then clone the WAL-quiet main file as a fresh
   * generation's base.
   *
   * The order is load-bearing. A base's effective instant is its TRUNCATE, not
   * its `copyFileSync`: everything committed before the checkpoint is folded
   * into the main file the clone reads, and everything after lands in the fresh
   * generation's WAL and ships as segments. So `baseTickMs` names a real
   * instant of the database, and no committed byte can fall between the two.
   *
   * A busy checkpoint FREEZES the stream (`breakPending`) rather than cloning:
   * a clone taken while the old WAL still holds unshipped committed frames
   * would anchor a base that no segment chain continues.
   *
   * The break's receipt goes LAST, after the clone: it is a vault write, and
   * one landing between the truncate and the clone would be a write the base
   * could not account for.
   *
   * Every step is SYNCHRONOUS. One `await` and the "no commit can interleave"
   * argument evaporates with every test still green.
   */
  private breakGeneration(reason: string, report: WalTickReport): void {
    // Read `data_version` here rather than in `settleWal`: a breaking stream
    // may be CONDEMNED, so there is no settling to do. The bracket still covers
    // the checkpoint's lock window, which the DEFER path needs — it may finish
    // a trusted stream as an ordinary rollover and must not write a closer over
    // frames a racer got folded away.
    const result = this.truncate(this.dataVersion());
    if (result === null) {
      report.busy = true;
      this.deferBreak(reason);
      return;
    }
    const old = this.state.stream;
    this.mintBase(reason, report);
    // Tally the foreign checkpoints THIS break healed (#411 action 1). Success
    // path only — a deferred break counts once, when its retry lands — and
    // BEFORE `persistState`, so the counter is durable.
    if (FOREIGN_CHECKPOINT_REASONS.has(reason)) {
      this.state.foreignCheckpointCount =
        (this.state.foreignCheckpointCount ?? 0) + 1;
      this.state.lastForeignCheckpoint = { atMs: report.tickMs, reason };
    }
    if (old?.basePending) {
      // A base still pending is not registered ⇒ not restorable ⇒ its markers
      // are dead weight, exactly like its segments.
      this.dropLocalMarkers(old.generation);
    }
    this.persistState();
    this.emitBreakReceipt(reason);
  }

  /**
   * `truncate()` came back busy. Nothing has been CLONED (which is why the
   * truncate precedes the clone), so no base can escape anchored to a stream
   * that kept running — but the stream is FROZEN (`breakPending`) until the
   * break lands next tick.
   */
  private deferBreak(reason: string): void {
    const stream = this.state.stream;
    if (stream) stream.breakPending = reason;
    this.log.warn(
      `wal-ship: generation break DEFERRED — the checkpoint is busy ` +
        `(reason: ${reason}); the stream is frozen until the retry lands`
    );
    this.persistState();
  }

  /**
   * Clone the WAL-quiet main file as a fresh generation's base (reflink where
   * supported; the main file is immutable until our next checkpoint, so even a
   * slow copy reads a stable file), hash it, and reset the stream.
   * `baseCreatedAtMs` is the TICK — the instant the manifest carries as
   * `baseTickMs`, and the one every replayed segment layers on. The caller has
   * already TRUNCATED; synchronous on purpose.
   */
  private mintBase(reason: string, report: WalTickReport): void {
    const old = this.state.stream;
    const generation = newWalGeneration(this.random);
    const baseName = path.join("bases", `${generation}.db`);
    const baseAbs = this.basePath(baseName);
    mkdirSync(path.dirname(baseAbs), { recursive: true });
    const reflinked = cloneDbFile(this.dbPath(), baseAbs);
    if (!reflinked && !this.warnedPlainClone) {
      this.warnedPlainClone = true;
      this.log.warn(
        "wal-ship: filesystem has no reflink support; daily base snapshots require a full DB copy. " +
          "For Pi-class hosts prefer f2fs, btrfs, or a USB SSD and mount with noatime."
      );
    }
    const fd = openSync(baseAbs, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDirBestEffort(path.dirname(baseAbs));
    const sha256 = sha256File(baseAbs);
    const dbStat = statSync(this.dbPath());
    this.state.stream = {
      generation,
      group: 0,
      offset: 0,
      lastSize: 0,
      salt1: null,
      salt2: null,
      pageSize: old?.pageSize ?? null,
      dbSize: dbStat.size,
      dbMtimeMs: dbStat.mtimeMs,
      dbHeaderSha256: this.dbHeaderSha256(),
      baseName,
      ...(old ? { retiredBaseName: old.baseName } : {}),
      baseCreatedAtMs: report.tickMs,
      baseSha256: sha256,
      basePending: true,
      closedClean: false,
    };
    report.breaks.push({ reason });
    this.log.info(`wal-ship: generation break (${reason}) → ${generation}`);
    if (old) {
      if (old.basePending) {
        // Never uploaded ⇒ the old generation was never restorable; its
        // local segments are dead weight.
        this.dropLocalGeneration(old.generation);
      }
      // The grandparent's base retires now; `old`'s clone stays one break
      // longer (see retiredBaseName — an in-flight snapshot may be reading it).
      if (old.retiredBaseName !== undefined) {
        rmSync(this.basePath(old.retiredBaseName), { force: true });
      }
    }
  }

  /** The break's receipt — a vault write, so: after the clone. */
  private emitBreakReceipt(reason: string): void {
    const stream = this.state.stream!;
    try {
      writeReceipt(this.db.audit, {
        grantId: null,
        invocationId: null,
        action: "act access.backup_wal_generation",
        objectType: "core.vault",
        objectId: null,
        purpose: null,
        decision: "allow",
        detail: {
          reason,
          generation: stream.generation,
          baseSha256: stream.baseSha256,
        },
      });
    } catch (error) {
      this.log.warn(
        `wal-ship: generation receipt failed (${error instanceof Error ? error.message : String(error)})`
      );
    }
  }

  /**
   * The end-of-tick marker (FORMAT.md § WAL segments): where the stream stood
   * when the tick ended.
   *
   * Written LAST — after captures, rollovers AND the break — because it must
   * describe where the tick ENDED; a marker naming a pre-rollover position
   * makes every later restore walk back a tick.
   *
   * Exactly ONE marker per (generation, tick): the nonce derives from that
   * pair, so two different payloads under it would reuse a (key, nonce) pair —
   * GCM's one fatal sin. The local path IS that pair, so a tick re-run after a
   * crash overwrites in place.
   *
   * Two ticks need no marker: one where nothing moved, and one ending in a
   * BREAK, which leaves the stream at (0, 0) of a fresh generation — that IS
   * its base. The cost of the second is one tick of PITR depth on a generation
   * that retires anyway, paid to keep once-per-key airtight.
   */
  private writeTickMarker(report: WalTickReport): void {
    // A marker is a proof about a cut. An error, a busy checkpoint or a
    // generation break means this tick did not establish one.
    if (report.errors.length > 0 || report.busy || report.breaks.length > 0)
      return;
    if (report.shipped.length === 0 && report.rolled.length === 0) return;
    const stream = this.state.stream;
    if (!stream) return;
    const position: WalStreamPosition = {
      group: stream.group,
      endOffset: stream.offset,
    };
    // The floor IS the base; a marker for it would say nothing.
    if (position.group === 0 && position.endOffset === 0) return;
    const marker: WalTickMarker = {
      generation: stream.generation,
      tickMs: report.tickMs,
      position,
    };
    const key = walTickMarkerKey(marker);
    writeFileDurable(
      path.join(
        this.markerDir(marker.generation),
        `${path.posix.basename(key)}.tick`
      ),
      new TextEncoder().encode(
        JSON.stringify({ v: 1, tickMs: marker.tickMs, position })
      )
    );
    report.markers.push(key);
  }

  /** Delete one generation's local segment tree, keeping the byte counter exact. */
  private dropLocalGeneration(generation: string): void {
    const dir = path.join(this.dir, "segments", generation);
    this.localSegmentBytes -= this.walkSegmentBytes(dir);
    if (this.localSegmentBytes < 0) this.localSegmentBytes = 0;
    rmSync(dir, { recursive: true, force: true });
  }

  /** Delete one generation's local markers. */
  private dropLocalMarkers(generation: string): void {
    rmSync(this.markerDir(generation), { recursive: true, force: true });
  }

  /**
   * Local disk budget (design Q4): over budget, trade PITR depth for disk —
   * break the generation and DROP the superseded one's local segments,
   * registered or not. The space MUST actually free, or this fires every tick:
   * a per-minute break is a whole-DB copy per minute, the exact wear cliff this
   * feature exists to delete.
   */
  private enforceLocalBudget(report: WalTickReport): void {
    if (this.localBudgetBytes <= 0) return;
    // Segments only: base clones are pinned by design (≤ 2 per db,
    // reflink-cheap), and counting them would make an over-budget vault mint a
    // fresh base every tick without ever freeing anything.
    if (this.localSegmentBytes <= this.localBudgetBytes) return;
    this.log.warn(
      `wal-ship: local segments ${this.localSegmentBytes} bytes exceed budget ` +
        `${this.localBudgetBytes} — rolling generations (PITR history traded for disk)`
    );
    const old = this.state.stream?.generation;
    if (old === undefined) return;
    this.breakGeneration("local-budget", report);
    const fresh = this.state.stream;
    if (fresh && fresh.generation !== old) {
      // The break itself only drops never-registered history; the budget path
      // must free a REGISTERED generation's local files too (see doc).
      this.dropLocalGeneration(old);
      this.dropLocalMarkers(old);
    }
  }

  // ─────────────────────────────────────────────────────── controlled points

  /**
   * A controlled checkpoint: ship the remainder, then TRUNCATE with the same
   * raced-writer verification as a rollover.
   */
  checkpointNow(): WalTickReport {
    if (this.closed) throw new Error("WalShipper is closed");
    const report = this.newReport();
    let reason = this.resolveBreakReason();
    if (reason === undefined)
      reason = this.rollover(this.state.stream!, report);
    if (reason !== undefined) this.breakGeneration(reason, report);
    this.writeTickMarker(report);
    this.persistState();
    return report;
  }

  /**
   * Explicit generation roll (band archival, backup-enable, restore-takeover,
   * tests). By default the old generation ships its pending bytes first so PITR
   * history stays maximal; `captureFirst: false` skips that for the archival
   * hook, whose WAL holds the archival VACUUM's whole-database rewrite that the
   * fresh base already contains.
   */
  rollGeneration(
    reason: string,
    opts: { captureFirst?: boolean } = {}
  ): WalTickReport {
    if (this.closed) throw new Error("WalShipper is closed");
    const report = this.newReport();
    // Whatever the detectors already condemned must not ship another byte,
    // whatever the caller wants.
    let effective = this.resolveBreakReason() ?? reason;
    const stream = this.state.stream;
    // A stream holed by capture-then-discard ships nothing either: more bytes
    // only widen a hole in a generation about to retire.
    if (
      effective === reason &&
      opts.captureFirst !== false &&
      stream &&
      stream.discarded !== true
    ) {
      const captured = this.capture(stream, report);
      if (captured.kind === "break") effective = captured.reason;
    }
    this.breakGeneration(effective, report);
    this.writeTickMarker(report);
    this.persistState();
    return report;
  }

  /**
   * Final ship + truncate, then mark the streams clean so the reopen path
   * expects SQLite's own close-checkpoint of an EMPTY wal and fresh salts. Call
   * before `db.close({ skipOptimize: true })` — `PRAGMA optimize` runs HERE,
   * before the final checkpoint, because its ANALYZE writes land in the WAL and
   * would otherwise be folded in at handle close, making every restart look
   * foreign. The main-db identity check stays ACTIVE across restarts, so a
   * commit racing the window between this checkpoint and the close is DETECTED
   * on reopen — degraded to a fresh base, never a silent gap.
   */
  close(): WalTickReport {
    try {
      this.db.vault.exec("PRAGMA optimize");
    } catch {
      // Best-effort maintenance, mirroring VaultDb.close().
    }
    const report = this.checkpointNow();
    const stream = this.state.stream;
    if (stream && !report.busy) stream.closedClean = true;
    this.persistState();
    this.closed = true;
    return report;
  }

  // ──────────────────────────────────────────────────────────── upload seam

  /** Every durable local file awaiting upload, oldest generation first. */
  listUploadable(): UploadableWalFile[] {
    const out: UploadableWalFile[] = [];
    const segRoot = path.join(this.dir, "segments");
    if (!existsSync(segRoot)) return out;
    // Shape-check every level: one stray plain file (.DS_Store, an editor swap)
    // readdirSync'd here would wedge this vault's drain forever.
    const dirsIn = (dir: string, re: RegExp): string[] =>
      readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && re.test(e.name))
        .map((e) => e.name)
        .sort();
    for (const generation of dirsIn(segRoot, /^[0-9a-f]{32}$/u)) {
      const genRoot = path.join(segRoot, generation);
      for (const groupName of dirsIn(genRoot, /^\d{8}$/u)) {
        const groupRoot = path.join(genRoot, groupName);
        const group = Math.trunc(Number(groupName));
        for (const name of readdirSync(groupRoot).sort()) {
          const full = path.join(groupRoot, name);
          const addr = this.parseSegmentFileName(generation, group, name);
          if (addr) {
            out.push({
              file: full,
              key: walSegmentKey(addr),
              kind: "segment",
              addr,
              bytes: statSync(full).size,
            });
            continue;
          }
          if (name.endsWith(".mrk")) {
            const closer = parseWalCloserKey(
              `wal/vault/${generation}/${groupName}/${name.slice(0, -4)}`
            );
            if (closer) {
              out.push({
                file: full,
                key: walGroupCloserKey(closer),
                kind: "closer",
                closer,
                bytes: 0,
              });
            }
          }
        }
      }
    }
    // Markers LAST, so a tick's marker drains after the segments and closers it
    // describes. Not correctness (an orphan marker is merely unsatisfiable) but
    // the reverse order costs a tick of RPO per drain.
    const markerRoot = path.join(this.dir, "markers");
    if (existsSync(markerRoot)) {
      for (const generation of dirsIn(markerRoot, /^[0-9a-f]{32}$/u)) {
        const genDir = path.join(markerRoot, generation);
        for (const name of readdirSync(genDir).sort()) {
          if (!name.endsWith(".tick")) continue;
          const tickMs = Math.trunc(Number(name.slice(0, -5)));
          if (!Number.isInteger(tickMs)) continue;
          const full = path.join(genDir, name);
          let payload: { position?: WalStreamPosition };
          try {
            payload = JSON.parse(readFileSync(full, "utf8")) as typeof payload;
          } catch {
            continue; // unreadable residue — never a reason to wedge the drain
          }
          if (!payload.position) continue;
          const marker: WalTickMarker = {
            generation,
            tickMs,
            position: payload.position,
          };
          out.push({
            file: full,
            key: walTickMarkerKey(marker),
            kind: "marker",
            marker,
            bytes: 0,
          });
        }
      }
    }
    return out;
  }

  /** The uploader confirmed `key` is durably remote — drop the local copy. */
  noteUploaded(item: UploadableWalFile): void {
    rmSync(item.file, { force: true });
    this.localSegmentBytes -= item.bytes;
    if (this.localSegmentBytes < 0) this.localSegmentBytes = 0;
  }

  /**
   * Captured files were deleted WITHOUT upload (backup unconfigured). Marks the
   * stream holed; the BackupService breaks the generation before registering
   * its base, since a restore of a holed stream lands on the stale base.
   */
  noteStreamDiscarded(): void {
    const stream = this.state.stream;
    if (stream && !stream.discarded) {
      stream.discarded = true;
      this.persistState();
    }
  }

  /** Holed by capture-then-discard — roll before registering. */
  streamDiscarded(): boolean {
    return this.state.stream?.discarded === true;
  }

  /** The base, when it still needs a registered snapshot. */
  pendingBase(): PendingBase | null {
    const stream = this.state.stream;
    return stream?.basePending ? this.baseOf(stream) : null;
  }

  /** The current base (for manifest assembly), pending or not. */
  currentBase(): PendingBase | null {
    const stream = this.state.stream;
    return stream ? this.baseOf(stream) : null;
  }

  private baseOf(stream: DbStreamState): PendingBase {
    return {
      generation: stream.generation,
      file: this.basePath(stream.baseName),
      sha256: stream.baseSha256,
      createdAtMs: stream.baseCreatedAtMs,
    };
  }

  /**
   * Is the base one a snapshot may be registered against — present, and no
   * break mid-flight? A manifest registered over a frozen stream would anchor
   * a base whose successor segments are about to be dropped.
   */
  baseReady(): boolean {
    const stream = this.state.stream;
    return stream !== undefined && stream.breakPending === undefined;
  }

  /** The gateway registered a snapshot anchoring this generation's base. */
  noteBaseRegistered(generation: string): void {
    const stream = this.state.stream;
    if (stream && stream.generation === generation) {
      stream.basePending = false;
      this.persistState();
    }
  }

  status(): {
    stream?: {
      generation: string;
      group: number;
      offset: number;
      basePending: boolean;
    };
    localBytes: number;
    /** Foreign checkpoints detected and healed over this shipper's whole life;
     *  a churn signal the gateway surfaces through backup health. */
    foreignCheckpointCount: number;
    lastForeignCheckpoint?: { atMs: number; reason: string };
  } {
    const s = this.state.stream;
    return {
      ...(s
        ? {
            stream: {
              generation: s.generation,
              group: s.group,
              offset: s.offset,
              basePending: s.basePending,
            },
          }
        : {}),
      localBytes: this.localSegmentBytes,
      foreignCheckpointCount: this.state.foreignCheckpointCount ?? 0,
      ...(this.state.lastForeignCheckpoint
        ? { lastForeignCheckpoint: this.state.lastForeignCheckpoint }
        : {}),
    };
  }
}
