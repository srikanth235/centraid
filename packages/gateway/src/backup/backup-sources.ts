/*
 * Assemble one vault's `SourceEntry[]` for `createSnapshot` (FORMAT.md
 * "What a Centraid vault snapshot contains" + its ordering rule): staged DB
 * copies first, then the blob CAS (read in place — never duplicated into
 * staging, issue: the 100+GB duplication `backupVault()` would cost), then
 * the code store's git bundle, then the seal key. Blobs added mid-snapshot
 * are extras never holes because the DB staging copy is taken first.
 */

import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readSealKeyFingerprint, sealKeyFileFor, stageVaultDbs } from '@centraid/vault';
import type { EngineLogger, SourceEntry } from '@centraid/backup';
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
  log: EngineLogger;
}

/** Build the full `SourceEntry[]` for one backup tick, in FORMAT.md's order. */
export async function assembleSourceEntries(opts: AssembleOptions): Promise<SourceEntry[]> {
  const { plane, stagingDir, log } = opts;
  const entries: SourceEntry[] = [];

  // (a) DB staging FIRST (FORMAT.md ordering rule) — point-in-time,
  // consistent VACUUM INTO copies; the CAS is append-only from here on, so
  // every blob these DBs reference already exists on disk.
  const staged = stageVaultDbs(plane.db, stagingDir);
  entries.push({ path: 'vault.db', kind: 'db', absolutePath: staged.vaultPath });
  entries.push({ path: 'journal.db', kind: 'db', absolutePath: staged.journalPath });

  // (b) Blob CAS, read IN PLACE — never duplicated into staging.
  entries.push(...(await listBlobEntries(plane.dir)));

  // (c) Code store bundle.
  const bundle = await bundleCodeStore(plane, stagingDir, log);
  if (bundle) entries.push(bundle);

  // (d) Seal key, if this vault has ever sealed a value.
  const sealKey = sealKeyEntry(plane);
  if (sealKey) entries.push(sealKey);

  return entries;
}
