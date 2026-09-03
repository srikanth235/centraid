// governance: allow-repo-hygiene file-size-limit (#408) the WAL capture loop is one correctness argument — detectors, capture, rollover, generation lifecycle and crash-ordering rules all lean on each other's invariants; splitting them would scatter the proof across files that only ever change together

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
  dir?: string;
  walSizeThresholdBytes?: number | (() => number);
  baseIntervalMs?: number | (() => number);
  localBudgetBytes?: number;
  now?: () => number;
  random?: (n: number) => Uint8Array;
  log?: WalShipperLogger;
}

interface DbStreamState {
  generation: string;
  group: number;
  offset: number;
  lastSize: number;
  salt1: number | null;
  salt2: number | null;
  pageSize: number | null;
  dbSize: number;
  dbMtimeMs: number;
  dbHeaderSha256: string;
  baseName: string;
  retiredBaseName?: string;
  baseCreatedAtMs: number;
  baseSha256: string;
  basePending: boolean;
  closedClean: boolean;
  discarded?: boolean;
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
  lastTickMs: number;
  stream?: DbStreamState;
  foreignCheckpointCount?: number;
  lastForeignCheckpoint?: { atMs: number; reason: string };
}

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
  shipped: string[];
  rolled: { group: number; endOffset: number }[];
  breaks: { reason: string }[];
  markers: string[];
  busy: boolean;
  errors: { message: string }[];
}

export interface UploadableWalFile {
  file: string;
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
const CHECKPOINT_BUSY_MS = 250;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const TRUNCATE_SETTLE_PASSES = 8;
const noopLog: Required<WalShipperLogger> = {
  info: () => undefined,
  warn: () => undefined,
};
const reflinkCapability = new Map<string, boolean>();

function reflinkDeviceKey(src: string, dst: string): string {
  return `${process.platform}:${statSync(src).dev}:${statSync(path.dirname(dst)).dev}`;
}

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
    // Intentionally empty.
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

  private loadState(): ShipperState {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.stateFile, "utf8"));
      if (isShipperState(parsed)) {
        this.stateRecovered = true;
        return parsed;
      }
    } catch {
      // Intentionally empty.
    }
    return { version: 1, lastTickMs: 0 };
  }

  private persistState(): void {
    const tmp = `${this.stateFile}.tmp`;
    try {
      writeFileDurable(
        tmp,
        new TextEncoder().encode(`${JSON.stringify(this.state, null, 2)}\n`)
      );
      renameSync(tmp, this.stateFile);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
    fsyncDirBestEffort(this.dir);
  }

  private startupHygiene(): void {
    if (!this.stateRecovered) {
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

  private markerDir(generation: string): string {
    return path.join(this.dir, "markers", generation);
  }

  private nextTickMs(): number {
    const t = Math.max(this.now(), this.state.lastTickMs + 1);
    this.state.lastTickMs = t;
    return t;
  }

  private newReport(): WalTickReport {
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
          if (report.tickMs - stream.baseCreatedAtMs >= this.baseIntervalMs()) {
            reason = "base-cadence";
          } else if (stream.lastSize > this.threshold()) {
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

  private resolveBreakReason(): string | undefined {
    const stream = this.state.stream;
    if (!stream) return "first-run";
    if (stream.breakPending !== undefined) return stream.breakPending;
    if (stream.closedClean) {
      stream.closedClean = false;
      stream.salt1 = null;
      stream.salt2 = null;
      stream.lastSize = 0;
    }
    return this.detectForeign(stream) ?? undefined;
  }

  private detectForeign(stream: DbStreamState): string | null {
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

  private acquireWalReadLock(): { release: () => void } | null {
    let conn: DatabaseSync | undefined;
    try {
      conn = new DatabaseSync(this.dbPath(), { readOnly: true });
      conn.exec("BEGIN");
      conn.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get();
      const held = conn;
      return {
        release: () => {
          try {
            held.exec("ROLLBACK");
          } catch {
            // Intentionally empty.
          }
          try {
            held.close();
          } catch {
            // Intentionally empty.
          }
        },
      };
    } catch (error) {
      try {
        conn?.close();
      } catch {
        // Intentionally empty.
      }
      this.log.warn(
        `wal-ship: capture read-lock unavailable ` +
          `(${error instanceof Error ? error.message : String(error)}) — ` +
          `relying on post-copy race detection`
      );
      return null;
    }
  }

  private capture(stream: DbStreamState, report: WalTickReport): CaptureResult {
    const walPath = this.walPath();
    if (!existsSync(walPath)) return { kind: "ok" };
    const fd = openSync(walPath, "r");
    let bytes: Buffer;
    let head: number;
    let headerStable = true;
    let readLock: { release: () => void } | null = null;
    try {
      head = fstatSync(fd).size;
      stream.lastSize = Math.max(stream.lastSize, head);
      if (head < WAL_HEADER_BYTES) return { kind: "ok" };
      if (head > MAX_CAPTURE_BYTES) {
        return { kind: "break", reason: "wal-exceeds-safe-capture-window" };
      }
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
    const file = path.join(
      this.groupDir(stream.generation, stream.group),
      `${path.posix.basename(walSegmentKey(addr))}.seg`
    );
    try {
      writeFileDurable(file, bytes.subarray(stream.offset, boundary));
    } catch (error) {
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

  private dataVersion(): number {
    const row = this.db.vault.prepare("PRAGMA data_version").get() as {
      data_version: number;
    };
    return row.data_version;
  }

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
    this.log.warn(
      "wal-ship: WAL will not settle for a checkpoint — retrying next tick"
    );
    return { kind: "retry" };
  }

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

  private recordDbStat(stream: DbStreamState): void {
    const st = statSync(this.dbPath());
    stream.dbSize = st.size;
    stream.dbMtimeMs = st.mtimeMs;
    stream.dbHeaderSha256 = this.dbHeaderSha256();
  }

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
    this.persistState();
    return reason;
  }

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
    stream.lastSize = 0;
    stream.salt1 = null;
    stream.salt2 = null;
    this.recordDbStat(stream);
    return reason;
  }

  private breakGeneration(reason: string, report: WalTickReport): void {
    const result = this.truncate(this.dataVersion());
    if (result === null) {
      report.busy = true;
      this.deferBreak(reason);
      return;
    }
    const old = this.state.stream;
    this.mintBase(reason, report);
    if (FOREIGN_CHECKPOINT_REASONS.has(reason)) {
      this.state.foreignCheckpointCount =
        (this.state.foreignCheckpointCount ?? 0) + 1;
      this.state.lastForeignCheckpoint = { atMs: report.tickMs, reason };
    }
    if (old?.basePending) {
      this.dropLocalMarkers(old.generation);
    }
    this.persistState();
    this.emitBreakReceipt(reason);
  }

  private deferBreak(reason: string): void {
    const stream = this.state.stream;
    if (stream) stream.breakPending = reason;
    this.log.warn(
      `wal-ship: generation break DEFERRED — the checkpoint is busy ` +
        `(reason: ${reason}); the stream is frozen until the retry lands`
    );
    this.persistState();
  }

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
        this.dropLocalGeneration(old.generation);
      }
      if (old.retiredBaseName !== undefined) {
        rmSync(this.basePath(old.retiredBaseName), { force: true });
      }
    }
  }

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

  private writeTickMarker(report: WalTickReport): void {
    if (report.errors.length > 0 || report.busy || report.breaks.length > 0)
      return;
    if (report.shipped.length === 0 && report.rolled.length === 0) return;
    const stream = this.state.stream;
    if (!stream) return;
    const position: WalStreamPosition = {
      group: stream.group,
      endOffset: stream.offset,
    };
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

  private dropLocalGeneration(generation: string): void {
    const dir = path.join(this.dir, "segments", generation);
    this.localSegmentBytes -= this.walkSegmentBytes(dir);
    if (this.localSegmentBytes < 0) this.localSegmentBytes = 0;
    rmSync(dir, { recursive: true, force: true });
  }

  private dropLocalMarkers(generation: string): void {
    rmSync(this.markerDir(generation), { recursive: true, force: true });
  }

  private enforceLocalBudget(report: WalTickReport): void {
    if (this.localBudgetBytes <= 0) return;
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
      this.dropLocalGeneration(old);
      this.dropLocalMarkers(old);
    }
  }

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

  rollGeneration(
    reason: string,
    opts: { captureFirst?: boolean } = {}
  ): WalTickReport {
    if (this.closed) throw new Error("WalShipper is closed");
    const report = this.newReport();
    let effective = this.resolveBreakReason() ?? reason;
    const stream = this.state.stream;
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

  close(): WalTickReport {
    try {
      this.db.vault.exec("PRAGMA optimize");
    } catch {
      // Intentionally empty.
    }
    const report = this.checkpointNow();
    const stream = this.state.stream;
    if (stream && !report.busy) stream.closedClean = true;
    this.persistState();
    this.closed = true;
    return report;
  }

  listUploadable(): UploadableWalFile[] {
    const out: UploadableWalFile[] = [];
    const segRoot = path.join(this.dir, "segments");
    if (!existsSync(segRoot)) return out;
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

  noteUploaded(item: UploadableWalFile): void {
    rmSync(item.file, { force: true });
    this.localSegmentBytes -= item.bytes;
    if (this.localSegmentBytes < 0) this.localSegmentBytes = 0;
  }

  noteStreamDiscarded(): void {
    const stream = this.state.stream;
    if (stream && !stream.discarded) {
      stream.discarded = true;
      this.persistState();
    }
  }

  streamDiscarded(): boolean {
    return this.state.stream?.discarded === true;
  }

  pendingBase(): PendingBase | null {
    const stream = this.state.stream;
    return stream?.basePending ? this.baseOf(stream) : null;
  }

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

  baseReady(): boolean {
    const stream = this.state.stream;
    return stream !== undefined && stream.breakPending === undefined;
  }

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
