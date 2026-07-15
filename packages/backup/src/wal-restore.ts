// governance: allow-repo-hygiene file-size-limit (#408) WAL restore is one integrity boundary: authenticated planning, checksum-verified spooling, SQLite replay, and coordinated pair validation must remain auditable as one pipeline
/*
 * WAL replay materialization (centraid-snapshot/1, issue #408): fetch the
 * planned segments for both databases, spool + verify them, then let SQLITE
 * perform the replay — per group, the segments are concatenated back into
 * `<db>-wal`, the database is opened (recovery runs), checkpointed with
 * TRUNCATE, and closed. We never validate frame checksums or apply pages
 * ourselves; a damaged or missing tail lands the restore on an earlier
 * consistent state (G6), never a corrupt file — enforced here by GCM
 * authentication per segment and by SQLite's own recovery.
 *
 * Corruption handling is COORDINATED across the two databases (G8): both are
 * cut at ONE tick, the newest at which BOTH can prove — against an
 * authenticated pair marker — that their listed segments chain exactly to the
 * position the producer recorded. A segment that turns out missing or tampered
 * at download time is REMOVED FROM THE LISTING and the pair is re-planned; the
 * cut then falls back to an earlier marker on its own. Nothing here infers
 * coordination from the listing: an absent segment and an absent write look
 * identical from the outside, and getting that wrong is how a journal ends up
 * two ticks ahead of its vault, carrying receipts for rows that are not there.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ObjectStore } from './object-store.js';
import type { EngineLogger } from './engine-log.js';
import {
  openWalCloser,
  openWalPairMarker,
  openWalSegment,
  parseWalCloserKey,
  parseWalPairMarkerKey,
  parseWalSegmentKey,
  planCoordinatedReplay,
  type CoordinatedReplayResult,
  WAL_DB_FILES,
  WAL_DB_NAMES,
  type WalDbName,
  type WalGroupCloser,
  type WalPairMarker,
  type WalReplayPlan,
  type WalSegmentAddress,
  type WalStreamListing,
  walGroupCloserKey,
  walPairMarkerPrefix,
  walSegmentKey,
  walSegmentPrefix,
  validateCommittedWal,
} from './wal-format.js';

export interface WalReplayDbOutcome {
  generation: string | null;
  segmentsApplied: number;
  groupsApplied: number;
  /** Tick (ms) of the last applied segment; -1 when the base alone was restored. */
  lastTickMs: number;
  /**
   * True when this restore could NOT reach the newest instant the producer
   * proved it shipped — i.e. the coordinated cut fell short of the newest pair
   * marker, because objects are missing or damaged. (For a single-database
   * replay, which has no pair to coordinate, it is the old per-chain signal.)
   */
  truncated: boolean;
  integrityCheck: string;
  foreignKeyViolations: number;
}

export interface WalReplayOutcome {
  perDb: Record<WalDbName, WalReplayDbOutcome>;
  /** Segment keys dropped because they failed to fetch or authenticate. */
  damaged: string[];
  /** The single tick both databases were cut at; -1 = the base pair. */
  coordinatedCutMs: number;
  /** Newest authenticated pair marker at or before the requested cut; -1 = none. */
  newestMarkerTickMs: number;
  /**
   * The newest tick this restore SHOULD have been able to reach: the newest
   * surviving marker, floored by the manifest's registered `walTipTickMs` (the
   * store acknowledged those objects, so it owes them). `coordinatedCutMs <
   * expectedCutMs` is the truncation signal — and it is the ONLY one that
   * survives a provider deleting the marker stream, where every other check
   * comes back clean.
   */
  expectedCutMs: number;
}

export interface ReplayWalOptions {
  store: ObjectStore;
  dataKey: Uint8Array;
  vaultId: string;
  /** The restore destination holding the already-written base files. */
  destDir: string;
  /** Per-db WAL generation from the manifest's `db` entries. */
  generationByDb: Partial<Record<WalDbName, string>>;
  /**
   * Per-db base tick from the manifest's `db` entries — the tick at which the
   * shipper TRUNCATE-checkpointed and cloned that base. REQUIRED when both
   * databases have a generation: the two MUST be equal, and a pair that isn't
   * is refused rather than restored (see `assertCoordinatedBases`).
   */
  baseTickMsByDb?: Partial<Record<WalDbName, number>>;
  /**
   * The manifest's registered `walTipTickMs`: the newest pair-marker tick the
   * producer watched this provider ACCEPT. A restore that cannot reach it is
   * looking at a store that lost objects it acknowledged — the restore still
   * succeeds at the older coordinated point (G6), but it must not be SILENT
   * about it. Absent for a snapshot registered before any marker drained.
   */
  walTipTickMs?: number;
  /** Point-in-time cut; omit for restore-to-tip. */
  pointInTimeMs?: number;
  log?: EngineLogger;
}

/**
 * LIST one stream and AUTHENTICATE its closers (tiny objects, one per
 * group). A closer that is missing, tampered, or mis-addressed is simply
 * absent from the listing — the planner then refuses to advance past its
 * group, which degrades to an earlier restore point instead of ever mixing
 * page versions.
 */
async function listStream(
  store: ObjectStore,
  dataKey: Uint8Array,
  vaultId: string,
  db: WalDbName,
  generation: string,
  log: Required<EngineLogger>,
): Promise<WalStreamListing> {
  const segments: WalSegmentAddress[] = [];
  const closers: WalGroupCloser[] = [];
  for await (const obj of store.list(walSegmentPrefix(db, generation))) {
    const addr = parseWalSegmentKey(obj.key);
    if (addr) {
      segments.push(addr);
      continue;
    }
    const closer = parseWalCloserKey(obj.key);
    if (!closer) continue;
    try {
      openWalCloser(dataKey, vaultId, closer, await store.get(walGroupCloserKey(closer)));
      closers.push(closer);
    } catch (err) {
      log.warn(
        `restore: wal closer ${obj.key} failed authentication (${(err as Error).message}) — treating group as unclosed`,
      );
    }
  }
  return { segments, closers };
}

/**
 * LIST + authenticate the pair markers for THIS base pair. Both generations
 * are in the key, so the prefix returns only markers minted while exactly
 * these two bases were current — no download-and-filter, and a marker from any
 * other era can never be considered.
 *
 * A marker that fails its tag is dropped (and logged): the restore then walks
 * back to an older one, which is the safe direction. It is never treated as
 * evidence of anything.
 */
async function listPairMarkers(
  store: ObjectStore,
  dataKey: Uint8Array,
  vaultId: string,
  generations: { vault: string; journal: string },
  log: Required<EngineLogger>,
): Promise<WalPairMarker[]> {
  const markers: WalPairMarker[] = [];
  for await (const obj of store.list(walPairMarkerPrefix(generations.vault, generations.journal))) {
    const addr = parseWalPairMarkerKey(obj.key);
    if (!addr) continue;
    try {
      markers.push(openWalPairMarker(dataKey, vaultId, addr, await store.get(obj.key)));
    } catch (err) {
      log.warn(
        `restore: wal pair marker ${obj.key} failed authentication (${(err as Error).message}) — ignoring it`,
      );
    }
  }
  return markers;
}

/**
 * Both bases MUST be from one tick. The producer coordinates its generation
 * breaks precisely so this holds (`WalShipper.coordinatedBreak`) and refuses
 * to register a manifest where it doesn't (`assembleSourceEntries`) — so a
 * violation here means a hand-crafted manifest, a tampered producer, or a
 * pre-coordination artifact.
 *
 * It is refused, not repaired. With bases from two different instants there is
 * no floor to degrade to: base(journal) taken AFTER base(vault) already
 * contains receipts for vault rows that live only in segments, so losing any
 * one of those segments hands back a dangling receipt — and that is the exact
 * corruption the whole feature exists to make unconstructible.
 */
function assertCoordinatedBases(opts: ReplayWalOptions): void {
  if (opts.generationByDb.vault === undefined || opts.generationByDb.journal === undefined) return;
  const vault = opts.baseTickMsByDb?.vault;
  const journal = opts.baseTickMsByDb?.journal;
  if (vault === undefined || journal === undefined) {
    throw new Error(
      'restore: the snapshot does not record a base tick for both databases — its two bases ' +
        'cannot be shown to come from one capture instant, so a restore could silently hand back ' +
        'a journal that is newer than its vault (dangling receipts). Refusing.',
    );
  }
  if (vault !== journal) {
    throw new Error(
      `restore: the two database bases are from DIFFERENT ticks (vault ${vault}, journal ${journal}) — ` +
        'they were never one capture instant, so no coordinated restore point exists. Refusing.',
    );
  }
}

/**
 * Fetch + authenticate every planned segment into `spoolDir`, re-planning the
 * PAIR whenever one turns out damaged. Returns the final plans plus the keys
 * that were dropped.
 *
 * A damaged segment is removed FROM THE LISTING and the pair is re-planned at
 * the SAME requested instant — never "lower the tick cut". Lowering the cut
 * would leave the damaged object in the listing, where it can still satisfy a
 * marker's position check while being unusable; removing it makes the chain
 * genuinely shorter, so the marker walk-back does the right thing on its own.
 * Termination is trivial: each pass either succeeds or strictly shrinks a
 * finite listing.
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
  // A mutable copy — the listing is what gets pruned, so the planner sees the
  // stream exactly as it can actually be materialized.
  const listingByDb: Partial<Record<WalDbName, WalStreamListing>> = {};
  for (const db of WAL_DB_NAMES) {
    const listing = opts.listingByDb[db];
    if (listing) listingByDb[db] = { segments: [...listing.segments], closers: listing.closers };
  }

  for (;;) {
    const result = planCoordinatedReplay({
      listingByDb,
      generationByDb: opts.generationByDb,
      markers: opts.markers,
      ...(opts.pointInTimeMs !== undefined ? { cutTickMs: opts.pointInTimeMs } : {}),
    });
    let dropped = false;
    for (const db of WAL_DB_NAMES) {
      for (const addr of result.plans[db].segments) {
        const key = walSegmentKey(addr);
        const spoolPath = path.join(opts.spoolDir, key.replaceAll('/', '_'));
        try {
          await fs.access(spoolPath);
          continue; // already spooled on an earlier pass
        } catch {
          /* not yet spooled */
        }
        try {
          const sealed = await opts.store.get(key);
          const plain = openWalSegment(opts.dataKey, opts.vaultId, addr, sealed);
          await fs.writeFile(spoolPath, plain);
        } catch (err) {
          damaged.push(key);
          const listing = listingByDb[db]!;
          listing.segments = listing.segments.filter((s) => s !== addr);
          dropped = true;
          opts.log.warn(
            `restore: wal segment ${key} unusable (${(err as Error).message}) — dropping it from ` +
              `the ${db} listing and re-planning the coordinated cut`,
          );
          break;
        }
      }
      if (dropped) break;
    }
    if (!dropped) return { result, damaged };
  }
}

/**
 * Replay one database's plan onto its restored base file. Group by group:
 * write the concatenated segments as `<file>-wal`, open (SQLite recovers),
 * TRUNCATE-checkpoint, close — exactly the sequence the live shipper's
 * checkpoints performed, so the file passes through the same states it did
 * in production.
 */
async function replayDb(
  destDir: string,
  db: WalDbName,
  plan: WalReplayPlan,
  spoolDir: string,
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
  for (const group of orderedGroups) {
    await fs.rm(walPath, { force: true });
    await fs.rm(shmPath, { force: true });
    const handle = await fs.open(walPath, 'w');
    try {
      for (const seg of groups.get(group)!) {
        const spoolPath = path.join(spoolDir, walSegmentKey(seg).replaceAll('/', '_'));
        await handle.appendFile(await fs.readFile(spoolPath));
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    const walBytes = await fs.readFile(walPath);
    const scan = validateCommittedWal(walBytes);
    const conn = new DatabaseSync(dbPath);
    try {
      // Recovery runs on first access; the checkpoint IS that access, and
      // folds the replayed frames into the main file so the next group's
      // WAL (written against post-checkpoint state) layers correctly.
      const result = conn.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
        busy: number;
        log: number;
        checkpointed: number;
      };
      if (result.busy !== 0) {
        throw new Error(`restore: ${WAL_DB_FILES[db]} replay checkpoint was busy`);
      }
    } finally {
      conn.close();
    }
    const remaining = await fs.stat(walPath).then(
      (st) => st.size,
      () => 0,
    );
    if (remaining !== 0) {
      throw new Error(
        `restore: ${WAL_DB_FILES[db]} did not consume the validated ${scan.validEndOffset}-byte WAL`,
      );
    }
  }
  await fs.rm(walPath, { force: true });
  await fs.rm(shmPath, { force: true });
  return { groupsApplied: orderedGroups.length };
}

function checkDb(destDir: string, db: WalDbName): { integrity: string; fkViolations: number } {
  const dbPath = path.join(destDir, WAL_DB_FILES[db]);
  const conn = new DatabaseSync(dbPath);
  try {
    const integ = conn.prepare('PRAGMA integrity_check').get() as
      | { integrity_check: string }
      | undefined;
    const fks = conn.prepare('PRAGMA foreign_key_check').all();
    return { integrity: integ?.integrity_check ?? 'no result', fkViolations: fks.length };
  } finally {
    conn.close();
  }
}

const noopLog: Required<EngineLogger> = { info: () => undefined, warn: () => undefined };

/**
 * Replay both databases' WAL segments onto the restored base files in
 * `destDir`, at a coordinated point in time. Throws when a restored database
 * fails `integrity_check` OR `foreign_key_check` (FORMAT.md requires BOTH) —
 * with every object GCM-authenticated and replay done by SQLite, either one
 * indicates a producer-side bug, and a restore that "succeeds" wrong is the
 * one outcome this feature exists to prevent.
 *
 * FK violations are as fatal as physical corruption because they cannot occur
 * in an honest cut: every writer of both files opens with `PRAGMA
 * foreign_keys = ON` (vault's `openFile`, app-engine's `openJournalDb`, the
 * import path re-checks wholesale before COMMIT), so no committed state ever
 * held one — and a segment plan only ever restores committed states (cuts land
 * on commit boundaries). A violation therefore means the replay produced a
 * state the database never actually had: page mixing across groups, a
 * mis-ordered plan, a spoofed offset. That is exactly the "logically
 * inconsistent but physically intact" outcome that would otherwise be handed
 * back as a successful restore.
 *
 * Not to be confused with the CROSS-database dangling-receipt check
 * (`verifyRestoredPair`), which is legitimately non-fatal: a vault row may be
 * hard-deleted after the receipt that names it. This is intra-database only.
 */
export async function replayWalSegments(opts: ReplayWalOptions): Promise<WalReplayOutcome> {
  const log = { ...noopLog, ...opts.log };
  // Before a single byte moves: the pair must be one instant, or there is no
  // coordinated restore point to aim at and every degradation is a guess.
  assertCoordinatedBases(opts);
  const spoolDir = await fs.mkdtemp(path.join(opts.destDir, '.wal-restore-spool-'));
  try {
    const listingByDb: Partial<Record<WalDbName, WalStreamListing>> = {};
    for (const db of WAL_DB_NAMES) {
      const generation = opts.generationByDb[db];
      if (generation !== undefined) {
        listingByDb[db] = await listStream(
          opts.store,
          opts.dataKey,
          opts.vaultId,
          db,
          generation,
          log,
        );
      }
    }
    const markers =
      opts.generationByDb.vault !== undefined && opts.generationByDb.journal !== undefined
        ? await listPairMarkers(
            opts.store,
            opts.dataKey,
            opts.vaultId,
            { vault: opts.generationByDb.vault, journal: opts.generationByDb.journal },
            log,
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
    // The registered tip is a floor on what this store OWES us — but only
    // within the window actually being restored: a point-in-time restore
    // deliberately cuts early, and that is not a truncation.
    const tipInWindow =
      opts.walTipTickMs !== undefined &&
      (opts.pointInTimeMs === undefined || opts.walTipTickMs <= opts.pointInTimeMs);
    const expectedCutMs = tipInWindow
      ? Math.max(newestMarkerTickMs, opts.walTipTickMs!)
      : newestMarkerTickMs;
    if (coordinated && coordinatedCutMs < expectedCutMs) {
      log.warn(
        `restore: the newest coordinated point the producer shipped (tick ${expectedCutMs}) ` +
          `is NOT reassemblable — the pair could only be cut at tick ${coordinatedCutMs}. ` +
          'Objects are missing or damaged; the restore is an EARLIER consistent state.',
      );
    }

    const perDb = {} as Record<WalDbName, WalReplayDbOutcome>;
    for (const db of WAL_DB_NAMES) {
      const generation = opts.generationByDb[db] ?? null;
      if (generation === null) {
        // No WAL stream for this database (or the manifest doesn't carry
        // one) — nothing to replay and nothing we may assume is SQLite.
        perDb[db] = {
          generation: null,
          segmentsApplied: 0,
          groupsApplied: 0,
          lastTickMs: -1,
          truncated: false,
          integrityCheck: 'skipped',
          foreignKeyViolations: 0,
        };
        continue;
      }
      const plan = plans[db];
      const { groupsApplied } = await replayDb(opts.destDir, db, plan, spoolDir);
      const { integrity, fkViolations } = checkDb(opts.destDir, db);
      perDb[db] = {
        generation,
        segmentsApplied: plan.segments.length,
        groupsApplied,
        lastTickMs: plan.lastTickMs,
        // The tip is unreachable iff the coordinated cut fell short of the
        // newest marker. NOT `truncatedByHole || damaged.length > 0`: damage
        // beyond the requested point-in-time cut is irrelevant to THIS
        // restore, and a stream whose objects are simply gone sets neither.
        truncated: coordinated
          ? expectedCutMs >= 0 && coordinatedCutMs < expectedCutMs
          : plan.truncatedByHole || damaged.length > 0,
        integrityCheck: integrity,
        foreignKeyViolations: fkViolations,
      };
      if (integrity !== 'ok') {
        throw new Error(
          `restore: ${WAL_DB_FILES[db]} failed integrity_check after WAL replay: ${integrity}`,
        );
      }
      if (fkViolations > 0) {
        throw new Error(
          `restore: ${WAL_DB_FILES[db]} failed foreign_key_check after WAL replay: ` +
            `${fkViolations} violation(s) — the replayed state is not one this database ever held`,
        );
      }
      log.info(
        `restore: ${WAL_DB_FILES[db]} replayed ${plan.segments.length} segments ` +
          `across ${groupsApplied} groups (last tick ${plan.lastTickMs})`,
      );
    }
    return { perDb, damaged, coordinatedCutMs, newestMarkerTickMs, expectedCutMs };
  } finally {
    await fs.rm(spoolDir, { recursive: true, force: true });
  }
}
