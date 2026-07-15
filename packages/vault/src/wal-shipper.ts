// governance: allow-repo-hygiene file-size-limit (#408) the WAL capture loop is one correctness argument — detectors, capture, rollover, generation lifecycle and crash-ordering rules all lean on each other's invariants; splitting them would scatter the proof across files that only ever change together
/*
 * In-process WAL segment shipper (issue #408) — the capture half of the
 * continuous, PITR-capable vault backup. Each tick copies the committed
 * byte-delta of `vault.db-wal` / `journal.db-wal` into local segment files;
 * the gateway's uploader seals and drains them to the provider
 * (`@centraid/backup` wal-format owns the object format).
 *
 * The correctness story rests on two invariants:
 *   I1 — the gateway's synchronous command pipeline is the only writer to
 *        vault.db (journal.db additionally has out-of-process ledger
 *        writers — tolerated, see below);
 *   I2 — nobody checkpoints but this shipper, always with TRUNCATE, so the
 *        WAL is strictly append-only between our checkpoints and byte
 *        offsets are never reused within a group.
 * I2 is enforced (every opener sets `wal_autocheckpoint = 0`) AND detected:
 * violations break the generation — a fresh base snapshot — never a silent
 * gap. The tick body is fully synchronous, which on a synchronous
 * `node:sqlite` write path means no gateway write can interleave with it
 * (event-loop atomicity): the per-tick stat pair over the two databases is
 * a coordinated restore point without any locking.
 *
 * journal.db's subprocess writers make two extra defenses load-bearing:
 *   - segments end on COMMIT boundaries (`lastCommitBoundary`): uncommitted
 *     tails are not append-only — a rollback rewinds SQLite's write cursor
 *     and the next transaction overwrites those bytes in place;
 *   - every TRUNCATE is bracketed by a `PRAGMA data_version` reading
 *     (`settleWal` + `truncate`): a writer that commits in the
 *     stat→checkpoint microsecond window would otherwise have its frames
 *     silently folded into the main file and zeroed from the WAL — a
 *     permanent hole in the stream (the one thing the design forbids) —
 *     detected ⇒ generation break, whose fresh base clone carries exactly
 *     the commits that were folded in.
 *
 * Crash ordering (G7): segment file fsync happens BEFORE the state-file
 * offset fsync. A crash between the two re-captures a range from the same
 * start — possibly longer, which is why the object nonce derivation
 * includes the end offset — and duplicate uploads are prefix-compatible
 * (longest-wins at plan time). A hole is not reachable: nothing ever
 * advances `offset` past bytes that aren't durably in a local segment, and
 * nothing checkpoints bytes that aren't durably at or behind `offset`.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  newWalGeneration,
  parseWalCloserKey,
  parseWalSegmentKey,
  WAL_CAPTURE_ORDER,
  WAL_DB_FILES,
  WAL_DB_NAMES,
  type WalDbName,
  type WalGroupCloser,
  type WalPairMarker,
  type WalPairPosition,
  type WalSegmentAddress,
  walGroupCloserKey,
  WAL_HEADER_BYTES,
  scanWalPrefix,
  walPairMarkerKey,
  walSalts,
  walSegmentKey,
} from '@centraid/backup';
import type { VaultDb } from './db.js';
import { sha256File } from './gateway/custody.js';
import { writeReceipt } from './gateway/evidence.js';

export interface WalShipperLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface WalShipperOptions {
  db: VaultDb;
  /** Defaults to `<vaultDir>/wal-ship`. */
  dir?: string;
  /** WAL size that triggers a group rollover (checkpoint). Default 16 MiB. */
  walSizeThresholdBytes?: number;
  /** Base-snapshot cadence (generation roll). Default 24 h. */
  baseIntervalMs?: number;
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
  /** Main-db file identity after our last checkpoint — it MUST NOT change
   * between our checkpoints (all writes go to the WAL); any change means a
   * foreign checkpoint backfilled frames we may never have seen. */
  dbSize: number;
  dbMtimeMs: number;
  /** Hash of SQLite's 100-byte database header. Catches a foreign
   * checkpoint even on filesystems whose coarse mtime and stable size hide it. */
  dbHeaderSha256: string;
  /** Relative path of the pinned base clone for this generation. */
  baseName: string;
  /**
   * The SUPERSEDED generation's base clone, kept one break longer: the
   * gateway's snapshot engine may still be streaming it when a base-cadence
   * or archival roll lands mid-run — deleting it immediately would ENOENT
   * a running backup. It is removed at the NEXT break (a run spanning two
   * breaks would have to outlive a whole base interval).
   */
  retiredBaseName?: string;
  baseCreatedAtMs: number;
  /** SHA-256 of the base clone (computed by `pendingBases` consumers lazily
   * would race the file's lifetime; it is cheap enough at roll time). */
  baseSha256: string;
  /** True until the gateway registers a snapshot anchoring this base. */
  basePending: boolean;
  /** Set by `close()` after a final ship+truncate; cleared on next start. */
  closedClean: boolean;
  /**
   * Set when captured files of THIS stream were deleted without upload
   * (backup unconfigured — capture-then-discard). The stream has holes, so
   * the moment a backend appears it must break to a fresh generation
   * BEFORE its stale base gets registered: a restore of a holed stream
   * silently lands on the old base, exactly the quiet truncation this
   * feature forbids. Persisted — the transition can span restarts.
   */
  discarded?: boolean;
  /**
   * A coordinated generation break that could not complete (the sibling's
   * checkpoint came back busy after this one's had already truncated). The
   * stream is FROZEN until the break lands: nothing captures, nothing rolls,
   * nothing ships under this generation. Persisted — the intent must survive a
   * restart, or the next boot would cheerfully resume a stream whose sibling is
   * mid-break, and the pair of bases that eventually registers would be two
   * different instants.
   */
  breakPending?: string;
}

type CaptureResult = { kind: 'ok' } | { kind: 'error' } | { kind: 'break'; reason: string };

type SettleResult =
  | { kind: 'ready'; dataVersion: number }
  | { kind: 'retry' }
  | { kind: 'break'; reason: string };

interface TruncateResult {
  raced: boolean;
  untrustedReason?: string;
}

interface ShipperState {
  version: 1;
  /** Monotonicized tick clock — survives restarts and wall-clock rewinds. */
  lastTickMs: number;
  dbs: Partial<Record<WalDbName, DbStreamState>>;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isStreamState(value: unknown, db: WalDbName): value is DbStreamState {
  if (typeof value !== 'object' || value === null) return false;
  const stream = value as Record<string, unknown>;
  if (typeof stream['generation'] !== 'string' || !/^[0-9a-f]{32}$/.test(stream['generation'])) {
    return false;
  }
  const generation = stream['generation'];
  if (stream['baseName'] !== `bases/${db}/${generation}.db`) return false;
  if (
    stream['retiredBaseName'] !== undefined &&
    (typeof stream['retiredBaseName'] !== 'string' ||
      !new RegExp(`^bases/${db}/[0-9a-f]{32}\\.db$`).test(stream['retiredBaseName']))
  ) {
    return false;
  }
  if (
    !isNonNegativeInteger(stream['group']) ||
    !isNonNegativeInteger(stream['offset']) ||
    !isNonNegativeInteger(stream['lastSize']) ||
    !isNonNegativeInteger(stream['dbSize']) ||
    !isNonNegativeInteger(stream['baseCreatedAtMs'])
  ) {
    return false;
  }
  if (
    (stream['salt1'] !== null && !isNonNegativeInteger(stream['salt1'])) ||
    (stream['salt2'] !== null && !isNonNegativeInteger(stream['salt2'])) ||
    (stream['pageSize'] !== null && !isNonNegativeInteger(stream['pageSize']))
  ) {
    return false;
  }
  if (typeof stream['dbMtimeMs'] !== 'number' || !Number.isFinite(stream['dbMtimeMs']))
    return false;
  if (
    typeof stream['dbHeaderSha256'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(stream['dbHeaderSha256'])
  ) {
    return false;
  }
  if (typeof stream['baseSha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(stream['baseSha256'])) {
    return false;
  }
  if (typeof stream['basePending'] !== 'boolean' || typeof stream['closedClean'] !== 'boolean') {
    return false;
  }
  if (stream['discarded'] !== undefined && typeof stream['discarded'] !== 'boolean') return false;
  if (stream['breakPending'] !== undefined && typeof stream['breakPending'] !== 'string')
    return false;
  return true;
}

function isShipperState(value: unknown): value is ShipperState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Record<string, unknown>;
  if (state['version'] !== 1 || !isNonNegativeInteger(state['lastTickMs'])) return false;
  if (typeof state['dbs'] !== 'object' || state['dbs'] === null) return false;
  const dbs = state['dbs'] as Record<string, unknown>;
  return WAL_DB_NAMES.every((db) => dbs[db] === undefined || isStreamState(dbs[db], db));
}

export interface WalTickReport {
  tickMs: number;
  /** Object keys of segments captured this tick (local, durable). */
  shipped: string[];
  /** Groups closed this tick (rollover checkpoints). */
  rolled: { db: WalDbName; group: number; endOffset: number }[];
  /** Generation breaks with their reasons (fresh base minted). */
  breaks: { db: WalDbName; reason: string }[];
  /** Pair-marker object keys written this tick (at most one). */
  markers: string[];
  /** Databases whose checkpoint returned busy (retried next tick). */
  busy: WalDbName[];
  errors: { db: WalDbName; message: string }[];
}

export interface UploadableWalFile {
  /** Absolute path of the local plaintext file. */
  file: string;
  /** The object key it seals to. */
  key: string;
  kind: 'segment' | 'closer' | 'marker';
  addr?: WalSegmentAddress;
  closer?: WalGroupCloser;
  marker?: WalPairMarker;
  bytes: number;
}

export interface PendingBase {
  db: WalDbName;
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
/** A single oversized transaction must not turn capture into an unbounded
 * allocation. Re-basing preserves its committed state while sacrificing only
 * the PITR points inside that exceptional WAL era. */
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
/**
 * Max capture passes `settleWal` will make chasing a writer before it gives up
 * and leaves the WAL untruncated for this tick. Each pass captures whatever
 * committed since the last one, so a normal writer settles in one or two; a
 * writer that outruns eight is one we would rather retry next tick than
 * checkpoint under.
 */
const TRUNCATE_SETTLE_PASSES = 8;
const noopLog: Required<WalShipperLogger> = { info: () => undefined, warn: () => undefined };

/**
 * Copy-on-write clone of a database file — the base of a new generation.
 *
 * This MUST be a reflink wherever the filesystem offers one, or the design's
 * cost story collapses: a base is minted on every generation break (daily, at
 * minimum), so a byte copy means writing a second full copy of the vault every
 * day and carrying 2x the vault on disk forever. Local bytes/day would be
 * O(database), not O(change).
 *
 * `copyFileSync(..., COPYFILE_FICLONE)` does NOT deliver that on macOS. libuv
 * implements FICLONE via `ioctl` on Linux only; on Darwin it silently falls
 * back to a full byte copy — the flag is accepted and ignored. Measured here on
 * APFS, 512 MiB: `COPYFILE_FICLONE` 497 ms and a real second copy on disk,
 * `cp -c` (clonefile(2)) 2 ms and no new blocks. At a 10 GiB vault that is
 * ~10 GiB written per day versus ~0.
 *
 * So on Darwin we ask for clonefile(2) explicitly. It fails on a non-APFS
 * volume or across devices; that is exactly when a byte copy is the only option
 * anyway, so fall through to it. `execFileSync` keeps the tick synchronous —
 * the cross-database ordering guarantee (journal cut strictly before vault, no
 * commit interleaving) rests on this whole path being one event-loop turn.
 */
export function cloneDbFile(src: string, dst: string): void {
  if (process.platform === 'darwin') {
    try {
      execFileSync('/bin/cp', ['-c', src, dst], { stdio: 'ignore' });
      return;
    } catch {
      // Not a clone-capable volume — the byte copy below is the real fallback.
    }
  }
  copyFileSync(src, dst, fsConstants.COPYFILE_FICLONE);
}

function fsyncDirBestEffort(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is not supported everywhere; the file fsyncs are the
    // load-bearing ones, this narrows the rename-durability window further.
  }
}

function writeFileDurable(file: string, data: Uint8Array): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const fd = openSync(file, 'w');
  try {
    let at = 0;
    while (at < data.length) at += writeSync(fd, data, at, data.length - at);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirBestEffort(path.dirname(file));
}

/** The WAL shipper for one open vault. All methods are synchronous. */
export class WalShipper {
  private readonly db: VaultDb;
  private readonly dir: string;
  private readonly stateFile: string;
  private readonly threshold: number;
  private readonly baseIntervalMs: number;
  private readonly localBudgetBytes: number;
  private readonly now: () => number;
  private readonly random: (n: number) => Uint8Array;
  private readonly log: Required<WalShipperLogger>;
  private state: ShipperState;
  private stateRecovered = false;
  private closed = false;
  /**
   * Running total of local segment bytes — seeded by one walk at
   * construction, then maintained incrementally (capture adds, noteUploaded
   * and the prune paths subtract). The shipper is the only writer and
   * deleter of this tree, so the counter is exact; it replaces a full
   * readdir+stat walk per 60 s tick that grew with exactly the offline
   * backlog the budget exists to handle.
   */
  private localSegmentBytes = 0;

  constructor(opts: WalShipperOptions) {
    if (opts.db.dir === ':memory:') {
      throw new Error('WalShipper needs a file-backed vault');
    }
    this.db = opts.db;
    this.dir = opts.dir ?? path.join(opts.db.dir, 'wal-ship');
    this.stateFile = path.join(this.dir, 'state.json');
    this.threshold = opts.walSizeThresholdBytes ?? DEFAULT_THRESHOLD;
    this.baseIntervalMs = opts.baseIntervalMs ?? DEFAULT_BASE_INTERVAL_MS;
    this.localBudgetBytes = opts.localBudgetBytes ?? DEFAULT_LOCAL_BUDGET;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? ((n) => new Uint8Array(randomBytes(n)));
    this.log = { ...noopLog, ...opts.log };
    mkdirSync(this.dir, { recursive: true });
    this.state = this.loadState();
    this.startupHygiene();
    this.localSegmentBytes = this.walkSegmentBytes(path.join(this.dir, 'segments'));
  }

  private walkSegmentBytes(dir: string): number {
    if (!existsSync(dir)) return 0;
    let total = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      total += entry.isDirectory() ? this.walkSegmentBytes(full) : statSync(full).size;
    }
    return total;
  }

  // -------------------------------------------------------------------- state

  private loadState(): ShipperState {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      if (isShipperState(parsed)) {
        this.stateRecovered = true;
        return parsed;
      }
    } catch {
      /* fresh or unreadable — start over via generation init */
    }
    return { version: 1, lastTickMs: 0, dbs: {} };
  }

  /** Durable state write — G7 step 2 (always AFTER the segment fsync). */
  private persistState(): void {
    const tmp = `${this.stateFile}.tmp`;
    try {
      writeFileDurable(tmp, new TextEncoder().encode(`${JSON.stringify(this.state, null, 2)}\n`));
      renameSync(tmp, this.stateFile);
    } catch (err) {
      // A partial tmp on a full disk must not linger (it would accumulate
      // per tick); the state file itself is still the last good version.
      rmSync(tmp, { force: true });
      throw err;
    }
    fsyncDirBestEffort(this.dir);
  }

  /**
   * Startup hygiene: local segment files whose end lies BEYOND the persisted
   * offset are un-acknowledged rewrites from a crash between segment-fsync
   * and state-fsync. Their bytes are still in the WAL (nothing checkpointed
   * past `offset` — see G4/G7 ordering), so the next tick re-captures them;
   * deleting the strays keeps duplicate uploads bounded. (Uploading such a
   * file would be SAFE — same-start ranges are prefix-compatible and the
   * planner takes the longest — this is hygiene, not correctness.)
   */
  private startupHygiene(): void {
    if (!this.stateRecovered) {
      // Without authenticated offsets/generations no orphan segment can be
      // chained safely. Drop the whole unreferenced spool so the first-run
      // base starts clean instead of letting an unreachable backlog trigger a
      // generation roll on every budget check forever.
      rmSync(path.join(this.dir, 'segments'), { recursive: true, force: true });
      rmSync(path.join(this.dir, 'markers'), { recursive: true, force: true });
      rmSync(path.join(this.dir, 'bases'), { recursive: true, force: true });
      return;
    }
    for (const db of WAL_DB_NAMES) {
      const stream = this.state.dbs[db];
      if (!stream) continue;
      const groupDir = this.groupDir(db, stream.generation, stream.group);
      if (!existsSync(groupDir)) continue;
      for (const name of readdirSync(groupDir)) {
        const addr = this.parseSegmentFileName(db, stream.generation, stream.group, name);
        if (addr && addr.endOffset > stream.offset) {
          rmSync(path.join(groupDir, name), { force: true });
          this.log.warn(`wal-ship: dropped unacknowledged segment ${db}/${name} (crash residue)`);
        }
      }
    }
  }

  /**
   * Local filenames are the object key's basename plus an extension (see
   * capture()) — parsing reconstructs the key and delegates to the ONE
   * codec in wal-format, so a format change can never desync the builder
   * from these parsers.
   */
  private parseSegmentFileName(
    db: WalDbName,
    generation: string,
    group: number,
    name: string,
  ): WalSegmentAddress | null {
    if (!name.endsWith('.seg')) return null;
    return parseWalSegmentKey(
      `wal/${db}/${generation}/${String(group).padStart(8, '0')}/${name.slice(0, -4)}`,
    );
  }

  // -------------------------------------------------------------------- paths

  private walPath(db: WalDbName): string {
    return path.join(this.db.dir, `${WAL_DB_FILES[db]}-wal`);
  }

  private dbPath(db: WalDbName): string {
    return path.join(this.db.dir, WAL_DB_FILES[db]);
  }

  private dbHeaderSha256(db: WalDbName): string {
    const fd = openSync(this.dbPath(db), 'r');
    try {
      const header = Buffer.alloc(100);
      const bytes = readSync(fd, header, 0, header.length, 0);
      return createHash('sha256').update(header.subarray(0, bytes)).digest('hex');
    } finally {
      closeSync(fd);
    }
  }

  private handle(db: WalDbName): DatabaseSync {
    return db === 'vault' ? this.db.vault : this.db.journal;
  }

  private groupDir(db: WalDbName, generation: string, group: number): string {
    return path.join(this.dir, 'segments', db, generation, String(group).padStart(8, '0'));
  }

  private basePath(baseName: string): string {
    return path.join(this.dir, baseName);
  }

  /** `markers/{vaultGeneration}-{journalGeneration}/` — one dir per BASE PAIR. */
  private markerDir(vaultGeneration: string, journalGeneration: string): string {
    return path.join(this.dir, 'markers', `${vaultGeneration}-${journalGeneration}`);
  }

  // ------------------------------------------------------------------ ticking

  private nextTickMs(): number {
    const t = Math.max(this.now(), this.state.lastTickMs + 1);
    this.state.lastTickMs = t;
    return t;
  }

  private newReport(): WalTickReport {
    // ONE `nextTickMs()` per pass. Every segment, closer and pair marker this
    // pass emits carries this exact value — a marker that named a different
    // tick than the segments it describes would be unsatisfiable forever.
    return {
      tickMs: this.nextTickMs(),
      shipped: [],
      rolled: [],
      breaks: [],
      markers: [],
      busy: [],
      errors: [],
    };
  }

  /**
   * One capture pass, in four phases over BOTH databases:
   *   1. decide whether either database breaks (detectors, a deferred break,
   *      a first run) — BEFORE a byte ships under a generation that may be
   *      condemned;
   *   2. capture, journal FIRST, for the databases that are not breaking, plus
   *      their cadence/rollover checks (which may themselves REQUEST a break);
   *   3. ONE coordinated break if either database asked for one — they re-base
   *      together or not at all;
   *   4. the end-of-tick pair marker, once both databases have settled.
   *
   * Synchronous end to end, and it must stay that way: the guarantee that no
   * gateway write can land between the journal's cut and the vault's is
   * event-loop atomicity over a synchronous `node:sqlite` (invariant I1), not
   * a lock. A single `await` anywhere in this path destroys it — and no test
   * would fail.
   */
  tick(): WalTickReport {
    if (this.closed) throw new Error('WalShipper is closed');
    const report = this.newReport();
    const reasons = this.resolveBreakReasons();

    for (const db of WAL_CAPTURE_ORDER) {
      if (reasons[db] !== undefined) continue;
      const stream = this.state.dbs[db]!;
      try {
        const captured = this.capture(db, stream, report);
        if (captured.kind === 'error') continue;
        if (captured.kind === 'break') {
          reasons[db] = captured.reason;
          continue;
        }
        // Base cadence: a generation roll IS the base snapshot. A REQUEST, not
        // an inline break — the pair re-bases in one tick or not at all.
        if (report.tickMs - stream.baseCreatedAtMs >= this.baseIntervalMs) {
          reasons[db] = 'base-cadence';
          continue;
        }
        // Group rollover: bound the WAL (and with it segment sizes + restart
        // recovery time), local-only — never network-coupled (G4). A rollover
        // that catches a racing writer requests a break of its own.
        if (stream.lastSize > this.threshold) {
          this.rollover(db, stream, reasons, report);
        }
      } catch (err) {
        report.errors.push({ db, message: err instanceof Error ? err.message : String(err) });
        this.log.warn(`wal-ship: ${db} tick failed: ${report.errors.at(-1)!.message}`);
      }
    }

    this.coordinatedBreak(reasons, report);
    this.enforceLocalBudget(report);
    this.writePairMarker(report);
    this.persistState();
    return report;
  }

  /**
   * Phase 1: which databases must break, and why. Nothing ships, nothing
   * checkpoints — a stream whose detector fired is untrustworthy and must not
   * ship another byte under its current generation, and a stream with a
   * deferred break must not ship at all until that break lands.
   */
  private resolveBreakReasons(): Partial<Record<WalDbName, string>> {
    const reasons: Partial<Record<WalDbName, string>> = {};
    for (const db of WAL_CAPTURE_ORDER) {
      const stream = this.state.dbs[db];
      if (!stream) {
        reasons[db] = 'first-run';
        continue;
      }
      if (stream.breakPending !== undefined) {
        reasons[db] = stream.breakPending;
        continue;
      }
      if (stream.closedClean) {
        // Clean shutdown left the WAL empty (or deleted by SQLite's own
        // close-checkpoint of an already-empty WAL). Whatever exists now is a
        // fresh WAL for the already-advanced group.
        stream.closedClean = false;
        stream.salt1 = null;
        stream.salt2 = null;
        stream.lastSize = 0;
      }
      // G5 detectors — evaluated BEFORE anything ships under this generation.
      const reason = this.detectForeign(db, stream);
      if (reason) reasons[db] = reason;
    }
    return reasons;
  }

  /** Returns a break reason, or null when the stream is intact. */
  private detectForeign(db: WalDbName, stream: DbStreamState): string | null {
    // Main-db identity: between OUR checkpoints every write goes to the WAL,
    // so the main file must be byte-stable. A change means someone else
    // checkpointed (frames possibly never observed by us — unrecoverable
    // for this stream, catchable no other way).
    const dbStat = statSync(this.dbPath(db));
    if (
      dbStat.size !== stream.dbSize ||
      dbStat.mtimeMs !== stream.dbMtimeMs ||
      this.dbHeaderSha256(db) !== stream.dbHeaderSha256
    ) {
      return 'main-db-file-changed-without-our-checkpoint';
    }
    const walPath = this.walPath(db);
    if (!existsSync(walPath)) {
      return stream.offset > 0 || stream.lastSize > 0 ? 'wal-file-vanished' : null;
    }
    const size = statSync(walPath).size;
    if (size < stream.lastSize) return 'wal-shrank-without-our-checkpoint';
    if (size >= WAL_HEADER_BYTES && stream.salt1 !== null) {
      const header = this.readWalRange(db, 0, WAL_HEADER_BYTES);
      const salts = walSalts(header);
      if (salts.salt1 !== stream.salt1 || salts.salt2 !== stream.salt2) {
        return 'wal-salts-changed-without-our-checkpoint';
      }
    }
    return null;
  }

  private readWalRange(db: WalDbName, start: number, end: number): Uint8Array {
    const fd = openSync(this.walPath(db), 'r');
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
   * A micro read-lock over the byte copy (issue #411 action 2), belt-and-
   * suspenders to the after-the-fact detection in `capture` — NOT a
   * replacement for it. A FOREIGN checkpointer (journal.db is multi-process:
   * app-engine workers, the key-admin CLI open it by path) could RESTART or
   * TRUNCATE the WAL mid-copy and reset it under our read. `capture`'s re-stat +
   * header re-read (and `detectForeign`) already CATCH that race after the fact
   * and heal it with a generation break — that detection stays authoritative
   * (action 1's verify-don't-enforce). This eliminates the race BY CONSTRUCTION
   * for the copy's duration: an open WAL read snapshot holds a read mark that no
   * checkpointer in ANY process can reset or truncate past — a foreign TRUNCATE
   * under it returns busy and leaves the bytes AND salts untouched (measured on
   * this runtime before it was relied on).
   *
   * A SEPARATE read-only connection, deliberately NOT the gateway's shared write
   * handle. Two reasons it must be separate: (1) a `readOnly` connection cannot
   * checkpoint — so `wal_autocheckpoint` is moot on it — and node:sqlite runs no
   * `PRAGMA optimize` on close, so it writes NOTHING to the WAL on open or close
   * (verified: `data_version` is unmoved across its open+close); (2) an
   * exception in here can never strand the gateway's write handle inside a
   * transaction, which a `BEGIN` on the shared handle could. The lock lives only
   * for the milliseconds of the copy (this is NOT Litestream's long-held read
   * lock) and MUST be released before the shipper's OWN `truncate` runs, or that
   * TRUNCATE would find our reader and come back busy under its own lock —
   * `capture` and `truncate` are separate calls, and `capture`'s finally always
   * releases first.
   *
   * Acquisition failure (busy open, momentary unavailability) is not fatal:
   * return null and copy WITHOUT the pin — the post-copy detection is the
   * correctness mechanism; the pin is only belt-and-suspenders.
   */
  private acquireWalReadLock(db: WalDbName): { release: () => void } | null {
    let conn: DatabaseSync | undefined;
    try {
      conn = new DatabaseSync(this.dbPath(db), { readOnly: true });
      // `BEGIN` is DEFERRED — it takes no read mark until a read runs. The
      // SELECT is what materializes the snapshot and grabs the WAL read mark
      // that pins the file against a foreign checkpointer's reset/truncate.
      conn.exec('BEGIN');
      conn.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get();
      const held = conn;
      return {
        release: () => {
          // The snapshot ends when the connection closes regardless; ending the
          // transaction first is tidy and drops the read mark immediately.
          try {
            held.exec('ROLLBACK');
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
    } catch (err) {
      try {
        conn?.close();
      } catch {
        /* nothing was acquired */
      }
      this.log.warn(
        `wal-ship: ${db} capture read-lock unavailable ` +
          `(${err instanceof Error ? err.message : String(err)}) — ` +
          `relying on post-copy race detection`,
      );
      return null;
    }
  }

  /**
   * Capture the committed delta `[offset, lastCommitBoundary(head))` into a
   * local segment file. G7 ordering: segment bytes fsync, then state fsync
   * (via the caller's persistState) — after `capture` returns, `offset`
   * only ever names durably-captured bytes.
   */
  private capture(db: WalDbName, stream: DbStreamState, report: WalTickReport): CaptureResult {
    const walPath = this.walPath(db);
    if (!existsSync(walPath)) return { kind: 'ok' };
    const fd = openSync(walPath, 'r');
    let bytes: Buffer;
    let head: number;
    let headerStable = true;
    // Pinned across the byte copy only (see acquireWalReadLock). Released in the
    // finally BEFORE this method returns, so it is never held when the caller
    // later runs the shipper's own TRUNCATE.
    let readLock: { release: () => void } | null = null;
    try {
      head = fstatSync(fd).size;
      stream.lastSize = Math.max(stream.lastSize, head);
      if (head < WAL_HEADER_BYTES) return { kind: 'ok' };
      if (head > MAX_CAPTURE_BYTES) {
        return { kind: 'break', reason: 'wal-exceeds-safe-capture-window' };
      }
      // Acquire the read mark now: after the size checks, before the FIRST read
      // of bytes. A reset in the sliver between the `head` stat and this pin is
      // still caught by the re-stat/header-compare below (a shorter file makes
      // readSync return 0 ⇒ break); the pin closes the far larger window of the
      // multi-syscall copy itself.
      readLock = this.acquireWalReadLock(db);
      bytes = Buffer.alloc(head);
      let at = 0;
      while (at < head) {
        const n = readSync(fd, bytes, at, head - at, at);
        if (n === 0) return { kind: 'break', reason: 'wal-reset-during-capture' };
        at += n;
      }
      const after = fstatSync(fd).size;
      if (after < head) return { kind: 'break', reason: 'wal-reset-during-capture' };
      const headerAfter = Buffer.alloc(WAL_HEADER_BYTES);
      if (readSync(fd, headerAfter, 0, WAL_HEADER_BYTES, 0) !== WAL_HEADER_BYTES) {
        return { kind: 'break', reason: 'wal-reset-during-capture' };
      }
      headerStable = bytes.subarray(0, WAL_HEADER_BYTES).equals(headerAfter);
    } finally {
      closeSync(fd);
      readLock?.release();
    }
    if (!headerStable) return { kind: 'break', reason: 'wal-reset-during-capture' };

    let scan;
    try {
      scan = scanWalPrefix(bytes);
    } catch {
      return { kind: 'break', reason: 'wal-checksum-invalid-before-captured-offset' };
    }
    if (scan.validEndOffset < stream.offset) {
      return { kind: 'break', reason: 'wal-checksum-invalid-before-captured-offset' };
    }
    const header = bytes.subarray(0, WAL_HEADER_BYTES);
    const salts = walSalts(header);
    if (stream.salt1 !== null && (salts.salt1 !== stream.salt1 || salts.salt2 !== stream.salt2)) {
      return { kind: 'break', reason: 'wal-reset-during-capture' };
    }
    stream.salt1 = salts.salt1;
    stream.salt2 = salts.salt2;
    stream.pageSize ??= scan.pageSize;
    const boundary = scan.lastCommitOffset;
    if (boundary <= stream.offset) return { kind: 'ok' };

    const addr: WalSegmentAddress = {
      db,
      generation: stream.generation,
      group: stream.group,
      startOffset: stream.offset,
      endOffset: boundary,
      tickMs: report.tickMs,
    };
    // The local filename IS the object key's basename (+ extension): one
    // codec (wal-format) owns widths and field order for both sides, so
    // the builder and the parsers in listUploadable/startupHygiene can
    // never drift.
    const file = path.join(
      this.groupDir(db, stream.generation, stream.group),
      `${path.posix.basename(walSegmentKey(addr))}.seg`,
    );
    try {
      writeFileDurable(file, bytes.subarray(stream.offset, boundary));
    } catch (err) {
      // G4: the segment did not become durable, so the offset must not move
      // and NOTHING may checkpoint — the WAL keeps the bytes and the
      // failure surfaces as backpressure, not data loss.
      report.errors.push({
        db,
        message: `segment write failed (${err instanceof Error ? err.message : String(err)}) — WAL retained`,
      });
      return { kind: 'error' };
    }
    this.localSegmentBytes += boundary - stream.offset;
    stream.offset = boundary;
    report.shipped.push(walSegmentKey(addr));
    return { kind: 'ok' };
  }

  /**
   * `PRAGMA data_version` — SQLite bumps this whenever a connection OTHER than
   * the one being queried commits to the database, and never for the querying
   * connection's own writes. That asymmetry is exactly what makes it the
   * raced-writer detector, and all three properties were measured on this
   * runtime before it was relied on:
   *   - stable across OUR OWN `wal_checkpoint(TRUNCATE)` — otherwise every
   *     rollover would look like a race and force a whole-database re-base per
   *     group;
   *   - stable across OUR OWN writes — the shipper checkpoints on the very
   *     handles the gateway writes vault.db through, so anything else would
   *     false-positive on every tick;
   *   - BUMPED by a commit from another connection or another process — the
   *     only writers we cannot see any other way (journal.db's subprocess
   *     ledger writers, the key-admin CLI).
   */
  private dataVersion(db: WalDbName): number {
    const row = this.handle(db).prepare('PRAGMA data_version').get() as { data_version: number };
    return row.data_version;
  }

  /**
   * Bring `stream.offset` up to everything the WAL has COMMITTED, and return
   * the `data_version` reading that the TRUNCATE which follows must be checked
   * against. Null means DO NOT TRUNCATE (retry next tick).
   *
   * THE ORDER OF THE TWO READS INSIDE THE LOOP IS THE WHOLE CORRECTNESS
   * ARGUMENT, and it is the easy thing to get backwards. `data_version` is read
   * FIRST, the WAL is stat'd SECOND:
   *   - a commit landing BEFORE the reading makes the file longer than
   *     `offset`, so the stat that follows sees it and we capture it;
   *   - a commit landing AFTER the reading is not in it, so the reading taken
   *     after the checkpoint differs and the fold is DETECTED.
   * Read the stat first and `data_version` second and there is a window between
   * them in which a commit is both invisible to the stat AND already baked into
   * the reading — folded into the main database, zeroed from the WAL, never
   * shipped, never noticed. That is the defect this replaced; do not "simplify"
   * the order back.
   *
   * The loop is only an optimization: a writer that commits while we are
   * mid-capture is far commoner than one that commits inside the checkpoint's
   * lock window, and capturing its frames costs one segment instead of a whole
   * fresh base. When capture stops making progress the WAL's tail is
   * UNCOMMITTED (a rolled-back transaction leaves its frames behind and the
   * next transaction overwrites them in place, so the file's high-water size
   * legitimately outruns `offset` forever) — there is nothing left to ship and
   * the checkpoint cannot destroy committed bytes, so we stop and truncate.
   */
  private settleWal(db: WalDbName, stream: DbStreamState, report: WalTickReport): SettleResult {
    const walPath = this.walPath(db);
    for (let pass = 0; pass < TRUNCATE_SETTLE_PASSES; pass++) {
      const dvBefore = this.dataVersion(db); // BEFORE the stat — see above.
      const foreign = this.detectForeign(db, stream);
      if (foreign) return { kind: 'break', reason: foreign };
      const size = existsSync(walPath) ? statSync(walPath).size : 0;
      if (size <= stream.offset) return { kind: 'ready', dataVersion: dvBefore };
      const offsetBefore = stream.offset;
      const captured = this.capture(db, stream, report);
      if (captured.kind === 'error') return { kind: 'retry' };
      if (captured.kind === 'break') return captured;
      if (stream.offset === offsetBefore) return { kind: 'ready', dataVersion: dvBefore };
    }
    // A writer is committing faster than we can capture. Leaving the WAL
    // untruncated is merely wasteful (it stays large and we retry next tick);
    // truncating without a settled stat would risk folding away committed bytes
    // we never shipped, which is the one thing that is never recoverable.
    this.log.warn(`wal-ship: ${db} WAL will not settle for a checkpoint — retrying next tick`);
    return { kind: 'retry' };
  }

  /**
   * `wal_checkpoint(TRUNCATE)` with a bounded busy wait, bracketed by a
   * `data_version` reading. Returns null when the handle reported busy (a
   * reader/writer held it longer than we're willing to block the event loop —
   * retry next tick; nothing was truncated), else whether a foreign connection
   * committed inside the window.
   *
   * `dvBefore` MUST have been read by the caller BEFORE the evidence it used to
   * conclude the WAL holds nothing past `stream.offset` (see `settleWal`).
   *
   * NOT usable, and both of these were measured rather than assumed:
   *
   *  - the checkpoint's own `checkpointed` frame count. A SUCCESSFUL TRUNCATE
   *    returns `{busy: 0, log: 0, checkpointed: 0}` — it zeroes the WAL and
   *    RESETS both counters — so any comparison of it against what we shipped is
   *    dead code that can never fire. It looks like a hole check and is not one.
   *
   *  - a `wal_checkpoint(FULL)` or `(PASSIVE)` pre-pass to learn the frame count
   *    before truncating. Once FULL has backfilled the WAL, the next writer
   *    RESTARTS it at offset 0 and overwrites the bytes IN PLACE — the file does
   *    not even grow — which silently destroys the append-only byte-offset chain
   *    every segment address in this format is built on. It is precisely the
   *    harmless-looking optimization to reach for here, and it corrupts the
   *    stream.
   */
  private truncate(db: WalDbName, dvBefore: number): TruncateResult | null {
    const handle = this.handle(db);
    const preflightReason = this.state.dbs[db]
      ? (this.detectForeign(db, this.state.dbs[db]!) ?? undefined)
      : undefined;
    handle.exec(`PRAGMA busy_timeout = ${CHECKPOINT_BUSY_MS}`);
    try {
      const row = handle.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number };
      if (row.busy !== 0) return null;
      const size = existsSync(this.walPath(db)) ? statSync(this.walPath(db)).size : 0;
      if (size !== 0) return null; // not fully truncated — treat as busy
      return {
        raced: this.dataVersion(db) !== dvBefore,
        ...(preflightReason !== undefined ? { untrustedReason: preflightReason } : {}),
      };
    } finally {
      handle.exec('PRAGMA busy_timeout = 30000');
    }
  }

  /** Refresh the main-db identity right after a checkpoint we performed. */
  private recordDbStat(db: WalDbName, stream: DbStreamState): void {
    const st = statSync(this.dbPath(db));
    stream.dbSize = st.size;
    stream.dbMtimeMs = st.mtimeMs;
    stream.dbHeaderSha256 = this.dbHeaderSha256(db);
  }

  /**
   * Close the current group: capture the remainder, settle, TRUNCATE, then
   * finish the bookkeeping. Any frames the checkpoint folded that we never
   * shipped ⇒ a break REQUEST — the design's cardinal rule is that a checkpoint
   * never destroys unshipped committed bytes SILENTLY; here it is detected and
   * healed with a fresh base (of BOTH databases — see `coordinatedBreak`).
   */
  private rollover(
    db: WalDbName,
    stream: DbStreamState,
    reasons: Partial<Record<WalDbName, string>>,
    report: WalTickReport,
  ): void {
    const captured = this.capture(db, stream, report);
    if (captured.kind === 'error') return;
    if (captured.kind === 'break') {
      reasons[db] = captured.reason;
      return;
    }
    const settled = this.settleWal(db, stream, report);
    if (settled.kind === 'break') {
      reasons[db] = settled.reason;
      return;
    }
    if (settled.kind === 'retry') {
      // Either the capture failed (the error is already on the report) or the
      // WAL would not settle. Both mean the same thing: do not checkpoint, and
      // do not consider this stream cleanly cut (`close()` reads `busy`).
      report.busy.push(db);
      return;
    }
    const result = this.truncate(db, settled.dataVersion);
    if (result === null) {
      report.busy.push(db);
      return;
    }
    this.finishTruncate(db, stream, result, reasons, report, { trusted: true });
    // Narrow the crash window between "WAL truncated" and "state knows":
    // a crash inside it is detected on restart (shrunken WAL ⇒ generation
    // break), so persisting immediately merely makes that rare.
    this.persistState();
  }

  /**
   * The post-TRUNCATE half of a rollover, extracted because the aborted
   * coordinated break has to reuse it: once a WAL is truncated, its
   * bookkeeping MUST catch up or the next tick reads a fresh WAL from a stale
   * offset. Two decisions live here.
   *
   * The raced-writer check (`result.raced`, from the `data_version` bracket in
   * `truncate`): a connection other than ours committed between the reading that
   * proved the WAL held nothing past `offset` and the checkpoint's writer lock.
   * Its frames were appended past `offset`, folded into the main file, and
   * ZEROED from the WAL — we cannot ship them and cannot get them back. That is
   * the hole, and it is healed by a fresh base (the clone reads the main file,
   * which is exactly where those commits now live), never papered over.
   *
   * `trusted`: whether this stream's own `offset` still describes the real WAL.
   * A CONDEMNED stream (a detector fired, or a writer just raced us) must not
   * get a group closer: the closer asserts "group N ends at exactly `offset`"
   * and a restore trusts it absolutely, so writing one over folded-away frames
   * would be a forgery. It is frozen instead — `breakPending` blocks every
   * further capture, so no group N+1 can ever exist to be walled off.
   */
  private finishTruncate(
    db: WalDbName,
    stream: DbStreamState,
    result: TruncateResult,
    reasons: Partial<Record<WalDbName, string>>,
    report: WalTickReport,
    opts: { trusted: boolean },
  ): void {
    const raced = result.raced;
    if (result.untrustedReason !== undefined) reasons[db] = result.untrustedReason;
    if (raced) {
      this.log.warn(
        `wal-ship: ${db} checkpoint raced a foreign writer (data_version moved across the ` +
          `TRUNCATE) — its committed frames may have been folded into the main database ` +
          `unshipped; breaking generation`,
      );
      reasons[db] = 'checkpoint-raced-writer';
    }
    if (opts.trusted && !raced && result.untrustedReason === undefined && stream.offset > 0) {
      // Closer first, then advance: replay only ever crosses a group
      // boundary through this marker, so a group counter that advanced
      // without one would silently wall off everything after it. Filename
      // derives from the object-key codec (see capture()).
      const closerKey = walGroupCloserKey({
        db,
        generation: stream.generation,
        group: stream.group,
        endOffset: stream.offset,
      });
      writeFileDurable(
        path.join(
          this.groupDir(db, stream.generation, stream.group),
          `${path.posix.basename(closerKey)}.mrk`,
        ),
        new Uint8Array(0),
      );
      report.rolled.push({ db, group: stream.group, endOffset: stream.offset });
      stream.group += 1;
      stream.offset = 0;
    }
    // A truncate with nothing shipped (offset 0 — the WAL held only
    // uncommitted/rolled-back frames) keeps the SAME group: no closer
    // exists for it, and an advance would make later groups unreachable.
    stream.lastSize = 0;
    stream.salt1 = null;
    stream.salt2 = null;
    this.recordDbStat(db, stream);
  }

  /**
   * Re-base BOTH databases in ONE tick. The single most order-sensitive
   * function in the feature.
   *
   * When EITHER database needs a fresh generation, BOTH get one. Two bases from
   * two different instants have no coordinated restore point between them: a
   * journal base minted after the vault's already contains receipts for rows
   * that live only in the vault's SEGMENTS, so losing one of those segments
   * hands back history asserting data the restore does not have. Coordinated
   * bases give every degradation somewhere safe to land — the base pair is
   * itself one instant.
   *
   * The order, and why each half of it is load-bearing:
   *
   * 1. Journal's TRUNCATE first. A base's effective instant is its TRUNCATE
   *    instant, NOT its `copyFileSync` instant — the clone reads the MAIN file,
   *    and everything committed after the truncate lands in the new
   *    generation's WAL and ships as segments. With journal cut at t1 and vault
   *    at t2 > t1: no vault row can commit in [t1, t2) at all (the tick body is
   *    synchronous over a synchronous `node:sqlite`, and the gateway's command
   *    pipeline is vault.db's only writer — I1), so base(vault) == vault@t1.
   *    Every receipt in base(journal) committed at or before t1, and receipts
   *    commit only AFTER their vault transaction, so every row they name is in
   *    base(vault). A dangling receipt is not constructible. Code that
   *    carefully clones the journal first while truncating the vault first
   *    looks right and is ordered WRONG.
   *
   * 2. BOTH truncates before EITHER clone. Not for the ordering proof (either
   *    interleaving is safe under I1) but for the BUSY ABORT: `truncate()`
   *    returns null on a busy handle, and a break that has already cloned
   *    cannot be undone. Discovering the vault's busy-ness after cloning the
   *    journal would strand exactly the uncoordinated pair this exists to
   *    forbid.
   *
   * 3. The generation receipts LAST, after both clones. `writeReceipt` commits
   *    to journal.db; one landing between the two truncates would be a journal
   *    write the vault's base could not account for. (It is harmless today only
   *    because its `objectId` is null and `restore-check.ts` filters those out
   *    — do not lean on that.)
   *
   * Every step is SYNCHRONOUS. One `await` in here and the "no vault commit can
   * interleave" argument evaporates, silently, with every test still green.
   */
  private coordinatedBreak(
    reasons: Partial<Record<WalDbName, string>>,
    report: WalTickReport,
  ): void {
    if (WAL_CAPTURE_ORDER.every((db) => reasons[db] === undefined)) return;
    const trigger = WAL_CAPTURE_ORDER.find((db) => reasons[db] !== undefined)!;
    for (const db of WAL_CAPTURE_ORDER) reasons[db] ??= `coordinated:${reasons[trigger]!}`;

    const truncated: Partial<Record<WalDbName, TruncateResult>> = {};
    for (const db of WAL_CAPTURE_ORDER) {
      // The `data_version` reading is taken here rather than in `settleWal`: a
      // breaking stream may be CONDEMNED, and a condemned stream must not ship
      // another byte, so there is no settling to do. The bracket still covers
      // the checkpoint's own lock window, which is what the ABORT path needs —
      // `abortBreak` may complete a trusted stream as an ordinary rollover, and
      // it must not write a group closer over frames a racer got folded away.
      // On the success path below nothing is closed (the fresh base clone IS the
      // history), so `raced` there is simply moot.
      const result = this.truncate(db, this.dataVersion(db));
      if (result === null) {
        report.busy.push(db);
        this.abortBreak(db, reasons, truncated, report);
        return;
      }
      truncated[db] = result;
    }
    const olds = { vault: this.state.dbs.vault, journal: this.state.dbs.journal };
    for (const db of WAL_CAPTURE_ORDER) this.mintBase(db, reasons[db]!, report);
    if (olds.vault && olds.journal && olds.vault.basePending && olds.journal.basePending) {
      // The retired pair was never registered ⇒ never restorable ⇒ its pair
      // markers are dead weight, exactly like its segments.
      this.dropLocalMarkers(olds.vault.generation, olds.journal.generation);
    }
    this.persistState();
    for (const db of WAL_CAPTURE_ORDER) this.emitBreakReceipt(db, reasons[db]!);
  }

  /**
   * `truncate(busy)` came back busy after its predecessor in WAL_CAPTURE_ORDER
   * had already truncated. Nothing has been CLONED (which is exactly why both
   * truncates precede both clones), so no uncoordinated base pair can escape —
   * but a WAL that did truncate is empty now and its stream has to be tidied,
   * and both streams are FROZEN (`breakPending`) until the break lands next
   * tick. Nothing irreversible; the pair the gateway can still register is the
   * old, coordinated one.
   */
  private abortBreak(
    busy: WalDbName,
    reasons: Partial<Record<WalDbName, string>>,
    truncated: Partial<Record<WalDbName, TruncateResult>>,
    report: WalTickReport,
  ): void {
    for (const db of WAL_CAPTURE_ORDER) {
      const result = truncated[db];
      const stream = this.state.dbs[db];
      if (result === undefined || !stream) continue;
      // A partial pair break can never authenticate a group end. Even when
      // this stream looked healthy before TRUNCATE, the sibling did not cut,
      // so a closer here would certify a one-sided instant.
      this.finishTruncate(db, stream, result, reasons, report, { trusted: false });
    }
    // AFTER finishTruncate — it may have upgraded a reason to
    // `checkpoint-raced-writer`, and that is the reason the retry must carry.
    for (const db of WAL_CAPTURE_ORDER) {
      const stream = this.state.dbs[db];
      if (stream) stream.breakPending = reasons[db]!;
    }
    this.log.warn(
      `wal-ship: coordinated generation break DEFERRED — ${busy}'s checkpoint is busy ` +
        `(reason: ${reasons[busy]}); both streams are frozen until the retry lands`,
    );
    this.persistState();
  }

  /**
   * Clone one database's WAL-quiet main file as the base of a fresh generation
   * (reflink where the filesystem supports it — the main file is immutable
   * until our next checkpoint, so even a slow plain copy reads a stable file),
   * hash it, and reset the stream. `baseCreatedAtMs` is the TICK, identical for
   * both databases: that equality IS the coordination the manifest carries as
   * `baseTickMs` and the restore asserts.
   *
   * The caller has already TRUNCATED both databases. `copyFileSync` and
   * `sha256File` are synchronous on purpose — see `coordinatedBreak`.
   */
  private mintBase(db: WalDbName, reason: string, report: WalTickReport): void {
    const old = this.state.dbs[db];
    const generation = newWalGeneration(this.random);
    const baseName = path.join('bases', db, `${generation}.db`);
    const baseAbs = this.basePath(baseName);
    mkdirSync(path.dirname(baseAbs), { recursive: true });
    cloneDbFile(this.dbPath(db), baseAbs);
    const fd = openSync(baseAbs, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDirBestEffort(path.dirname(baseAbs));
    const sha256 = sha256File(baseAbs);
    const dbStat = statSync(this.dbPath(db));
    this.state.dbs[db] = {
      generation,
      group: 0,
      offset: 0,
      lastSize: 0,
      salt1: null,
      salt2: null,
      pageSize: old?.pageSize ?? null,
      dbSize: dbStat.size,
      dbMtimeMs: dbStat.mtimeMs,
      dbHeaderSha256: this.dbHeaderSha256(db),
      baseName,
      ...(old ? { retiredBaseName: old.baseName } : {}),
      baseCreatedAtMs: report.tickMs,
      baseSha256: sha256,
      basePending: true,
      closedClean: false,
    };
    report.breaks.push({ db, reason });
    this.log.info(`wal-ship: ${db} generation break (${reason}) → ${generation}`);
    if (old) {
      if (old.basePending) {
        // Never uploaded ⇒ the old generation was never restorable; its
        // local segments are dead weight.
        this.dropLocalGeneration(db, old.generation);
      }
      // The grandparent's base retires now; `old`'s clone stays one break
      // longer (see retiredBaseName — an in-flight snapshot may be reading it).
      if (old.retiredBaseName !== undefined) {
        rmSync(this.basePath(old.retiredBaseName), { force: true });
      }
    }
  }

  /** The break's consent receipt — a journal.db write, so: after BOTH clones. */
  private emitBreakReceipt(db: WalDbName, reason: string): void {
    const stream = this.state.dbs[db]!;
    try {
      writeReceipt(this.db.journal, {
        grantId: null,
        invocationId: null,
        action: 'act consent.backup_wal_generation',
        objectType: 'core.vault',
        objectId: null,
        purpose: null,
        decision: 'allow',
        detail: { db, reason, generation: stream.generation, baseSha256: stream.baseSha256 },
      });
    } catch (err) {
      this.log.warn(
        `wal-ship: generation receipt failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  /**
   * The end-of-tick pair marker (FORMAT.md § WAL segments): what BOTH databases
   * had shipped when the tick ended, sealed by the shipper.
   *
   * Written LAST, after captures, rollovers AND the coordinated break, because
   * it must describe where the tick actually ENDED. A marker recording the
   * journal's post-tick position beside the vault's pre-tick one is a lie that
   * makes every later restore walk back a tick.
   *
   * Exactly ONE marker per (vaultGeneration, journalGeneration, tick): the
   * object's nonce derives from that triple, so two DIFFERENT payloads under it
   * would reuse a (key, nonce) pair — GCM's one fatal sin. Writing it once, at
   * the end, is what guarantees that; and because the local file's path IS that
   * triple, a tick re-run after a crash overwrites it in place, so a second
   * ciphertext for one key can never reach the provider.
   *
   * Two ticks need no marker at all:
   *  - one where nothing moved (restoring "at T" is identical to restoring at
   *    the last marker ≤ T), and
   *  - one that ended in a BREAK, which leaves both databases at (0, 0) of
   *    fresh generations — that IS their base pair, the floor a restore already
   *    falls back to when no marker is satisfiable.
   * The cost of the second is that the RETIRING pair never gets a marker for
   * its final tick, so its last tick's segments are unusable. That is one tick
   * of PITR depth on a generation being replaced anyway — paid to keep the
   * once-per-key write property airtight.
   */
  private writePairMarker(report: WalTickReport): void {
    // A marker is a proof about BOTH cuts. Any per-db error, busy checkpoint,
    // or generation break means this tick did not establish such a proof.
    if (report.errors.length > 0 || report.busy.length > 0 || report.breaks.length > 0) return;
    if (report.shipped.length === 0 && report.rolled.length === 0) return;
    const vault = this.state.dbs.vault;
    const journal = this.state.dbs.journal;
    if (!vault || !journal) return;
    const position = (s: DbStreamState): WalPairPosition => ({
      group: s.group,
      endOffset: s.offset,
    });
    const marker: WalPairMarker = {
      vaultGeneration: vault.generation,
      journalGeneration: journal.generation,
      tickMs: report.tickMs,
      vault: position(vault),
      journal: position(journal),
    };
    const atFloor = (p: WalPairPosition): boolean => p.group === 0 && p.endOffset === 0;
    if (atFloor(marker.vault) && atFloor(marker.journal)) return;
    const key = walPairMarkerKey(marker);
    writeFileDurable(
      path.join(
        this.markerDir(marker.vaultGeneration, marker.journalGeneration),
        `${path.posix.basename(key)}.tick`,
      ),
      new TextEncoder().encode(
        JSON.stringify({
          v: 1,
          tickMs: marker.tickMs,
          vault: marker.vault,
          journal: marker.journal,
        }),
      ),
    );
    report.markers.push(key);
  }

  /** Delete one generation's local segment tree, keeping the byte counter exact. */
  private dropLocalGeneration(db: WalDbName, generation: string): void {
    const dir = path.join(this.dir, 'segments', db, generation);
    this.localSegmentBytes -= this.walkSegmentBytes(dir);
    if (this.localSegmentBytes < 0) this.localSegmentBytes = 0;
    rmSync(dir, { recursive: true, force: true });
  }

  /** Delete one BASE PAIR's local markers (markers are pair-scoped, not per-db). */
  private dropLocalMarkers(vaultGeneration: string, journalGeneration: string): void {
    rmSync(this.markerDir(vaultGeneration, journalGeneration), { recursive: true, force: true });
  }

  /**
   * Local disk budget (design Q4): while offline, segments accumulate. Over
   * budget ⇒ trade PITR depth for disk — break both generations (fresh
   * bases) and DROP the superseded generations' local segments, registered
   * or not. Registered generations keep whatever already drained to the
   * provider (restore lands on the last drained point); the undrained tail
   * is the price of the budget — but the space MUST actually free, or this
   * fires again every tick: a per-minute break is a whole-DB copy per
   * minute, the exact wear cliff this feature exists to delete.
   */
  private enforceLocalBudget(report: WalTickReport): void {
    if (this.localBudgetBytes <= 0) return;
    // Segments only (the incremental counter): the base clones are pinned
    // by design (≤ 2 per db, reflink-cheap) — counting them would make an
    // over-budget vault mint a fresh base every tick without ever freeing
    // anything (thrash).
    if (this.localSegmentBytes <= this.localBudgetBytes) return;
    this.log.warn(
      `wal-ship: local segments ${this.localSegmentBytes} bytes exceed budget ` +
        `${this.localBudgetBytes} — rolling generations (PITR history traded for disk)`,
    );
    // WAL_CAPTURE_ORDER, not WAL_DB_NAMES (which is vault-first — the WRONG
    // order): the break this requests cuts the journal before the vault.
    const olds: Partial<Record<WalDbName, string>> = {};
    const reasons: Partial<Record<WalDbName, string>> = {};
    for (const db of WAL_CAPTURE_ORDER) {
      const stream = this.state.dbs[db];
      if (!stream) continue;
      olds[db] = stream.generation;
      reasons[db] = 'local-budget';
    }
    this.coordinatedBreak(reasons, report);
    for (const db of WAL_CAPTURE_ORDER) {
      const old = olds[db];
      const fresh = this.state.dbs[db];
      if (old !== undefined && fresh && fresh.generation !== old) {
        // The break itself only drops never-registered history; the budget
        // path must free REGISTERED generations' local files too (see doc).
        this.dropLocalGeneration(db, old);
      }
    }
    if (olds.vault !== undefined && olds.journal !== undefined) {
      this.dropLocalMarkers(olds.vault, olds.journal);
    }
  }

  // ------------------------------------------------------- controlled points

  /**
   * A controlled checkpoint of both databases (replaces `checkpointVault`
   * while a shipper owns the WALs): ship the remainder, then TRUNCATE with
   * the same raced-writer verification as a rollover.
   */
  checkpointNow(): WalTickReport {
    if (this.closed) throw new Error('WalShipper is closed');
    const report = this.newReport();
    const reasons = this.resolveBreakReasons();
    for (const db of WAL_CAPTURE_ORDER) {
      if (reasons[db] !== undefined) continue;
      this.rollover(db, this.state.dbs[db]!, reasons, report);
    }
    this.coordinatedBreak(reasons, report);
    this.writePairMarker(report);
    this.persistState();
    return report;
  }

  /**
   * Explicit generation roll (journal archival, backup-enable transition,
   * restore-takeover, tests). By default the old generation's pending
   * committed bytes ship first so its PITR history is maximal;
   * `captureFirst: false` skips that — the journal-archival hook uses it
   * because the WAL at that point holds the archival VACUUM's whole-database
   * rewrite, and shipping a DB-sized burst into a generation whose next
   * event is its own retirement would be pure waste (the fresh base already
   * contains every byte of it).
   */
  rollGeneration(
    db: WalDbName,
    reason: string,
    opts: { captureFirst?: boolean } = {},
  ): WalTickReport {
    if (this.closed) throw new Error('WalShipper is closed');
    const report = this.newReport();
    const reasons = this.resolveBreakReasons();
    // Whatever the detectors already condemned must not ship another byte,
    // whatever the caller wants.
    const condemned = new Set(WAL_CAPTURE_ORDER.filter((d) => reasons[d] !== undefined));
    reasons[db] ??= reason;
    for (const other of WAL_CAPTURE_ORDER) reasons[other] ??= `coordinated:${reason}`;
    // Both streams ship their pending committed bytes under their OLD
    // generation first, so PITR history stays maximal across the roll.
    // `captureFirst: false` skips that for the NAMED database only: the
    // journal-archival hook uses it because the WAL at that moment holds the
    // archival VACUUM's whole-database rewrite, and shipping a DB-sized burst
    // into a generation whose next event is its own retirement is pure waste
    // (the fresh base already contains every byte of it). The SIBLING's WAL
    // holds no such thing, so it always ships — a journal-archival roll now
    // re-bases the vault too, and losing the vault's pending bytes with it
    // would be a needless gap.
    for (const target of WAL_CAPTURE_ORDER) {
      if (condemned.has(target)) continue;
      if (target === db && opts.captureFirst === false) continue;
      const stream = this.state.dbs[target];
      // A stream holed by capture-then-discard ships nothing either: its
      // captured files were DELETED, so more bytes only widen a hole in a
      // generation whose very next event is its retirement.
      if (stream && stream.discarded !== true) {
        const captured = this.capture(target, stream, report);
        if (captured.kind === 'break') reasons[target] = captured.reason;
      }
    }
    this.coordinatedBreak(reasons, report);
    this.writePairMarker(report);
    this.persistState();
    return report;
  }

  /**
   * Final ship + truncate, then mark the streams clean so the reopen path
   * knows SQLite's own close-checkpoint (of an EMPTY wal) and fresh salts
   * are expected, not foreign. Call before `db.close({ skipOptimize: true })`
   * — `PRAGMA optimize` runs HERE, before the final checkpoint, because its
   * ANALYZE writes land in the WAL: were they still there at handle close,
   * SQLite's close-checkpoint would fold them into the main file behind our
   * back and every restart would look like a foreign checkpoint (a spurious
   * generation break per restart). The main-db identity check deliberately
   * stays ACTIVE across restarts: any commit that races the window between
   * this checkpoint and the handle close gets folded by the close-checkpoint
   * and is thereby DETECTED on reopen — degraded to a fresh base, never a
   * silent gap.
   */
  close(): WalTickReport {
    for (const db of WAL_DB_NAMES) {
      try {
        this.handle(db).exec('PRAGMA optimize');
      } catch {
        // Best-effort maintenance, mirroring VaultDb.close().
      }
    }
    const report = this.checkpointNow();
    for (const db of WAL_DB_NAMES) {
      const stream = this.state.dbs[db];
      if (stream && !report.busy.includes(db)) stream.closedClean = true;
    }
    this.persistState();
    this.closed = true;
    return report;
  }

  // ------------------------------------------------------------ upload seam

  /** Every durable local file awaiting upload, oldest generation first. */
  listUploadable(): UploadableWalFile[] {
    const out: UploadableWalFile[] = [];
    const segRoot = path.join(this.dir, 'segments');
    if (!existsSync(segRoot)) return out;
    // Shape-check every level: a stray plain file (Finder's .DS_Store, an
    // editor swap file) must be skipped, not readdirSync'd — one ENOTDIR
    // here would wedge the drain for this vault forever.
    const dirsIn = (dir: string, re: RegExp): string[] =>
      readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && re.test(e.name))
        .map((e) => e.name)
        .sort();
    for (const db of WAL_DB_NAMES) {
      const dbRoot = path.join(segRoot, db);
      if (!existsSync(dbRoot)) continue;
      for (const generation of dirsIn(dbRoot, /^[0-9a-f]{32}$/)) {
        const genRoot = path.join(dbRoot, generation);
        for (const groupName of dirsIn(genRoot, /^\d{8}$/)) {
          const groupRoot = path.join(genRoot, groupName);
          const group = Number.parseInt(groupName, 10);
          for (const name of readdirSync(groupRoot).sort()) {
            const full = path.join(groupRoot, name);
            const addr = this.parseSegmentFileName(db, generation, group, name);
            if (addr) {
              out.push({
                file: full,
                key: walSegmentKey(addr),
                kind: 'segment',
                addr,
                bytes: statSync(full).size,
              });
              continue;
            }
            if (name.endsWith('.mrk')) {
              const closer = parseWalCloserKey(
                `wal/${db}/${generation}/${groupName}/${name.slice(0, -4)}`,
              );
              if (closer) {
                out.push({
                  file: full,
                  key: walGroupCloserKey(closer),
                  kind: 'closer',
                  closer,
                  bytes: 0,
                });
              }
            }
          }
        }
      }
    }
    // Pair markers LAST — so a tick's marker always drains after the segments
    // and closers it describes. Not a correctness requirement (an orphan marker
    // is merely unsatisfiable, which walks the restore back safely) but the
    // reverse order would cost a tick of RPO on every interrupted drain.
    const markerRoot = path.join(this.dir, 'markers');
    if (existsSync(markerRoot)) {
      for (const pair of dirsIn(markerRoot, /^[0-9a-f]{32}-[0-9a-f]{32}$/)) {
        const pairDir = path.join(markerRoot, pair);
        const vaultGeneration = pair.slice(0, 32);
        const journalGeneration = pair.slice(33);
        for (const name of readdirSync(pairDir).sort()) {
          if (!name.endsWith('.tick')) continue;
          const tickMs = Number.parseInt(name.slice(0, -5), 10);
          if (!Number.isInteger(tickMs)) continue;
          const full = path.join(pairDir, name);
          let payload: { vault?: WalPairPosition; journal?: WalPairPosition };
          try {
            payload = JSON.parse(readFileSync(full, 'utf8')) as typeof payload;
          } catch {
            continue; // unreadable residue — never a reason to wedge the drain
          }
          if (!payload.vault || !payload.journal) continue;
          const marker: WalPairMarker = {
            vaultGeneration,
            journalGeneration,
            tickMs,
            vault: payload.vault,
            journal: payload.journal,
          };
          out.push({ file: full, key: walPairMarkerKey(marker), kind: 'marker', marker, bytes: 0 });
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
   * Captured files of this database were deleted WITHOUT upload (backup
   * unconfigured — capture-then-discard). Marks the stream holed; the
   * BackupService breaks the generation before ever registering its base,
   * because a restore of a holed stream silently lands on the stale base.
   */
  noteStreamDiscarded(db: WalDbName): void {
    const stream = this.state.dbs[db];
    if (stream && !stream.discarded) {
      stream.discarded = true;
      this.persistState();
    }
  }

  /** Streams holed by capture-then-discard — roll these before registering. */
  discardedStreams(): WalDbName[] {
    return WAL_DB_NAMES.filter((db) => this.state.dbs[db]?.discarded === true);
  }

  /** Bases whose generation still needs a registered snapshot. */
  pendingBases(): PendingBase[] {
    const out: PendingBase[] = [];
    for (const db of WAL_DB_NAMES) {
      const stream = this.state.dbs[db];
      if (stream?.basePending) {
        out.push({
          db,
          generation: stream.generation,
          file: this.basePath(stream.baseName),
          sha256: stream.baseSha256,
          createdAtMs: stream.baseCreatedAtMs,
        });
      }
    }
    return out;
  }

  /** Every current base (for manifest assembly), pending or not. */
  currentBases(): PendingBase[] {
    const out: PendingBase[] = [];
    for (const db of WAL_DB_NAMES) {
      const stream = this.state.dbs[db];
      if (stream) {
        out.push({
          db,
          generation: stream.generation,
          file: this.basePath(stream.baseName),
          sha256: stream.baseSha256,
          createdAtMs: stream.baseCreatedAtMs,
        });
      }
    }
    return out;
  }

  /**
   * Are the two current bases a coherent pair — both present, cloned in ONE
   * tick, with no break mid-flight? A snapshot MUST NOT be registered when this
   * is false: a manifest pairing bases from two instants is not restorable
   * without risking a journal that is newer than its vault.
   */
  basesCoordinated(): boolean {
    const vault = this.state.dbs.vault;
    const journal = this.state.dbs.journal;
    return (
      vault !== undefined &&
      journal !== undefined &&
      vault.breakPending === undefined &&
      journal.breakPending === undefined &&
      vault.baseCreatedAtMs === journal.baseCreatedAtMs
    );
  }

  /** The gateway registered a snapshot anchoring this generation's base. */
  noteBaseRegistered(db: WalDbName, generation: string): void {
    const stream = this.state.dbs[db];
    if (stream && stream.generation === generation) {
      stream.basePending = false;
      this.persistState();
    }
  }

  status(): {
    dbs: Partial<
      Record<WalDbName, { generation: string; group: number; offset: number; basePending: boolean }>
    >;
    localBytes: number;
  } {
    const localBytes = this.localSegmentBytes;
    const dbs: ReturnType<WalShipper['status']>['dbs'] = {};
    for (const db of WAL_DB_NAMES) {
      const s = this.state.dbs[db];
      if (s) {
        dbs[db] = {
          generation: s.generation,
          group: s.group,
          offset: s.offset,
          basePending: s.basePending,
        };
      }
    }
    return { dbs, localBytes };
  }
}
