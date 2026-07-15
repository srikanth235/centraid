/*
 * Assemble one vault's `SourceEntry[]` for `createSnapshot` (FORMAT.md
 * "What a Centraid vault snapshot contains"): the WAL shipper's pinned base
 * clones first (each anchors that database's segment stream — issue #408;
 * the old `stageVaultDbs` VACUUM INTO staging is gone with the /1 format),
 * then the local blob CAS read in place, the code store's git bundle, and the
 * seal key. Remote-CAS configuration alone is not authenticated durability
 * evidence, so it never removes a blob from a restorable snapshot.
 */

import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { readSealKeyFingerprint, sealKeyFileFor } from '@centraid/vault';
import { WAL_DB_FILES, type EngineLogger, type SourceEntry } from '@centraid/backup';
import { GitError, run } from '../worktree-store/git.js';
import type { VaultPlane } from '../serve/vault-plane.js';

/** Wipe and recreate the per-vault staging dir (`<backupDir>/staging/<vaultId>/`). */
export async function resetStagingDir(stagingDir: string): Promise<void> {
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir, { recursive: true });
}

/** Every blob CAS file under `<vaultDir>/blobs/sha256/<fan>/<sha>` (`FsBlobStore`'s layout). */
async function listBlobEntries(vaultDir: string): Promise<SourceEntry[]> {
  const base = path.join(vaultDir, 'blobs', 'sha256');
  if (!existsSync(base)) return [];
  const entries: SourceEntry[] = [];
  for (const fan of await fs.readdir(base)) {
    const fanDir = path.join(base, fan);
    let names: string[];
    try {
      names = await fs.readdir(fanDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      entries.push({
        path: `blobs/sha256/${fan}/${name}`,
        kind: 'blob',
        absolutePath: path.join(fanDir, name),
      });
    }
  }
  // Deterministic order — dedup/reuse in `createSnapshot` doesn't care, but
  // stable manifests make debugging/verification output legible.
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

/** `git bundle create <staging>/apps.bundle --all` from the vault's bare code store. */
async function bundleCodeStore(
  plane: VaultPlane,
  stagingDir: string,
  log: EngineLogger,
): Promise<SourceEntry | undefined> {
  const bareDir = path.join(plane.codeStoreRoot, 'apps.git');
  if (!existsSync(path.join(bareDir, 'HEAD'))) {
    log.info?.('backup: no code store bare repo yet — skipping git-bundle entry');
    return undefined;
  }
  const bundlePath = path.join(stagingDir, 'apps.bundle');
  try {
    await run(['bundle', 'create', bundlePath, '--all'], { cwd: bareDir });
    return { path: 'apps.bundle', kind: 'git-bundle', absolutePath: bundlePath };
  } catch (err) {
    // An empty bare repo (no refs yet) makes `git bundle create --all` fail
    // loudly ("Refusing to create empty bundle") — that's an EXPECTED state
    // for a freshly created vault with no apps published yet, not a backup
    // failure; every other GitError still surfaces via the caught log line.
    const message = err instanceof GitError ? err.message : String(err);
    log.warn?.(`backup: git bundle create failed (skipping git-bundle entry): ${message}`);
    return undefined;
  }
}

/**
 * The vault's sealed-columns DEK file (`keys/<vaultId>.sealkey`, sibling of
 * the vault dir) — included ONLY when this vault has actually sealed a
 * value.
 *
 * `openVaultDb` (`resolveSealKey`) mints the key FILE eagerly on every
 * on-disk vault's first open, whether or not anything is ever sealed — so
 * `existsSync(keyFile)` alone is true for essentially every real vault and
 * does not mean "this vault has secrets" (a bug caught while writing this
 * module's first real test, `backup-sources.test.ts`). The vault only
 * STAMPS a fingerprint into `core_vault.settings_json` the first time it
 * seals something (`stampSealKeyFingerprint`, schema/sealed.ts) — that
 * stamp, not raw file existence, is "has this vault ever sealed a value",
 * matching this function's doc comment and FORMAT.md's framing ("a snapshot
 * without it restores sealed columns as permanent ciphertext"). Backing up
 * an unused, never-referenced key file needlessly widens what a snapshot
 * carries, so we gate on the stamp.
 */
function sealKeyEntry(plane: VaultPlane): SourceEntry | undefined {
  if (readSealKeyFingerprint(plane.db.vault) === null) return undefined;
  const keyFile = sealKeyFileFor(plane.dir);
  if (!existsSync(keyFile)) return undefined;
  return { path: 'seal.key', kind: 'seal-key', absolutePath: keyFile };
}

export interface AssembleOptions {
  plane: VaultPlane;
  /** `<backupDir>/staging/<vaultId>/` — reset by the caller before this runs. */
  stagingDir: string;
  /**
   * The newest pair-marker tick the provider has CONFIRMED accepting for the
   * shipper's current base pair (backup state's `walMarkerTips`). Stamped into
   * the `db` entries so every later verification can hold the store to it.
   * Absent until the first marker of this generation pair has actually drained.
   */
  walTipTickMs?: number;
  log: EngineLogger;
}

/** Build the full `SourceEntry[]` for one backup tick, in FORMAT.md's order. */
export async function assembleSourceEntries(opts: AssembleOptions): Promise<SourceEntry[]> {
  const { plane, stagingDir, log } = opts;
  const entries: SourceEntry[] = [];

  // (a) DB base clones FIRST (issue #408): the shipper pinned each database
  // right after a TRUNCATE checkpoint (WAL-quiet, immutable until the next
  // checkpoint), so the clone IS a point-in-time copy — no VACUUM INTO
  // rewrite, no staging. `sha256` + `walGeneration` ride into the sealed
  // manifest entry: the generation is what restore lists segments under,
  // the hash is the capture-time marker restore + the G9 verifier check.
  const shipper = plane.walShipper;
  if (!shipper) {
    throw new Error('backup: vault has no WAL shipper (in-memory vault?) — nothing to snapshot');
  }
  // The capture tick that mints/refreshes bases runs in doRunBackup, NOT
  // here — this function's contract is "list the sources", and its
  // injectable seam (BackupServiceOptions.assembleEntries) must not be the
  // only thing standing between a backup run and a checkpoint. What IS
  // enforced here: a snapshot may never register with a database missing.
  // A busy first-run truncate (a subprocess holding journal.db past the
  // 250 ms checkpoint wait) leaves that stream uninitialized for a tick —
  // registering "healthy" without journal.db would restore a vault with
  // every receipt and ledger row silently gone.
  const bases = shipper.currentBases();
  if (bases.length < 2) {
    throw new Error(
      `backup: only ${bases.length}/2 database base(s) are pinned (busy checkpoint on first run?) — retrying later instead of registering a partial snapshot`,
    );
  }
  // …and the two bases MUST be from ONE tick. The shipper breaks both
  // generations together precisely so they are (`coordinatedBreak`), but a
  // busy checkpoint can DEFER that break by a tick, and a manifest registered
  // in that window would pair a journal base with a vault base from a different
  // instant. Such a pair has no coordinated restore point: the newer base
  // already contains receipts for rows that live only in the older one's
  // SEGMENTS, so losing any one of those segments hands back history asserting
  // data the restore does not have. Refuse and retry — the next tick's break
  // re-bases both.
  if (bases[0]!.createdAtMs !== bases[1]!.createdAtMs) {
    throw new Error(
      `backup: the two database bases are from different ticks (` +
        bases.map((b) => `${b.db} @ ${b.createdAtMs}`).join(', ') +
        ') — a coordinated generation break is still pending; retrying later instead of ' +
        'registering an uncoordinated base pair',
    );
  }
  for (const base of bases) {
    entries.push({
      path: WAL_DB_FILES[base.db],
      kind: 'db',
      absolutePath: base.file,
      sha256: base.sha256,
      walGeneration: base.generation,
      // The tick both bases were cloned at — restore ASSERTS these are equal
      // before it touches a byte (`replayWalSegments`).
      baseTickMs: base.createdAtMs,
      // The newest pair marker this provider CONFIRMED accepting. It becomes a
      // floor: a later restore or verification that cannot reach it is looking
      // at a store that lost objects it acknowledged. Without it, deleting the
      // whole `wal/tick/` prefix is perfectly silent — every object the manifest
      // names is still there, and the restore just quietly returns the base pair.
      ...(opts.walTipTickMs !== undefined ? { walTipTickMs: opts.walTipTickMs } : {}),
    });
  }

  // (b) Blob CAS, read IN PLACE. A configured remote resolver is not proof
  // that every freshly-ingested blob has replicated; snapshots therefore
  // include local custody bytes until the manifest can carry per-blob remote
  // durability evidence. Correctness wins over temporary cross-store dedup.
  entries.push(...(await listBlobEntries(plane.dir)));

  // (c) Code store bundle.
  const bundle = await bundleCodeStore(plane, stagingDir, log);
  if (bundle) entries.push(bundle);

  // (d) Seal key, if this vault has ever sealed a value.
  const sealKey = sealKeyEntry(plane);
  if (sealKey) entries.push(sealKey);

  return entries;
}
