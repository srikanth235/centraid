/*
 * `recover()` — the recovery VERB (issue #439 R1). One shell-agnostic
 * service-layer orchestration that turns "a blank machine plus the recovery
 * kit and the provider api-key" into a live vault. The CLI (`cli/recover-admin.ts`)
 * and, later, the pre-vault HTTP `/recover` routes (wave 4) are thin shells
 * over THIS function — not UI wrapping CLI.
 *
 * It composes machinery that already exists, in this order:
 *   1. discovering — parse the kit, reach the provider, list snapshots, and
 *      gate compatibility from the registry row's `appMeta` ALONE (no manifest,
 *      no chunk, no egress byte — a refusal here can never bill a metered home).
 *   2. fetching + replaying — a lazy restore into a staging dir inside the vault
 *      root (same device ⇒ the adopt is an atomic rename), deferring every blob
 *      the provider's ATTESTED cas inventory holds; WAL replay to tip happens
 *      inside `restoreSnapshot`.
 *   3. fencing — seed the recovered gateway's backup state at
 *      `currentGeneration + 1`, so this machine's FIRST post-recovery backup
 *      registers fenced and the superseded machine's next registration 409s
 *      (PROTOCOL.md § Generation fencing). recover() does NOT itself register —
 *      it only seeds the token.
 *   4. adopting — the staging dir becomes `<root>/<vaultId>` (rename). The
 *      `RESTORE_QUARANTINE.json` marker rides along and fires on FIRST mount,
 *      exactly as designed (`vault-quarantine.ts`). The R5 adopt-time inventory
 *      reconcile (wave 3) and the live-gateway mount (wave 4) slot into the
 *      `onAdopted` hook right here.
 *   5. warming — previews-first warm pass when a remote tier is constructible
 *      in-context; otherwise HONESTLY skipped and reported (never faked).
 *
 * The completion report is honest: recovered-as-of T (the coordinated WAL cut),
 * truncated-or-not, how many blobs were deferred, whether previews warmed or
 * why they didn't, and what the quarantine parks on first mount.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  assertCompatibleAppMeta,
  parseRecoveryKit,
  restoreSnapshot,
  saveKeyring,
  type BackupProvider,
  type EngineLogger,
  type Keyring,
  type RecoveryKitTarget,
  type SnapshotRow,
} from '@centraid/backup';
import type { RemoteTier } from '@centraid/vault';
import {
  buildProviderFromTarget,
  collectRemoteCasShas,
  currentVersions,
  invalidateRestoredReplica,
  pickSnapshotRow,
  placeSealKey,
  recoveredAsOfMs,
  seedFencedBackupState,
  selectTarget,
  walReplayTruncated,
  warmOrSkip,
} from './recover-internals.js';

/** The user-facing phases wave 4's SSE narrates. Machine vocabulary (seq, WAL,
 *  lazy) stays out of it — these map to "fetching your vault → replaying recent
 *  changes → warming previews" in the UI. */
export type RecoverPhase =
  | 'discovering'
  | 'fetching'
  | 'replaying'
  | 'fencing'
  | 'adopting'
  | 'warming'
  | 'done';

/** Everything the post-adopt extension point (issue #439 R5 wave 3 / wave 4's
 *  live mount) needs to act on the freshly adopted vault. */
export interface RecoverAdoptContext {
  vaultId: string;
  /** `<vaultRoot>/<vaultId>` — the adopted live vault directory. */
  vaultDir: string;
  targetId: string;
  provider: BackupProvider;
  keyring: Keyring;
}

export interface RecoverInput {
  /** The recovery-kit document, already JSON-parsed (validated by `parseRecoveryKit`). */
  kitDocument: unknown;
  /** The provider api-key — deliberately NOT in the kit (FORMAT.md); supplied out-of-band. */
  apiKey: string;
  /** Vault registry root (`<dataDir>/vault`) the recovered vault is adopted into. */
  vaultRoot: string;
  /** Backup-engine state dir (`<dataDir>/backup`) — keyring + fenced target state land here. */
  backupDir: string;
  /** Point-in-time recovery (issue #408): newest snapshot at/before this instant + WAL replay to it. Epoch ms. */
  at?: number;
  /** Force a FULL restore — materialize every blob (the `--full` override); no inventory skip-set. */
  full?: boolean;
  /** Which vault to recover when the kit carries more than one target (else the sole target). */
  vaultId?: string;
  now?: () => number;
  log?: EngineLogger;
  onPhase?: (phase: RecoverPhase) => void;
  /** Test / wave-4 seam: a pre-built provider (else one is built from the kit target + apiKey). */
  provider?: BackupProvider;
  /**
   * Warm-pass tier resolver (issue #439): build a `RemoteTier` over the restored
   * vault's remote CAS, or return undefined to SKIP the warm pass honestly. The
   * headless CLI passes nothing (no credential wiring pre-mount ⇒ skip, reported);
   * wave 4's live gateway wires the gateway's `s3Credentials` resolver and opens
   * the restored vault to hand back its own `.remote()` tier.
   */
  resolveRemoteTier?: (
    ctx: RecoverAdoptContext,
  ) => RemoteTier | undefined | Promise<RemoteTier | undefined>;
  /**
   * Post-adopt extension point (issue #439). Runs immediately AFTER the staging
   * dir becomes the live vault directory and BEFORE the warm pass. Wave 3's R5
   * adopt-time inventory reconcile and wave 4's live `VaultRegistry.adopt` +
   * mount are inserted here — a real, named seam, not a deferred marker.
   */
  onAdopted?: (ctx: RecoverAdoptContext) => void | Promise<void>;
}

/** The previews-first warm outcome, or the honest reason it was skipped. */
export type PreviewsRecoverOutcome =
  | {
      warmed: true;
      tiniesWarmed: number;
      tiniesTotal: number;
      tiniesFailed: number;
      timeToUsableGridMs: number;
    }
  | { warmed: false; reason: string };

/** The honest completion report (issue #439 R1). */
export interface RecoverReport {
  vaultId: string;
  targetId: string;
  /** The provider addressing from the kit (base URL, or `local:<dir>`). */
  provider: string;
  /** `<vaultRoot>/<vaultId>` — the adopted vault directory (quarantine fires on first mount). */
  vaultDir: string;
  /** The restored snapshot's seq. */
  seq: number;
  /** The fenced generation seeded for this gateway's first post-recovery backup. */
  generation: number;
  /** Recovered-as-of (epoch ms): the coordinated WAL cut, or the snapshot's registration time. */
  recoveredAsOf: number;
  /** True when a db's WAL replay could not reach its newest registered tick (objects gone). */
  truncated: boolean;
  /** Blobs deferred remote-only (the provider's attested cas inventory held them); served on demand. */
  skippedBlobs: number;
  /** Whether the provider attested a cas inventory to build the skip-set from (else a full restore). */
  inventoryConsulted: boolean;
  /** The provider's egress class (PROTOCOL.md `restoreCostClass`), for the honest cost line. */
  restoreCostClass: 'free-egress' | 'metered-egress' | undefined;
  /** Warm-pass result or the honest skip reason. */
  previews: PreviewsRecoverOutcome;
  /** What the `RESTORE_QUARANTINE.json` marker parks the first time the vault mounts. */
  quarantine: string[];
}

/**
 * The pre-restore "found your vault" facts (issue #439 R1/R6) — the size/asOf/
 * provider/cost the CLI prints and the metered-egress gate consults BEFORE any
 * restore work, WITHOUT downloading a manifest. Mirrors Wave 1's
 * `RestoreEgressEstimate` shape (`costClass`, `seq`, `fullBytes`, `lazyAvailable`)
 * so the recovery UI (#436 §5) can render the same card later. `provider` rides
 * back so a shell can pass the already-built client into `recover()` rather than
 * dialing the provider twice.
 */
export interface RecoveryDiscovery {
  target: RecoveryKitTarget;
  provider: BackupProvider;
  seq: number | undefined;
  /** Whole-library download for a `--full` restore (the selected row's `totalBytes`). */
  fullBytes: number | undefined;
  /** Approximate recovered-as-of (the selected row's registration time, epoch ms). */
  recoveredAsOf: number | undefined;
  restoreCostClass: 'free-egress' | 'metered-egress' | undefined;
  /** True when the provider attests an inventory ⇒ lazy defers the bulk download. */
  lazyAvailable: boolean;
}

export async function discoverRecovery(opts: {
  kitDocument: unknown;
  apiKey: string;
  vaultId?: string;
  at?: number;
  provider?: BackupProvider;
}): Promise<RecoveryDiscovery> {
  const kit = parseRecoveryKit(opts.kitDocument);
  const target = selectTarget(kit.targets, opts.vaultId);
  const provider = opts.provider ?? buildProviderFromTarget(target, opts.apiKey);
  const caps = await provider.capabilities();
  let row: SnapshotRow | undefined;
  try {
    row = pickSnapshotRow(await provider.listSnapshots(target.targetId), opts.at);
  } catch {
    // Provider unreachable / no snapshot yet: report "unknown" rather than block
    // the facts card on a byte count.
    row = undefined;
  }
  return {
    target,
    provider,
    seq: row?.seq,
    fullBytes: row?.totalBytes,
    recoveredAsOf: row ? row.createdAt * 1000 : undefined,
    restoreCostClass: caps.backup?.restoreCostClass,
    lazyAvailable: caps.capabilities.includes('inventory'),
  };
}

export async function recover(input: RecoverInput): Promise<RecoverReport> {
  const now = input.now ?? Date.now;
  const log: EngineLogger = {
    info: (m) => input.log?.info?.(m),
    warn: (m) => input.log?.warn?.(m),
  };
  const emit = (phase: RecoverPhase): void => input.onPhase?.(phase);

  // ── discovering ──────────────────────────────────────────────────────
  emit('discovering');
  const kit = parseRecoveryKit(input.kitDocument);
  const target = selectTarget(kit.targets, input.vaultId);
  const provider = input.provider ?? buildProviderFromTarget(target, input.apiKey);
  const caps = await provider.capabilities();
  const restoreCostClass = caps.backup?.restoreCostClass;
  const current = currentVersions();
  const rows = await provider.listSnapshots(target.targetId);
  const row = pickSnapshotRow(rows, input.at);
  if (!row) {
    throw new Error(
      input.at !== undefined
        ? `recover: no snapshot at or before ${new Date(input.at).toISOString()} for this vault`
        : 'recover: this vault has no snapshot on the provider yet',
    );
  }
  // Compatibility gate from the registry row's appMeta ALONE — refuse a
  // snapshot written by newer software BEFORE a manifest, a chunk, or an egress
  // byte is touched (a refusal here can never bill a metered home).
  assertCompatibleAppMeta(row.appMeta, current);

  // The lazy skip-set: which blobs the provider's ATTESTED inventory holds. No
  // `inventory` capability ⇒ full restore (honest fallback, nothing skipped).
  const lazy = input.full !== true;
  let remoteShas: Set<string> | undefined;
  let inventoryConsulted = false;
  if (lazy && provider.listInventory) {
    remoteShas = await collectRemoteCasShas(provider, target.targetId);
    inventoryConsulted = true;
  }

  // ── fetching + replaying ─────────────────────────────────────────────
  emit('fetching');
  await fs.mkdir(input.vaultRoot, { recursive: true });
  const finalDir = path.join(input.vaultRoot, target.vaultId);
  if (existsSync(finalDir)) {
    throw new Error(
      `recover: "${finalDir}" already exists — refusing to recover over an existing vault directory`,
    );
  }
  // Stage INSIDE the vault root (same filesystem ⇒ the adopt below is an atomic
  // rename). The dot prefix keeps `VaultRegistry.scan()` from mounting the
  // half-written dir mid-restore (see vault-registry.ts).
  const stagingDir = path.join(
    input.vaultRoot,
    `.recover-staging-${randomBytes(8).toString('hex')}`,
  );
  try {
    const restore = await restoreSnapshot({
      provider,
      targetId: target.targetId,
      keyring: kit.keyring,
      vaultId: target.vaultId,
      ...(input.at !== undefined ? { pointInTimeMs: input.at } : {}),
      destDir: stagingDir,
      current,
      // Defer any blob the remote CAS attests it holds; a blob the inventory
      // does NOT name is materialized (the snapshot is its only copy).
      ...(remoteShas ? { skipBlob: ({ sha }) => remoteShas!.has(sha) } : {}),
      log,
    });
    emit('replaying');
    // The restored replica index attests capture-time durability, not now.
    invalidateRestoredReplica(stagingDir);

    // ── fencing ────────────────────────────────────────────────────────
    emit('fencing');
    const targetInfo = await provider.getTarget(target.targetId);
    const fencedGeneration = targetInfo.currentGeneration + 1;
    await seedFencedBackupState({
      backupDir: input.backupDir,
      vaultId: target.vaultId,
      target,
      fencedGeneration,
      lastSeq: restore.seq,
      now,
    });
    // The recovered gateway must hold the SAME keyring to read these snapshots
    // and to keep backing up under the same key. Refuse to clobber an existing
    // one — recovery is a blank-machine act.
    const keyringPath = path.join(input.backupDir, 'keyring.json');
    if (existsSync(keyringPath)) {
      throw new Error(
        `recover: a keyring already exists at ${keyringPath} — this machine is not blank; ` +
          'refusing to overwrite live key material',
      );
    }
    await saveKeyring(keyringPath, kit.keyring);

    // ── adopting ───────────────────────────────────────────────────────
    emit('adopting');
    await fs.rename(stagingDir, finalDir);
    await placeSealKey(finalDir, log);
    const adoptCtx: RecoverAdoptContext = {
      vaultId: target.vaultId,
      vaultDir: finalDir,
      targetId: target.targetId,
      provider,
      keyring: kit.keyring,
    };
    // Extension point: wave 3 R5 inventory reconcile + wave 4 live mount.
    await input.onAdopted?.(adoptCtx);

    // ── warming ────────────────────────────────────────────────────────
    emit('warming');
    const previews = await warmOrSkip(input, adoptCtx, restore.skippedBlobs.length, now, log);

    emit('done');
    return {
      vaultId: target.vaultId,
      targetId: target.targetId,
      provider: target.provider,
      vaultDir: finalDir,
      seq: restore.seq,
      generation: fencedGeneration,
      recoveredAsOf: recoveredAsOfMs(restore.walReplay, row),
      truncated: walReplayTruncated(restore.walReplay),
      skippedBlobs: restore.skippedBlobs.length,
      inventoryConsulted,
      restoreCostClass,
      previews,
      quarantine: ['outbox', 'automations', 'connections'],
    };
  } catch (err) {
    // Never leave staging scratch behind (the final dir, if the rename
    // already ran, is a real vault and is left in place).
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}
