// governance: allow-repo-hygiene file-size-limit (#408) WAL restore is one integrity boundary: authenticated planning, checksum-verified spooling, SQLite replay, and coordinated pair validation must remain auditable as one pipeline
/*
 * WAL replay (#408). SQLITE does the replay: concatenate `<db>-wal`, open,
 * TRUNCATE-checkpoint, close. Never apply pages here. G8: both DBs cut at
 * ONE tick. A download failure is REMOVED FROM THE LISTING and the pair
 * re-planned. Never infer coordination from the listing — absent segment
 * and absent write look identical (journal ahead of vault).
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
  lastTickMs: number;
  truncated: boolean;
  integrityCheck: string;
  foreignKeyViolations: number;
}

export interface WalReplayOutcome {
  perDb: Record<WalDbName, WalReplayDbOutcome>;
  damaged: string[];
  coordinatedCutMs: number;
  newestMarkerTickMs: number;
  /**
   * Newest surviving marker, floored by `walTipTickMs`.
   * `coordinatedCutMs < expectedCutMs` is the ONLY truncation signal that
   * survives a provider deleting the marker stream.
   */
  expectedCutMs: number;
}

export interface ReplayWalOptions {
  store: ObjectStore;
  dataKey: Uint8Array;
  vaultId: string;
  destDir: string;
  generationByDb: Partial<Record<WalDbName, string>>;
  /** REQUIRED when both DBs have a generation, and the two MUST be equal. */
  baseTickMsByDb?: Partial<Record<WalDbName, number>>;
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
 * Markers minted while exactly these two bases were current. A failed tag
 * is dropped, never evidence — walk back, the safe direction.
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
 * Both bases MUST be from one tick. REFUSED, never repaired: a later journal
 * base holds receipts for rows that live only in segments.
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
 * Damaged segment is removed FROM THE LISTING and the pair re-planned at
 * the SAME instant — never lower the tick cut (the unusable object could
 * still satisfy a marker). Each pass succeeds or shrinks the listing.
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
      // Checkpoint is the first access that triggers recovery; next group's WAL layers on it.
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
 * FORMAT.md requires both `integrity_check` and `foreign_key_check`. An FK
 * violation is as fatal as physical corruption. Cross-DB
 * `verifyRestoredPair` is the non-fatal dangling-receipt check.
 */
export async function replayWalSegments(
  opts: ReplayWalOptions
): Promise<WalReplayOutcome> {
  const log = { ...noopLog, ...opts.log };
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
    // Tip floors what the store owes, only inside the restored window. PITR is not truncation.
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
        // the cut is irrelevant, and a gone stream sets neither.
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
