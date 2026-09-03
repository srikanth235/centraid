import { randomBytes } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import {
  assertCompatibleAppMeta,
  canonicalJson,
  materializeSnapshotBlobs,
  parseRecoveryKit,
  restoreSnapshot,
  validateKeyring,
} from "@centraid/backup";
import type {
  BackupProvider,
  Keyring,
  RecoveryKitTarget,
  SnapshotRow,
} from "@centraid/backup";
import { KeyStore } from "@centraid/vault";
import type { RemoteTier } from "@centraid/vault";

import { GatewayDatabase } from "../serve/gateway-db.js";
import { deriveBackupSourceInstanceId } from "./backup-state.js";
import {
  buildProviderFromTarget,
  collectRemoteCasShas,
  currentVersions,
  invalidateRestoredReplica,
  pickSnapshotRow,
  recoveredAsOfMs,
  rehydrateCodeStore,
  seedFencedBackupState,
  selectTarget,
  walReplayTruncated,
  warmOrSkip,
} from "./recover-internals.js";
import { reconcileAdoptedInventory } from "./recover-reconcile.js";
import type { ReconcileLogger, ReconcileReport } from "./recover-reconcile.js";

export type RecoverPhase =
  | "discovering"
  | "fetching"
  | "replaying"
  | "fencing"
  | "adopting"
  | "warming"
  | "done";

export interface RecoverAdoptContext {
  vaultId: string;
  vaultDir: string;
  targetId: string;
  provider: BackupProvider;
  keyring: Keyring;
}

export interface RecoverInput {
  kitDocument: unknown;
  password: string;
  apiKey: string;
  vaultRoot: string;
  gatewayDatabase?: GatewayDatabase;
  keyStore?: KeyStore;
  sourceInstanceId?: string;
  dataDir?: string;
  at?: number;
  full?: boolean;
  vaultId?: string;
  now?: () => number;
  log?: ReconcileLogger;
  onPhase?: (phase: RecoverPhase) => void;
  provider?: BackupProvider;
  resolveRemoteTier?: (
    ctx: RecoverAdoptContext
  ) => RemoteTier | undefined | Promise<RemoteTier | undefined>;
  onAdopted?: (ctx: RecoverAdoptContext) => void | Promise<void>;
}

export type PreviewsRecoverOutcome =
  | {
      warmed: true;
      tiniesWarmed: number;
      tiniesTotal: number;
      tiniesFailed: number;
      timeToUsableGridMs: number;
    }
  | { warmed: false; reason: string };

export interface RecoverReport {
  vaultId: string;
  targetId: string;
  provider: string;
  vaultDir: string;
  seq: number;
  generation: number;
  recoveredAsOf: number;
  truncated: boolean;
  skippedBlobs: number;
  inventoryConsulted: boolean;
  restoreCostClass: "free-egress" | "metered-egress" | undefined;
  previews: PreviewsRecoverOutcome;
  reconcile: ReconcileReport;
  quarantine: string[];
}

export interface RecoveryDiscovery {
  target: RecoveryKitTarget;
  provider: BackupProvider;
  seq: number | undefined;
  fullBytes: number | undefined;
  recoveredAsOf: number | undefined;
  restoreCostClass: "free-egress" | "metered-egress" | undefined;
  lazyAvailable: boolean;
  compatible: boolean;
  incompatibleReason?: string;
}

export async function discoverRecovery(opts: {
  kitDocument: unknown;
  password: string;
  apiKey: string;
  vaultId?: string;
  at?: number;
  provider?: BackupProvider;
}): Promise<RecoveryDiscovery> {
  const kit = parseRecoveryKit(opts.kitDocument, opts.password);
  const target = selectTarget(kit.targets, opts.vaultId);
  const provider =
    opts.provider ?? buildProviderFromTarget(target, opts.apiKey);
  const caps = await provider.capabilities();
  let row: SnapshotRow | undefined;
  try {
    row = pickSnapshotRow(
      await provider.listSnapshots(target.targetId),
      opts.at
    );
  } catch {
    row = undefined;
  }
  let compatible = true;
  let incompatibleReason: string | undefined;
  if (row) {
    try {
      assertCompatibleAppMeta(row.appMeta, currentVersions());
    } catch (error) {
      compatible = false;
      incompatibleReason =
        error instanceof Error ? error.message : String(error);
    }
  }
  return {
    target,
    provider,
    seq: row?.seq,
    fullBytes: row?.totalBytes,
    recoveredAsOf: row ? row.createdAt * 1000 : undefined,
    restoreCostClass: caps.backup?.restoreCostClass,
    lazyAvailable: caps.capabilities.includes("inventory"),
    compatible,
    ...(incompatibleReason === undefined ? {} : { incompatibleReason }),
  };
}

export async function recover(input: RecoverInput): Promise<RecoverReport> {
  const dataDir = input.dataDir
    ? path.resolve(input.dataDir)
    : path.dirname(path.resolve(input.vaultRoot));
  const gatewayDatabase =
    input.gatewayDatabase ?? GatewayDatabase.open(dataDir);
  const keyStore = input.keyStore ?? new KeyStore(path.join(dataDir, "keys"));
  const sourceInstanceId =
    input.sourceInstanceId ??
    deriveBackupSourceInstanceId(keyStore.loadOrCreate("endpoint-key.bin"));
  const now = input.now ?? Date.now;
  const log: ReconcileLogger = {
    info: (m) => input.log?.info?.(m),
    warn: (m) => input.log?.warn?.(m),
    error: (m) => (input.log?.error ?? input.log?.warn)?.(m),
  };
  const emit = (phase: RecoverPhase): void => input.onPhase?.(phase);

  emit("discovering");
  const kit = parseRecoveryKit(input.kitDocument, input.password);
  const target = selectTarget(kit.targets, input.vaultId);
  const provider =
    input.provider ?? buildProviderFromTarget(target, input.apiKey);
  const caps = await provider.capabilities();
  const restoreCostClass = caps.backup?.restoreCostClass;
  const current = currentVersions();
  const rows = await provider.listSnapshots(target.targetId);
  const row = pickSnapshotRow(rows, input.at);
  if (!row) {
    throw new Error(
      input.at === undefined
        ? "recover: this vault has no snapshot on the provider yet"
        : `recover: no snapshot at or before ${new Date(input.at).toISOString()} for this vault`
    );
  }
  assertCompatibleAppMeta(row.appMeta, current);

  const lazy = input.full !== true;
  const remoteShas = provider.listInventory
    ? await collectRemoteCasShas(provider, target.targetId)
    : undefined;
  const inventoryConsulted = lazy && remoteShas !== undefined;

  emit("fetching");
  await fs.mkdir(input.vaultRoot, { recursive: true });
  const finalDir = path.join(input.vaultRoot, target.vaultId);
  if (existsSync(finalDir)) {
    throw new Error(
      `recover: "${finalDir}" already exists — refusing to recover over an existing vault directory`
    );
  }
  const restoreWorkDir = path.join(
    input.vaultRoot,
    `.recover-work-${randomBytes(8).toString("hex")}`
  );
  try {
    const restore = await restoreSnapshot({
      provider,
      targetId: target.targetId,
      keyring: kit.keyring,
      vaultId: target.vaultId,
      ...(input.at === undefined ? {} : { pointInTimeMs: input.at }),
      destDir: restoreWorkDir,
      current,
      ...(lazy && remoteShas
        ? { skipBlob: ({ sha }) => remoteShas.has(sha) }
        : {}),
      log,
    });
    emit("replaying");
    invalidateRestoredReplica(restoreWorkDir);

    emit("fencing");
    const targetInfo = await provider.getTarget(target.targetId);
    const fencedGeneration = targetInfo.currentGeneration + 1;
    await seedFencedBackupState({
      gatewayDatabase,
      sourceInstanceId,
      vaultId: target.vaultId,
      target,
      fencedGeneration,
      lastSeq: restore.seq,
      now,
    });
    const existingKeyring = keyStore.export("keyring.key");
    if (existingKeyring) {
      const existing = validateKeyring(
        JSON.parse(existingKeyring.toString("utf8"))
      );
      if (canonicalJson(existing) !== canonicalJson(kit.keyring)) {
        throw new Error(
          "recover: gateway custody contains a different backup keyring; refusing to overwrite live key material"
        );
      }
    } else {
      keyStore.import(
        "keyring.key",
        Buffer.from(JSON.stringify(kit.keyring), "utf8")
      );
    }
    if (typeof target.sealKey !== "string" || target.sealKey.length === 0) {
      throw new Error(
        `recover: the recovery-kit target for vault "${target.vaultId}" has no sealing key`
      );
    }
    const sealKey = Buffer.from(target.sealKey, "base64");
    if (sealKey.length !== 32) {
      throw new Error(
        `recover: the recovery-kit target for vault "${target.vaultId}" has an invalid sealing key`
      );
    }
    keyStore.import(`${target.vaultId}.sealkey`, sealKey);
    if (
      typeof target.identitySeed !== "string" ||
      target.identitySeed.length === 0
    ) {
      throw new Error(
        `recover: the recovery-kit target for vault "${target.vaultId}" has no identity seed`
      );
    }
    const identitySeed = Buffer.from(target.identitySeed, "base64");
    if (identitySeed.length !== 32) {
      throw new Error(
        `recover: the recovery-kit target for vault "${target.vaultId}" has an invalid identity seed`
      );
    }
    keyStore.import(`${target.vaultId}.identity`, identitySeed);

    emit("adopting");
    await fs.rename(restoreWorkDir, finalDir);
    await rehydrateCodeStore(finalDir, log);
    const adoptCtx: RecoverAdoptContext = {
      vaultId: target.vaultId,
      vaultDir: finalDir,
      targetId: target.targetId,
      provider,
      keyring: kit.keyring,
    };
    const reconcile = await reconcileAdoptedInventory({
      vaultDir: finalDir,
      remoteShas,
      snapshotEntries: restore.entries,
      materialize: (shas) =>
        materializeSnapshotBlobs({
          provider,
          targetId: target.targetId,
          keyring: kit.keyring,
          vaultId: target.vaultId,
          seq: restore.seq,
          shas,
          destDir: finalDir,
          log,
        }).then((r) => r.materialized),
      log,
    });

    await input.onAdopted?.(adoptCtx);

    emit("warming");
    const previews = await warmOrSkip(
      input,
      adoptCtx,
      restore.skippedBlobs.length,
      now,
      log
    );

    emit("done");
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
      reconcile,
      quarantine: ["outbox", "automations", "connections"],
    };
  } catch (error) {
    await fs
      .rm(restoreWorkDir, { recursive: true, force: true })
      .catch(() => undefined);
    throw error;
  }
}
