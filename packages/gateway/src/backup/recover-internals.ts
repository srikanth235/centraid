/*
 * The step helpers behind `recover()` (issue #439 R1) — kept beside the
 * orchestration (`recover.ts`) rather than inside it so the verb reads as its
 * six phases while the how-of-each-phase lives here: kit-target → provider
 * resolution, the attested-inventory skip-set, the seal-key custody relocation,
 * the fenced backup-state seed, and the warm-or-honestly-skip decision.
 */

import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  openLocalBackupProvider,
  openRemoteBackupProvider,
  type BackupProvider,
  type EngineLogger,
  type RecoveryKitTarget,
  type RestoreCurrentVersions,
  type SnapshotRow,
  type WalReplayOutcome,
} from '@centraid/backup';
import {
  bumpReplicaEpoch,
  ONTOLOGY_VERSION,
  sealKeyFileFor,
  VAULT_MIGRATIONS,
} from '@centraid/vault';
import { run } from '../worktree-store/git.js';
import { GATEWAY_VERSION } from '../version.js';
import { loadBackupState, saveBackupState } from './backup-state.js';
import { warmPreviewTinies } from './restore-warm.js';
import type { PreviewsRecoverOutcome, RecoverAdoptContext, RecoverInput } from './recover.js';

const LOCAL_PROVIDER_PREFIX = 'local:';

/** Build a provider from the kit target's addressing + the out-of-band api-key.
 *  A remote home carries its base URL in `provider`; an operator/test local
 *  provider carries `local:<dir>` (the api-key is irrelevant to it). */
export function buildProviderFromTarget(target: RecoveryKitTarget, apiKey: string): BackupProvider {
  if (target.provider.startsWith(LOCAL_PROVIDER_PREFIX)) {
    return openLocalBackupProvider({
      rootDir: target.provider.slice(LOCAL_PROVIDER_PREFIX.length),
    });
  }
  return openRemoteBackupProvider({ baseUrl: target.provider, apiKey });
}

/** Choose which target the kit names to recover. One vault ⇒ that one; several
 *  ⇒ the caller must name it (`--vault`) — recovery restores one vault, and
 *  silently picking one of several would be a footgun. */
export function selectTarget(
  targets: RecoveryKitTarget[],
  vaultId: string | undefined,
): RecoveryKitTarget {
  if (vaultId !== undefined) {
    const match = targets.find((t) => t.vaultId === vaultId);
    if (!match) {
      throw new Error(
        `recover: the recovery kit has no vault "${vaultId}" (it carries: ${targets
          .map((t) => t.vaultId)
          .join(', ')})`,
      );
    }
    return match;
  }
  if (targets.length === 1) return targets[0]!;
  throw new Error(
    `recover: the recovery kit carries ${targets.length} vaults — choose one with --vault ` +
      `(${targets.map((t) => t.vaultId).join(', ')})`,
  );
}

/** The snapshot a restore selects, from a newest-first `listSnapshots` result:
 *  the newest at/before `--at`, else the newest. This is the row the compat gate
 *  runs against; `restoreSnapshot` re-selects (by base tick) and re-gates. */
export function pickSnapshotRow(
  rows: SnapshotRow[],
  at: number | undefined,
): SnapshotRow | undefined {
  if (at !== undefined) return rows.find((r) => r.createdAt * 1000 <= at);
  return rows[0];
}

/** Map a cas-store inventory key to its content sha — the SAME mapping the
 *  reconcile audit uses (`backup-cas-diff.ts`): objects land at
 *  `blobs/sha256/<sha>` under the cas prefix. */
function casShaOf(key: string): string | undefined {
  return /(?:^|\/)blobs\/(?:sha256\/)?([0-9a-f]{64})$/.exec(key)?.[1];
}

/** Paginate the provider's ATTESTED cas inventory into the set of shas it holds
 *  durably (issue #439). A blob in this set is deferred at restore (remote-only,
 *  read-through on demand); a blob NOT in it is materialized — the snapshot is
 *  its only copy. `state: 'live'` only: a soft-deleted object is being removed,
 *  not durable. */
export async function collectRemoteCasShas(
  provider: BackupProvider,
  targetId: string,
): Promise<Set<string>> {
  const shas = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await provider.listInventory!(targetId, {
      store: 'cas',
      ...(cursor !== undefined ? { cursor } : {}),
    });
    for (const object of page.objects) {
      if (object.state !== 'live') continue;
      const sha = casShaOf(object.key);
      if (sha) shas.add(sha);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return shas;
}

/**
 * Move the restored seal key into custody position (issue #439 R1). The snapshot
 * carries the vault's sealed-columns DEK as a `seal.key` entry that restore
 * materializes at `<vaultDir>/seal.key`, but `openVaultDb` resolves it from the
 * `keys/` SIBLING of the vault dir (`sealKeyFileFor`, issue #298). Without this
 * relocation a recovered vault with ANY sealed secret would brick on first
 * mount (`SealKeyError('missing')`) — the very "placebo restore" FORMAT.md warns
 * about. A vault with no sealed columns ships no `seal.key`, so this is a no-op
 * for it (`existsSync` guard).
 */
export async function placeSealKey(vaultDir: string, log: EngineLogger): Promise<void> {
  const restored = path.join(vaultDir, 'seal.key');
  if (!existsSync(restored)) return;
  const dest = sealKeyFileFor(vaultDir);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rename(restored, dest);
  log.info?.(`recover: placed the restored seal key at ${dest}`);
}

/**
 * Rehydrate the app code store from the restored git bundle (issue #517). The
 * snapshot carries the vault's bare code repo as a `git bundle --all` that
 * `restoreSnapshot` materializes at `<vaultDir>/apps.bundle`, but the runtime
 * reads app code from the bare repo `WorktreeStore` owns at
 * `<vaultDir>/code/apps.git` (`VaultPlane.codeStoreRoot` + the store's
 * `apps.git` layout). Nothing else bridges the two: `WorktreeStore.init()`
 * only ever `git init --bare`s a FRESH empty repo when `apps.git/HEAD` is
 * absent. So without this a recovered vault mounts with all its data and an
 * EMPTY code store — every published app's code silently gone, the "data with
 * no apps" placebo restore FORMAT.md warns about.
 *
 * `git clone --bare <bundle>` brings back every ref the `--all` bundle carries
 * — `main`, each `<app>/v*` version tag (what rollback restores), and any live
 * session branch — and sets `HEAD -> main`, exactly `WorktreeStore.init()`'s
 * precondition (it then skips its own init/empty-commit and just materializes
 * main). The consumed bundle is removed: the bare repo is the code store now,
 * and a stray `apps.bundle` at the vault root is only clutter a future scan
 * could trip on.
 *
 * A vault whose source code store was empty ships no bundle (`bundleCodeStore`
 * skips an empty bare repo), so this is a no-op for it (`existsSync` guard) and
 * `WorktreeStore.init()` plants the fresh empty repo as before.
 */
export async function rehydrateCodeStore(vaultDir: string, log: EngineLogger): Promise<void> {
  const bundle = path.join(vaultDir, 'apps.bundle');
  if (!existsSync(bundle)) return;
  // `<vaultDir>/code` is `VaultPlane.codeStoreRoot`; `apps.git` under it is the
  // bare repo `WorktreeStore` opens (both layout constants are private to their
  // owners, so they are spelled out here the way `placeSealKey` spells `seal.key`).
  const bareDir = path.join(vaultDir, 'code', 'apps.git');
  await fs.mkdir(path.dirname(bareDir), { recursive: true });
  await run(['clone', '--bare', bundle, bareDir], { cwd: vaultDir });
  await fs.rm(bundle, { force: true });
  log.info?.(`recover: rehydrated the app code store at ${bareDir} from apps.bundle`);
}

/** A materialized restore is a NEW replica history, never a continuation — the
 *  restored `blob_replica` rows attest capture-time durability, not now (issue
 *  #439 gap 4). Bump the epoch so nothing trusts them; the R5 reconcile (wave 3)
 *  re-establishes truth against the live inventory. */
export function invalidateRestoredReplica(destDir: string): void {
  const vault = new DatabaseSync(path.join(destDir, 'vault.db'));
  try {
    bumpReplicaEpoch(vault, { reason: 'backup-restore' });
  } finally {
    vault.close();
  }
}

/** Recovered-as-of: the single instant both databases were coordinated-cut to
 *  (the honest "everything safe as of T"); the snapshot's registration time when
 *  the restore was base-pair-only (no WAL). */
export function recoveredAsOfMs(walReplay: WalReplayOutcome, row: SnapshotRow): number {
  return walReplay.coordinatedCutMs >= 0 ? walReplay.coordinatedCutMs : row.createdAt * 1000;
}

/** Truncated = a db could not be replayed to the newest tick the provider
 *  ACKNOWLEDGED (objects are gone) — the same honest signal restore-verify
 *  reports, plus the per-db chain signal. */
export function walReplayTruncated(walReplay: WalReplayOutcome): boolean {
  const shortOfTip =
    walReplay.expectedCutMs >= 0 && walReplay.coordinatedCutMs < walReplay.expectedCutMs;
  return shortOfTip || Object.values(walReplay.perDb).some((db) => db.truncated);
}

/** The current gateway's version ceiling — the compat gate's "what can this
 *  build read". A pre-vault restore has no live plane to read a PRAGMA off, so
 *  `vaultUserVersion` is what THIS build understands (mirrors backup-service). */
export function currentVersions(): RestoreCurrentVersions {
  return {
    gatewayVersion: GATEWAY_VERSION,
    vaultUserVersion: String(VAULT_MIGRATIONS.length),
    ontologyVersion: ONTOLOGY_VERSION,
  };
}

/** Previews-first warm pass, or the honest reason it was skipped (issue #439).
 *  Warms ONLY when a tier resolver yields a `RemoteTier`; a full restore or a
 *  resolver-less headless context reports `warmed:false` with a reason. */
export async function warmOrSkip(
  input: RecoverInput,
  ctx: RecoverAdoptContext,
  deferredCount: number,
  now: () => number,
  log: EngineLogger,
): Promise<PreviewsRecoverOutcome> {
  if (input.full) {
    return {
      warmed: false,
      reason: 'full restore — every blob was materialized, no warm pass needed',
    };
  }
  if (!input.resolveRemoteTier) {
    return {
      warmed: false,
      reason:
        'no remote CAS tier resolver in this context (headless recovery) — ' +
        `${deferredCount} deferred blob(s) and every preview stream in on demand after the vault mounts`,
    };
  }
  const remote = await input.resolveRemoteTier(ctx);
  if (!remote) {
    return {
      warmed: false,
      reason: 'the recovered vault has no durable remote CAS tier — previews stream in on demand',
    };
  }
  const warm = await warmPreviewTinies({
    destDir: ctx.vaultDir,
    remote,
    startedAtMs: now(),
    now,
    log,
  });
  return {
    warmed: true,
    tiniesWarmed: warm.tiniesWarmed,
    tiniesTotal: warm.tiniesTotal,
    tiniesFailed: warm.tiniesFailed,
    timeToUsableGridMs: warm.timeToUsableGridMs,
  };
}

/**
 * Seed the recovered gateway's backup state for this target at
 * `generation = currentGeneration + 1` (+ `lastSeq` from the restored snapshot),
 * following backup-state.ts's exact atomic read/write. This is the fencing
 * TOKEN, not the fence itself: the first post-recovery backup registers at this
 * generation, which bumps the provider's `currentGeneration`, and only THEN does
 * the superseded machine's next registration (still at the old generation) 409.
 *
 * `providerRef` is deliberately OMITTED: at recovery time the recovered
 * gateway's eventual backend resolution isn't known, and `assertTargetBackend`
 * treats an absent `providerRef` as "trust a static config backend" (the
 * headless daemon this serves) — a dynamic storage-connection backend (wave 4's
 * desktop) sets it through its own adopt wiring.
 */
export async function seedFencedBackupState(opts: {
  backupDir: string;
  vaultId: string;
  target: RecoveryKitTarget;
  fencedGeneration: number;
  lastSeq: number;
  now: () => number;
}): Promise<void> {
  const state = await loadBackupState(opts.backupDir);
  const stamp = new Date(opts.now()).toISOString();
  state.targets[opts.vaultId] = {
    targetId: opts.target.targetId,
    label: opts.target.label,
    generation: opts.fencedGeneration,
    lastSeq: opts.lastSeq,
    // A grace baseline so the recovered gateway's health doesn't read "never
    // backed up" — it holds a real restored snapshot at `lastSeq`.
    firstBackupAt: stamp,
    lastBackupAt: stamp,
  };
  await saveBackupState(opts.backupDir, state);
}
