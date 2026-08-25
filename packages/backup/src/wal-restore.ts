// governance: allow-repo-hygiene file-size-limit (#408) WAL restore is one integrity boundary: authenticated planning, checksum-verified spooling, SQLite replay, and coordinated pair validation must remain auditable as one pipeline
/*
 * WAL replay materialization (#408). SQLITE does the replay: per group,
 * concatenate into `<db>-wal`, open, TRUNCATE-checkpoint, close. Never apply
 * pages here — per-segment GCM authentication plus SQLite recovery are what land
 * a damaged tail on an earlier consistent state (G6) rather than a corrupt file.
 *
 * Corruption handling is COORDINATED (G8): both databases cut at ONE tick, the
 * newest both can prove against an authenticated pair marker. A segment failing
 * at download time is REMOVED FROM THE LISTING and the pair re-planned. Never
 * infer coordination from the listing — an absent segment and an absent write
 * look identical, and that error is how a journal ends up ahead of its vault.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { EngineLogger } from "./engine-log.js";
import type { ObjectStore } from "./object-store.js";
import { applyAvailableInOrder, applyInOrder } from "./ordered-work.js";
import {
  openWalCloser,
  openWalPairMarker,
  openWalSegment,
  parseWalCloserKey,
  parseWalPairMarkerKey,
  parseWalSegmentKey,
  planCoordinatedReplay,
  WAL_DB_FILES,
  WAL_DB_NAMES,
  walGroupCloserKey,
  walPairMarkerPrefix,
  walSegmentKey,
  walSegmentPrefix,
  validateCommittedWal,
} from "./wal-format.js";
import type {
  CoordinatedReplayResult,
  WalDbName,
  WalGroupCloser,
  WalPairMarker,
  WalReplayPlan,
  WalSegmentAddress,
  WalStreamListing,
} from "./wal-format.js";

export interface WalReplayDbOutcome {
  generation: string | null;
  segmentsApplied: number;
  groupsApplied: number;
  /** Tick of the last applied segment; -1 when only the base was restored. */
  lastTickMs: number;
  /** The cut fell short of the newest marker: objects missing or damaged. */
  truncated: boolean;
  integrityCheck: string;
  foreignKeyViolations: number;
}

export interface WalReplayOutcome {
  perDb: Record<WalDbName, WalReplayDbOutcome>;
  /** Segment keys dropped: failed to fetch or authenticate. */
  damaged: string[];
  /** The single tick both databases were cut at; -1 = the base pair. */
  coordinatedCutMs: number;
  /** Newest authenticated marker at or before the cut; -1 = none. */
  newestMarkerTickMs: number;
  /**
   * What this restore SHOULD have reached: newest surviving marker, floored by
   * `walTipTickMs`. `coordinatedCutMs < expectedCutMs` is the ONLY truncation
   * signal that survives a provider deleting the marker stream.
   */
  expectedCutMs: number;
}

export interface ReplayWalOptions {
  store: ObjectStore;
  dataKey: Uint8Array;
  vaultId: string;
  /** Holds the already-written base files. */
  destDir: string;
  /** From the manifest's `db` entries. */
  generationByDb: Partial<Record<WalDbName, string>>;
  /**
   * The tick each base was cloned at. REQUIRED when both databases have a
   * generation, and the two MUST be equal — an unequal pair is refused.
   */
  baseTickMsByDb?: Partial<Record<WalDbName, number>>;
  /**
   * The newest marker tick the producer watched this provider ACCEPT. Failing to
   * reach it means the store lost acknowledged objects: the restore still
   * succeeds at the older point (G6), but must not be SILENT.
   */
  walTipTickMs?: number;
  /** Point-in-time cut; omit for restore-to-tip. */
  pointInTimeMs?: number;
  log?: EngineLogger;
}

/**
 * A missing, tampered or mis-addressed closer is simply absent, so the planner
 * refuses to advance past its group — degrading rather than mixing pages.
 */
async function listStream(
  store: ObjectStore,
  dataKey: Uint8Array,
  vaultId: string,
  db: WalDbName,
  generation: string,
  log: Required<EngineLogger>
): Promise<WalStreamListing> {
  const segments: WalSegmentAddress[] = [];
  const closers: WalGroupCloser[] = [];
  await applyAvailableInOrder(
    store.list(walSegmentPrefix(db, generation)),
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
 * The prefix returns only markers minted while exactly these two bases were
 * current. One failing its tag is dropped, never treated as evidence — the
 * restore walks back to an older one, the safe direction.
 */
async function listPairMarkers(
  store: ObjectStore,
  dataKey: Uint8Array,
  vaultId: string,
  generations: { vault: string; journal: string },
  log: Required<EngineLogger>
): Promise<WalPairMarker[]> {
  const markers: WalPairMarker[] = [];
  await applyAvailableInOrder(
    store.list(walPairMarkerPrefix(generations.vault, generations.journal)),
    async (obj) => {
      const addr = parseWalPairMarkerKey(obj.key);
      if (!addr) return;
      try {
        markers.push(
          openWalPairMarker(dataKey, vaultId, addr, await store.get(obj.key))
        );
      } catch (error) {
        log.warn(
          `restore: wal pair marker ${obj.key} failed authentication (${(error as Error).message}) — ignoring it`
        );
      }
    }
  );
  return markers;
}

/**
 * Both bases MUST be from one tick. A violation is REFUSED, never repaired: with
 * bases from two instants there is no floor to degrade to, because a journal base
 * taken after the vault base holds receipts for rows living only in segments.
 */
function assertCoordinatedBases(opts: ReplayWalOptions): void {
  if (
    opts.generationByDb.vault === undefined ||
    opts.generationByDb.journal === undefined
  )
    return;
  const vault = opts.baseTickMsByDb?.vault;
  const journal = opts.baseTickMsByDb?.journal;
  if (vault === undefined || journal === undefined) {
    throw new Error(
      "restore: the snapshot does not record a base tick for both databases — its two bases " +
        "cannot be shown to come from one capture instant, so a restore could silently hand back " +
        "a journal that is newer than its vault (dangling receipts). Refusing."
    );
  }
  if (vault !== journal) {
    throw new Error(
      `restore: the two database bases are from DIFFERENT ticks (vault ${vault}, journal ${journal}) — ` +
        "they were never one capture instant, so no coordinated restore point exists. Refusing."
    );
  }
}

/**
 * A damaged segment is removed FROM THE LISTING and the pair re-planned at the
 * SAME instant — never "lower the tick cut", which would leave the unusable
 * object still able to satisfy a marker's position check. Each pass either
 * succeeds or strictly shrinks a finite listing.
 */
async function spoolSegments(opts: {
  store: ObjectStore;
  dataKey: Uint8Array;
  vaultId: string;
  spoolDir: string;
  listingByDb: Partial<Record<WalDbName, WalStreamListing>>;
  generationByDb: Partial<Record<WalDbName, string>>;
  markers: WalPairMarker[];
  pointInTimeMs: number | undefined;
  log: Required<EngineLogger>;
}): Promise<{ result: CoordinatedReplayResult; damaged: string[] }> {
  const damaged: string[] = [];
  // Mutable copy: pruning the listing is how the planner sees only what can
  // actually be materialized.
  const listingByDb: Partial<Record<WalDbName, WalStreamListing>> = {};
  for (const db of WAL_DB_NAMES) {
    const listing = opts.listingByDb[db];
    if (listing)
      listingByDb[db] = {
        segments: [...listing.segments],
        closers: listing.closers,
      };
  }

  async function planAndSpool(): Promise<CoordinatedReplayResult> {
    const result = planCoordinatedReplay({
      listingByDb,
      generationByDb: opts.generationByDb,
      markers: opts.markers,
      ...(opts.pointInTimeMs === undefined
        ? {}
        : { cutTickMs: opts.pointInTimeMs }),
    });
    let dropped = false;
    const plannedSegments = WAL_DB_NAMES.flatMap((db) =>
      result.plans[db].segments.map((addr) => ({ addr, db }))
    );
    await applyInOrder(plannedSegments, async ({ db, addr }) => {
      if (dropped) return;
      const key = walSegmentKey(addr);
      const spoolPath = path.join(opts.spoolDir, key.replaceAll("/", "_"));
      try {
        await fs.access(spoolPath);
        return; // already spooled on an earlier pass
      } catch {
        /* not yet spooled */
      }
      try {
        const sealed = await opts.store.get(key);
        const plain = openWalSegment(opts.dataKey, opts.vaultId, addr, sealed);
        await fs.writeFile(spoolPath, plain);
      } catch (error) {
        damaged.push(key);
        const listing = listingByDb[db]!;
        listing.segments = listing.segments.filter((s) => s !== addr);
        dropped = true;
        opts.log.warn(
          `restore: wal segment ${key} unusable (${(error as Error).message}) — dropping it from ` +
            `the ${db} listing and re-planning the coordinated cut`
        );
      }
    });
    return dropped ? planAndSpool() : result;
  }
  return { result: await planAndSpool(), damaged };
}

/**
 * Group by group, the same sequence the live shipper's checkpoints performed, so
 * the file passes through the same states it did in production.
 */
async function replayDb(
  destDir: string,
  db: WalDbName,
  plan: WalReplayPlan,
  spoolDir: string
): Promise<{ groupsApplied: number }> {
  const dbPath = path.join(destDir, WAL_DB_FILES[db]);
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
      // The checkpoint IS the first access that triggers recovery, and folds
      // the frames into the main file so the next group's WAL layers correctly.
      const result = conn.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
        busy: number;
        log: number;
        checkpointed: number;
      };
      if (result.busy !== 0) {
        throw new Error(
          `restore: ${WAL_DB_FILES[db]} replay checkpoint was busy`
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
        `restore: ${WAL_DB_FILES[db]} did not consume the validated ${scan.validEndOffset}-byte WAL`
      );
    }
  });
  await fs.rm(walPath, { force: true });
  await fs.rm(shmPath, { force: true });
  return { groupsApplied: orderedGroups.length };
}

function checkDb(
  destDir: string,
  db: WalDbName
): { integrity: string; fkViolations: number } {
  const dbPath = path.join(destDir, WAL_DB_FILES[db]);
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
 * Throws when a restored database fails `integrity_check` OR `foreign_key_check`
 * — FORMAT.md requires BOTH. An FK violation is as fatal as physical corruption:
 * every writer opens with `foreign_keys = ON` and cuts land on commit
 * boundaries, so one means the replay produced a state the database never held.
 *
 * Intra-database only; the CROSS-database dangling-receipt check
 * (`verifyRestoredPair`) is legitimately non-fatal.
 */
export async function replayWalSegments(
  opts: ReplayWalOptions
): Promise<WalReplayOutcome> {
  const log = { ...noopLog, ...opts.log };
  // Before any byte moves: without one instant there is no coordinated restore
  // point to aim at, and every degradation is a guess.
  assertCoordinatedBases(opts);
  const spoolDir = await fs.mkdtemp(
    path.join(opts.destDir, ".wal-restore-spool-")
  );
  try {
    const listingByDb: Partial<Record<WalDbName, WalStreamListing>> = {};
    await applyInOrder(WAL_DB_NAMES, async (db) => {
      const generation = opts.generationByDb[db];
      if (generation !== undefined) {
        listingByDb[db] = await listStream(
          opts.store,
          opts.dataKey,
          opts.vaultId,
          db,
          generation,
          log
        );
      }
    });
    const markers =
      opts.generationByDb.vault !== undefined &&
      opts.generationByDb.journal !== undefined
        ? await listPairMarkers(
            opts.store,
            opts.dataKey,
            opts.vaultId,
            {
              vault: opts.generationByDb.vault,
              journal: opts.generationByDb.journal,
            },
            log
          )
        : [];

    const { result, damaged } = await spoolSegments({
      store: opts.store,
      dataKey: opts.dataKey,
      vaultId: opts.vaultId,
      spoolDir,
      listingByDb,
      generationByDb: opts.generationByDb,
      markers,
      pointInTimeMs: opts.pointInTimeMs,
      log,
    });
    const { plans, coordinatedCutMs, newestMarkerTickMs, coordinated } = result;
    // The registered tip floors what this store OWES, but only inside the
    // restored window: a point-in-time cut is deliberate, not truncation.
    const tipInWindow =
      opts.walTipTickMs !== undefined &&
      (opts.pointInTimeMs === undefined ||
        opts.walTipTickMs <= opts.pointInTimeMs);
    const expectedCutMs = tipInWindow
      ? Math.max(newestMarkerTickMs, opts.walTipTickMs!)
      : newestMarkerTickMs;
    if (coordinated && coordinatedCutMs < expectedCutMs) {
      log.warn(
        `restore: the newest coordinated point the producer shipped (tick ${expectedCutMs}) ` +
          `is NOT reassemblable — the pair could only be cut at tick ${coordinatedCutMs}. ` +
          "Objects are missing or damaged; the restore is an EARLIER consistent state."
      );
    }

    const perDb = {} as Record<WalDbName, WalReplayDbOutcome>;
    await applyInOrder(WAL_DB_NAMES, async (db) => {
      const generation = opts.generationByDb[db] ?? null;
      if (generation === null) {
        // No stream: nothing to replay, and nothing we may assume is SQLite.
        perDb[db] = {
          generation: null,
          segmentsApplied: 0,
          groupsApplied: 0,
          lastTickMs: -1,
          truncated: false,
          integrityCheck: "skipped",
          foreignKeyViolations: 0,
        };
        return;
      }
      const plan = plans[db];
      const { groupsApplied } = await replayDb(
        opts.destDir,
        db,
        plan,
        spoolDir
      );
      const { integrity, fkViolations } = checkDb(opts.destDir, db);
      perDb[db] = {
        generation,
        segmentsApplied: plan.segments.length,
        groupsApplied,
        lastTickMs: plan.lastTickMs,
        // Must NOT be `truncatedByHole || damaged.length > 0`: damage beyond
        // the requested cut is irrelevant here, and a stream whose objects are
        // simply gone sets neither.
        truncated: coordinated
          ? expectedCutMs >= 0 && coordinatedCutMs < expectedCutMs
          : plan.truncatedByHole || damaged.length > 0,
        integrityCheck: integrity,
        foreignKeyViolations: fkViolations,
      };
      if (integrity !== "ok") {
        throw new Error(
          `restore: ${WAL_DB_FILES[db]} failed integrity_check after WAL replay: ${integrity}`
        );
      }
      if (fkViolations > 0) {
        throw new Error(
          `restore: ${WAL_DB_FILES[db]} failed foreign_key_check after WAL replay: ` +
            `${fkViolations} violation(s) — the replayed state is not one this database ever held`
        );
      }
      log.info(
        `restore: ${WAL_DB_FILES[db]} replayed ${plan.segments.length} segments ` +
          `across ${groupsApplied} groups (last tick ${plan.lastTickMs})`
      );
    });
    return {
      perDb,
      damaged,
      coordinatedCutMs,
      newestMarkerTickMs,
      expectedCutMs,
    };
  } finally {
    await fs.rm(spoolDir, { recursive: true, force: true });
  }
}
