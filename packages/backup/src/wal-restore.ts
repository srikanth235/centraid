// governance: allow-repo-hygiene file-size-limit (#408) WAL restore is one integrity boundary: authenticated planning, checksum-verified spooling, SQLite replay, and marked-cut validation must remain auditable as one pipeline
/*
 * WAL replay (#408). SQLITE does the replay: concatenate `vault.db-wal`, open,
 * TRUNCATE-checkpoint, close. Never apply pages here. The cut is the newest
 * TICK MARKER the stream can prove it reached. A download failure is REMOVED
 * FROM THE LISTING and the cut re-planned. Never infer the tip from the
 * listing — an absent segment and an absent write look identical.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { EngineLogger } from "./engine-log.js";
import type { ObjectStore } from "./object-store.js";
import { applyAvailableInOrder, applyInOrder } from "./ordered-work.js";
import {
  openWalCloser,
  openWalSegment,
  openWalTickMarker,
  parseWalCloserKey,
  parseWalSegmentKey,
  parseWalTickMarkerKey,
  planMarkedReplay,
  WAL_DB_FILES,
  walGroupCloserKey,
  walSegmentKey,
  walSegmentPrefix,
  walTickMarkerPrefix,
  validateCommittedWal,
} from "./wal-format.js";
import type {
  MarkedReplayResult,
  WalGroupCloser,
  WalReplayPlan,
  WalSegmentAddress,
  WalStreamListing,
  WalTickMarker,
} from "./wal-format.js";

export interface WalReplayOutcome {
  generation: string | null;
  segmentsApplied: number;
  groupsApplied: number;
  lastTickMs: number;
  truncated: boolean;
  integrityCheck: string;
  foreignKeyViolations: number;
  damaged: string[];
  /** Tick the stream was cut at; -1 at the base floor. */
  cutTickMs: number;
  newestMarkerTickMs: number;
  /**
   * Newest surviving marker, floored by `walTipTickMs`.
   * `cutTickMs < expectedCutMs` is the ONLY truncation signal that survives a
   * provider deleting the marker stream.
   */
  expectedCutMs: number;
}

export interface ReplayWalOptions {
  store: ObjectStore;
  dataKey: Uint8Array;
  vaultId: string;
  destDir: string;
  /** Absent ⇒ a base with no shipped stream: nothing to replay. */
  generation?: string;
  /**
   * Newest marker tick the producer saw accepted. Missing it is lost
   * acknowledged objects: restore still succeeds at the older point (G6),
   * but must not be silent.
   */
  walTipTickMs?: number;
  pointInTimeMs?: number;
  log?: EngineLogger;
}

/**
 * Missing/tampered closer is absent: planner refuses to advance past its
 * group — degrade rather than mix pages.
 */
async function listStream(
  store: ObjectStore,
  dataKey: Uint8Array,
  vaultId: string,
  generation: string,
  log: Required<EngineLogger>
): Promise<WalStreamListing> {
  const segments: WalSegmentAddress[] = [];
  const closers: WalGroupCloser[] = [];
  await applyAvailableInOrder(
    store.list(walSegmentPrefix("vault", generation)),
    async (obj) => {
      const addr = parseWalSegmentKey(obj.key);
      if (addr) {
        segments.push(addr);
        return;
      }
      const closer = parseWalCloserKey(obj.key);
      if (!closer) return;
      try {
        openWalCloser(
          dataKey,
          vaultId,
          closer,
          await store.get(walGroupCloserKey(closer))
        );
        closers.push(closer);
      } catch (error) {
        log.warn(
          `restore: wal closer ${obj.key} failed authentication (${(error as Error).message}) — treating group as unclosed`
        );
      }
    }
  );
  return { segments, closers };
}

/**
 * Markers minted while exactly this base was current. A failed tag is
 * dropped, never evidence — walk back, the safe direction.
 */
async function listTickMarkers(
  store: ObjectStore,
  dataKey: Uint8Array,
  vaultId: string,
  generation: string,
  log: Required<EngineLogger>
): Promise<WalTickMarker[]> {
  const markers: WalTickMarker[] = [];
  await applyAvailableInOrder(
    store.list(walTickMarkerPrefix(generation)),
    async (obj) => {
      const addr = parseWalTickMarkerKey(obj.key);
      if (!addr) return;
      try {
        markers.push(
          openWalTickMarker(dataKey, vaultId, addr, await store.get(obj.key))
        );
      } catch (error) {
        log.warn(
          `restore: wal tick marker ${obj.key} failed authentication (${(error as Error).message}) — ignoring it`
        );
      }
    }
  );
  return markers;
}

/**
 * Damaged segment is removed FROM THE LISTING and the cut re-planned at the
 * SAME instant — never lower the tick cut (the unusable object could still
 * satisfy a marker). Each pass succeeds or shrinks the listing.
 */
async function spoolSegments(opts: {
  store: ObjectStore;
  dataKey: Uint8Array;
  vaultId: string;
  spoolDir: string;
  listing: WalStreamListing;
  generation: string;
  markers: WalTickMarker[];
  pointInTimeMs: number | undefined;
  log: Required<EngineLogger>;
}): Promise<{ result: MarkedReplayResult; damaged: string[] }> {
  const damaged: string[] = [];
  const listing: WalStreamListing = {
    segments: [...opts.listing.segments],
    closers: opts.listing.closers,
  };

  async function planAndSpool(): Promise<MarkedReplayResult> {
    const result = planMarkedReplay({
      listing,
      generation: opts.generation,
      markers: opts.markers,
      ...(opts.pointInTimeMs === undefined
        ? {}
        : { cutTickMs: opts.pointInTimeMs }),
    });
    let dropped = false;
    await applyInOrder(result.plan.segments, async (addr) => {
      if (dropped) return;
      const key = walSegmentKey(addr);
      const spoolPath = path.join(opts.spoolDir, key.replaceAll("/", "_"));
      try {
        await fs.access(spoolPath);
        return;
      } catch {
        /* not yet spooled */
      }
      try {
        const sealed = await opts.store.get(key);
        const plain = openWalSegment(opts.dataKey, opts.vaultId, addr, sealed);
        await fs.writeFile(spoolPath, plain);
      } catch (error) {
        damaged.push(key);
        listing.segments = listing.segments.filter((s) => s !== addr);
        dropped = true;
        opts.log.warn(
          `restore: wal segment ${key} unusable (${(error as Error).message}) — dropping it from ` +
            "the listing and re-planning the cut"
        );
      }
    });
    return dropped ? planAndSpool() : result;
  }
  return { result: await planAndSpool(), damaged };
}

async function replayDb(
  destDir: string,
  plan: WalReplayPlan,
  spoolDir: string
): Promise<{ groupsApplied: number }> {
  const dbPath = path.join(destDir, WAL_DB_FILES.vault);
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  const groups = new Map<number, WalSegmentAddress[]>();
  for (const seg of plan.segments) {
    const list = groups.get(seg.group) ?? [];
    list.push(seg);
    groups.set(seg.group, list);
  }
  const orderedGroups = [...groups.keys()].sort((a, b) => a - b);
  await applyInOrder(orderedGroups, async (group) => {
    await fs.rm(walPath, { force: true });
    await fs.rm(shmPath, { force: true });
    const handle = await fs.open(walPath, "w");
    try {
      await applyInOrder(groups.get(group)!, async (seg) => {
        const spoolPath = path.join(
          spoolDir,
          walSegmentKey(seg).replaceAll("/", "_")
        );
        await handle.appendFile(await fs.readFile(spoolPath));
      });
      await handle.sync();
    } finally {
      await handle.close();
    }
    const walBytes = await fs.readFile(walPath);
    const scan = validateCommittedWal(walBytes);
    const conn = new DatabaseSync(dbPath);
    try {
      // Checkpoint is the first access that triggers recovery; next group's WAL layers on it.
      const result = conn.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
        busy: number;
        log: number;
        checkpointed: number;
      };
      if (result.busy !== 0) {
        throw new Error(
          `restore: ${WAL_DB_FILES.vault} replay checkpoint was busy`
        );
      }
    } finally {
      conn.close();
    }
    const remaining = await fs.stat(walPath).then(
      (st) => st.size,
      () => 0
    );
    if (remaining !== 0) {
      throw new Error(
        `restore: ${WAL_DB_FILES.vault} did not consume the validated ${scan.validEndOffset}-byte WAL`
      );
    }
  });
  await fs.rm(walPath, { force: true });
  await fs.rm(shmPath, { force: true });
  return { groupsApplied: orderedGroups.length };
}

function checkDb(destDir: string): {
  integrity: string;
  fkViolations: number;
} {
  const dbPath = path.join(destDir, WAL_DB_FILES.vault);
  const conn = new DatabaseSync(dbPath);
  try {
    const integ = conn.prepare("PRAGMA integrity_check").get() as
      | { integrity_check: string }
      | undefined;
    const fks = conn.prepare("PRAGMA foreign_key_check").all();
    return {
      integrity: integ?.integrity_check ?? "no result",
      fkViolations: fks.length,
    };
  } finally {
    conn.close();
  }
}

const noopLog: Required<EngineLogger> = {
  info: () => undefined,
  warn: () => undefined,
};

/**
 * FORMAT.md requires both `integrity_check` and `foreign_key_check`. An FK
 * violation is as fatal as physical corruption.
 */
export async function replayWalSegments(
  opts: ReplayWalOptions
): Promise<WalReplayOutcome> {
  const log = { ...noopLog, ...opts.log };
  const generation = opts.generation ?? null;
  const spoolDir = await fs.mkdtemp(
    path.join(opts.destDir, ".wal-restore-spool-")
  );
  try {
    if (generation === null) {
      return {
        generation: null,
        segmentsApplied: 0,
        groupsApplied: 0,
        lastTickMs: -1,
        truncated: false,
        integrityCheck: "skipped",
        foreignKeyViolations: 0,
        damaged: [],
        cutTickMs: -1,
        newestMarkerTickMs: -1,
        expectedCutMs: -1,
      };
    }
    const listing = await listStream(
      opts.store,
      opts.dataKey,
      opts.vaultId,
      generation,
      log
    );
    const markers = await listTickMarkers(
      opts.store,
      opts.dataKey,
      opts.vaultId,
      generation,
      log
    );

    const { result, damaged } = await spoolSegments({
      store: opts.store,
      dataKey: opts.dataKey,
      vaultId: opts.vaultId,
      spoolDir,
      listing,
      generation,
      markers,
      pointInTimeMs: opts.pointInTimeMs,
      log,
    });
    const { plan, cutTickMs, newestMarkerTickMs } = result;
    // Tip floors what the store owes, only inside the restored window. PITR is not truncation.
    const tipInWindow =
      opts.walTipTickMs !== undefined &&
      (opts.pointInTimeMs === undefined ||
        opts.walTipTickMs <= opts.pointInTimeMs);
    const expectedCutMs = tipInWindow
      ? Math.max(newestMarkerTickMs, opts.walTipTickMs!)
      : newestMarkerTickMs;
    if (cutTickMs < expectedCutMs) {
      log.warn(
        `restore: the newest point the producer shipped (tick ${expectedCutMs}) ` +
          `is NOT reassemblable — the stream could only be cut at tick ${cutTickMs}. ` +
          "Objects are missing or damaged; the restore is an EARLIER consistent state."
      );
    }

    const { groupsApplied } = await replayDb(opts.destDir, plan, spoolDir);
    const { integrity, fkViolations } = checkDb(opts.destDir);
    if (integrity !== "ok") {
      throw new Error(
        `restore: ${WAL_DB_FILES.vault} failed integrity_check after WAL replay: ${integrity}`
      );
    }
    if (fkViolations > 0) {
      throw new Error(
        `restore: ${WAL_DB_FILES.vault} failed foreign_key_check after WAL replay: ` +
          `${fkViolations} violation(s) — the replayed state is not one this database ever held`
      );
    }
    log.info(
      `restore: ${WAL_DB_FILES.vault} replayed ${plan.segments.length} segments ` +
        `across ${groupsApplied} groups (last tick ${plan.lastTickMs})`
    );
    return {
      generation,
      segmentsApplied: plan.segments.length,
      groupsApplied,
      lastTickMs: plan.lastTickMs,
      // With a marker to prove the tip, falling short of it IS the truncation
      // signal (damage beyond the cut is irrelevant). With no marker at all
      // there is nothing to fall short of, so a broken chain or an unusable
      // object is the only evidence left.
      truncated:
        expectedCutMs >= 0
          ? cutTickMs < expectedCutMs
          : plan.truncatedByHole || damaged.length > 0,
      integrityCheck: integrity,
      foreignKeyViolations: fkViolations,
      damaged,
      cutTickMs,
      newestMarkerTickMs,
      expectedCutMs,
    };
  } finally {
    await fs.rm(spoolDir, { recursive: true, force: true });
  }
}
