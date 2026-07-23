/*
 * Assemble one vault's `SourceEntry[]` for `createSnapshot` (FORMAT.md
 * "What a Centraid vault snapshot contains"): the WAL shipper's pinned base
 * clones first (each anchors that database's segment stream — issue #408;
 * the old `stageVaultDbs` VACUUM INTO staging is gone with the /1 format),
 * then the local blob CAS read in place, the code store's git bundle, and the
 * seal key. Remote-CAS configuration alone is not authenticated durability
 * evidence, so it never removes a blob from a restorable snapshot.
 */

import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  archivedSegmentShas,
  conversationArchiveShas,
  liveBlobShas,
  readBlobStoreSettings,
  readSealKeyFingerprint,
  ReplicaIndex,
  sealKeyFileFor,
} from '@centraid/vault';
import { WAL_DB_FILES, type EngineLogger, type SourceEntry } from '@centraid/backup';
import { GitError, run } from '../worktree-store/git.js';
import type { VaultPlane } from '../serve/vault-plane.js';

/** Every blob CAS file under `<vaultDir>/blobs/sha256/<fan>/<sha>` (`FsBlobStore`'s layout). */
async function listBlobEntries(
  vaultDir: string,
  only?: ReadonlySet<string>,
): Promise<SourceEntry[]> {
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
      if (only && !only.has(name)) continue;
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

/**
 * A stable fingerprint of the bare code store's refs — every branch + tag
 * `git bundle --all` would pack, plus HEAD. When this is unchanged since the
 * last snapshot, the bundle's bytes are unchanged too (a bundle is a function
 * of its reachable refs), so we can skip regenerating it entirely. `for-each-ref`
 * emits refs in a stable order (sorted by refname), so the digest is order-free.
 */
async function codeRefsDigest(bareDir: string): Promise<string> {
  const refs = await run(['for-each-ref', '--format=%(objectname) %(refname)'], { cwd: bareDir });
  const head = await run(['symbolic-ref', '--quiet', 'HEAD'], { cwd: bareDir }).catch(() => '');
  return createHash('sha256').update(`${head}\n${refs}`).digest('hex');
}

/**
 * The vault's app code store as a `git bundle --all`, written to a PERSISTENT
 * per-vault dir (`<backupDir>/code-bundle/<vaultId>/`, NOT the per-tick-wiped
 * `staging/`) so the file survives between backup ticks.
 *
 * The upload path treats the bundle like any other snapshot entry: fixed-part
 * chunk, dedup, encrypt, upload-if-new (`engine.ts`). That path already has a
 * `(size, mtime)`-keyed fast path that reuses a prior entry's chunk refs without
 * re-reading — but only if the FILE is byte-stable across ticks. The old code
 * bundled into `staging/`, which is wiped and rewritten every tick, so the
 * bundle looked new every time: a full-history `git pack-objects` repack (git's
 * default `pack.threads` is not even byte-deterministic on a grown repo) plus a
 * full re-read/re-chunk and, when the bytes drifted, a wholesale re-upload — all
 * for a code store that changes far less often than the backup cadence.
 *
 * So we gate on a ref digest (`codeRefsDigest`): if the store's refs are
 * unchanged since we last bundled (sidecar `apps.bundle.refs`), the existing
 * bundle file is reused UNTOUCHED — same size, same mtime — and the engine's
 * fast path reuses its chunks with zero git work, zero re-read, zero re-upload.
 * Only a real ref change (publish / rollback / delete) regenerates, and then
 * with `-c pack.threads=1` so the pack is byte-deterministic and the parts that
 * did not change still dedup against the previous snapshot's chunks.
 */
async function bundleCodeStore(
  plane: VaultPlane,
  bundleDir: string,
  log: EngineLogger,
): Promise<SourceEntry | undefined> {
  const bareDir = path.join(plane.codeStoreRoot, 'apps.git');
  if (!existsSync(path.join(bareDir, 'HEAD'))) {
    log.info?.('backup: no code store bare repo yet — skipping git-bundle entry');
    return undefined;
  }
  await fs.mkdir(bundleDir, { recursive: true });
  const bundlePath = path.join(bundleDir, 'apps.bundle');
  const digestPath = path.join(bundleDir, 'apps.bundle.refs');
  const digest = await codeRefsDigest(bareDir);

  // Reuse the standing bundle when the code store's refs have not moved: the
  // file stays byte-identical and untouched, so the engine skips it entirely.
  if (existsSync(bundlePath)) {
    const priorDigest = await fs.readFile(digestPath, 'utf8').catch(() => '');
    if (priorDigest === digest) {
      log.info?.('backup: code store unchanged since last snapshot — reusing apps.bundle');
      return { path: 'apps.bundle', kind: 'git-bundle', absolutePath: bundlePath };
    }
  }

  try {
    // `-c pack.threads=1`: single-threaded delta compression is byte-deterministic,
    // so an unchanged region of history produces identical parts run-to-run and
    // dedups against the previous snapshot's chunks instead of re-uploading.
    await run(['-c', 'pack.threads=1', 'bundle', 'create', bundlePath, '--all'], { cwd: bareDir });
    await fs.writeFile(digestPath, digest);
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
  /**
   * PERSISTENT per-vault dir the code-store bundle lives in
   * (`<backupDir>/code-bundle/<vaultId>/`). It is deliberately NOT wiped
   * between ticks: the standing `apps.bundle` (+ its `apps.bundle.refs` digest
   * sidecar) is reused untouched while the code store's refs have not moved, so
   * the engine's `(size, mtime)` fast path skips it entirely (see
   * `bundleCodeStore`). Every other entry is read in place — db bases from the
   * shipper's pinned clones, blobs from the CAS, the seal key from custody — so
   * this is the only directory assembly writes to, and there is no ephemeral
   * staging dir anymore.
   */
  bundleDir: string;
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
  const { plane, bundleDir, log } = opts;
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

  // (b) Blob CAS, read IN PLACE. In remote-primary mode provider-confirmed
  // objects are already the primary copy; re-snapshotting the whole local
  // cache defeats bounded storage. Pending outbox bytes and live local bytes
  // without replica evidence join the snapshot. The latter covers synchronous
  // archive/mint-spill ingress before the custody sweep has enqueued it.
  // Local-only mode still carries the complete resident CAS.
  const remotePrimary = readBlobStoreSettings(plane.db.vault).kind === 's3';
  let pending: Set<string> | undefined;
  if (remotePrimary) {
    pending = new Set(plane.db.blobTransfers.pendingSnapshotShas());
    const replicated = new ReplicaIndex(plane.db.vault).all();
    const live = liveBlobShas(plane.db.vault);
    for (const sha of archivedSegmentShas(plane.db.journal)) live.add(sha);
    for (const sha of conversationArchiveShas(plane.db.journal)) live.add(sha);
    for (const sha of live) if (!replicated.has(sha)) pending.add(sha);
  }
  entries.push(...(await listBlobEntries(plane.dir, pending)));

  // (c) Code store bundle — into the PERSISTENT bundleDir, reused across ticks
  // when the code store's refs have not moved (see `bundleCodeStore`).
  const bundle = await bundleCodeStore(plane, bundleDir, log);
  if (bundle) entries.push(bundle);

  // (d) Seal key, if this vault has ever sealed a value.
  const sealKey = sealKeyEntry(plane);
  if (sealKey) entries.push(sealKey);

  return entries;
}
