import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  openLocalBackupProvider,
  openRemoteBackupProvider,
} from "@centraid/backup";
import type {
  BackupProvider,
  EngineLogger,
  RecoveryKitTarget,
  RestoreCurrentVersions,
  SnapshotRow,
  WalReplayOutcome,
} from "@centraid/backup";
import {
  bumpReplicaEpoch,
  ONTOLOGY_VERSION,
  VAULT_MIGRATIONS,
} from "@centraid/vault";

import type { GatewayDatabase } from "../serve/gateway-db.js";
import { GATEWAY_VERSION } from "../version.js";
import { run } from "../worktree-store/git.js";
import { loadBackupState, saveBackupState } from "./backup-state.js";
import type {
  PreviewsRecoverOutcome,
  RecoverAdoptContext,
  RecoverInput,
} from "./recover.js";
import { warmPreviewTinies } from "./restore-warm.js";

const LOCAL_PROVIDER_PREFIX = "local:";

export function buildProviderFromTarget(
  target: RecoveryKitTarget,
  apiKey: string
): BackupProvider {
  if (target.provider.startsWith(LOCAL_PROVIDER_PREFIX)) {
    return openLocalBackupProvider({
      rootDir: target.provider.slice(LOCAL_PROVIDER_PREFIX.length),
    });
  }
  return openRemoteBackupProvider({ baseUrl: target.provider, apiKey });
}

export function selectTarget(
  targets: RecoveryKitTarget[],
  vaultId: string | undefined
): RecoveryKitTarget {
  if (vaultId !== undefined) {
    const match = targets.find((t) => t.vaultId === vaultId);
    if (!match) {
      throw new Error(
        `recover: the recovery kit has no vault "${vaultId}" (it carries: ${targets
          .map((t) => t.vaultId)
          .join(", ")})`
      );
    }
    return match;
  }
  if (targets.length === 1) return targets[0]!;
  throw new Error(
    `recover: the recovery kit carries ${targets.length} vaults — choose one with --vault ` +
      `(${targets.map((t) => t.vaultId).join(", ")})`
  );
}

export function pickSnapshotRow(
  rows: SnapshotRow[],
  at: number | undefined
): SnapshotRow | undefined {
  if (at !== undefined) return rows.find((r) => r.createdAt * 1000 <= at);
  return rows[0];
}

function casShaOf(key: string): string | undefined {
  return /(?:^|\/)blobs\/(?:sha256\/)?(?<sha>[0-9a-f]{64})$/u.exec(key)?.groups
    ?.sha;
}

export async function collectRemoteCasShas(
  provider: BackupProvider,
  targetId: string
): Promise<Set<string>> {
  const shas = new Set<string>();
  const collectPage = async (cursor: string | undefined): Promise<void> => {
    const page = await provider.listInventory!(targetId, {
      store: "cas",
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of page.objects) {
      if (object.state !== "live") continue;
      const sha = casShaOf(object.key);
      if (sha) shas.add(sha);
    }
    const nextCursor = page.nextCursor ?? undefined;
    if (nextCursor !== undefined) return collectPage(nextCursor);
  };
  await collectPage(undefined);
  return shas;
}

export async function rehydrateCodeStore(
  vaultDir: string,
  log: EngineLogger
): Promise<void> {
  const bundle = path.join(vaultDir, "apps.bundle");
  if (!existsSync(bundle)) return;
  const bareDir = path.join(vaultDir, "code", "apps.git");
  await fs.mkdir(path.dirname(bareDir), { recursive: true });
  await run(["clone", "--bare", bundle, bareDir], { cwd: vaultDir });
  await fs.rm(bundle, { force: true });
  log.info?.(
    `recover: rehydrated the app code store at ${bareDir} from apps.bundle`
  );
}

export function invalidateRestoredReplica(destDir: string): void {
  const vault = new DatabaseSync(path.join(destDir, "vault.db"));
  try {
    bumpReplicaEpoch(vault, { reason: "backup-restore" });
  } finally {
    vault.close();
  }
}

export function recoveredAsOfMs(
  walReplay: WalReplayOutcome,
  row: SnapshotRow
): number {
  return walReplay.cutTickMs >= 0 ? walReplay.cutTickMs : row.createdAt * 1000;
}

export function walReplayTruncated(walReplay: WalReplayOutcome): boolean {
  const shortOfTip =
    walReplay.expectedCutMs >= 0 &&
    walReplay.cutTickMs < walReplay.expectedCutMs;
  return shortOfTip || walReplay.truncated;
}

export function currentVersions(): RestoreCurrentVersions {
  return {
    gatewayVersion: GATEWAY_VERSION,
    vaultUserVersion: String(VAULT_MIGRATIONS.length),
    ontologyVersion: ONTOLOGY_VERSION,
  };
}

export async function warmOrSkip(
  input: RecoverInput,
  ctx: RecoverAdoptContext,
  deferredCount: number,
  now: () => number,
  log: EngineLogger
): Promise<PreviewsRecoverOutcome> {
  if (input.full) {
    return {
      warmed: false,
      reason: "full restore — every blob was materialized, no warm pass needed",
    };
  }
  if (!input.resolveRemoteTier) {
    return {
      warmed: false,
      reason:
        "no remote CAS tier resolver in this context (headless recovery) — " +
        `${deferredCount} deferred blob(s) and every preview stream in on demand after the vault mounts`,
    };
  }
  const remote = await input.resolveRemoteTier(ctx);
  if (!remote) {
    return {
      warmed: false,
      reason:
        "the recovered vault has no durable remote CAS tier — previews stream in on demand",
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

export async function seedFencedBackupState(opts: {
  gatewayDatabase: GatewayDatabase;
  sourceInstanceId: string;
  vaultId: string;
  target: RecoveryKitTarget;
  fencedGeneration: number;
  lastSeq: number;
  now: () => number;
}): Promise<void> {
  const state = await loadBackupState(
    opts.gatewayDatabase,
    opts.sourceInstanceId
  );
  const stamp = new Date(opts.now()).toISOString();
  state.targets[opts.vaultId] = {
    targetId: opts.target.targetId,
    label: opts.target.label,
    generation: opts.fencedGeneration,
    lastSeq: opts.lastSeq,
    firstBackupAt: stamp,
    lastBackupAt: stamp,
  };
  await saveBackupState(opts.gatewayDatabase, state);
}
