import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { BackupProvider } from "@centraid/backup";

import { BackupService } from "../backup/backup-service.js";
import { deriveBackupSourceInstanceId } from "../backup/backup-state.js";
import { GatewayDatabase, GatewayLockError } from "../serve/gateway-db.js";
import { HealthRegistry } from "../serve/health-registry.js";
import { openVaultRegistry } from "../serve/vault-registry.js";
import type { VaultInfo, VaultRegistry } from "../serve/vault-registry.js";
import { daemonKeyStore } from "./key-store.js";
import { daemonLayoutFor } from "./paths.js";
import { resolveDaemonConfig } from "./resolve-config.js";

interface BackupArgs {
  configPath?: string;
  dataDir?: string;
  vault?: string;
  dest?: string;
  seq?: number;
  out?: string;
  passwordFile?: string;
  atMs?: number;
  full?: boolean;
  yes?: boolean;
}

function applyInOrder<T>(
  values: Iterable<T>,
  apply: (value: T, index: number) => void | PromiseLike<void>
): Promise<void> {
  let index = 0;
  return Array.from(values).reduce<Promise<void>>(
    (sequence, value) => sequence.then(() => apply(value, index++)),
    Promise.resolve()
  );
}

function parseBackupArgs(
  args: string[],
  fail: (msg: string, code?: number) => never
): BackupArgs {
  const out: BackupArgs = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === undefined) continue;
    const take = (): string => {
      const v = args[++i];
      if (v === undefined) fail(`${flag} requires a value`, 2);
      return v;
    };
    if (flag === "--config") out.configPath = take();
    else if (flag === "--data-dir") out.dataDir = take();
    else if (flag === "--vault") out.vault = take();
    else if (flag === "--dest") out.dest = take();
    else if (flag === "--out") out.out = take();
    else if (flag === "--password-file") out.passwordFile = take();
    else if (flag === "--seq") {
      const n = Number(take());
      if (!Number.isInteger(n)) fail("--seq must be an integer", 2);
      out.seq = n;
    } else if (flag === "--at") {
      const raw = take();
      const ms = Date.parse(raw);
      if (Number.isNaN(ms))
        fail(`--at needs an ISO-8601 time, got "${raw}"`, 2);
      out.atMs = ms;
    } else if (flag === "--full") out.full = true;
    else if (flag === "--yes") out.yes = true;
    else fail(`unknown flag "${flag}"`, 2);
  }
  return out;
}

const quietLogger = {
  info: () => undefined,
  warn: (msg: string) => process.stderr.write(`centraid-gateway: ${msg}\n`),
  error: (msg: string) => process.stderr.write(`centraid-gateway: ${msg}\n`),
};

function resolveVaultId(
  registry: VaultRegistry,
  nameOrId: string,
  fail: (msg: string, code?: number) => never
): string {
  const matches = registry
    .list()
    .filter((v) => v.vaultId === nameOrId || v.name === nameOrId);
  if (matches.length === 0) fail(`no vault matches "${nameOrId}"`, 2);
  if (matches.length > 1)
    fail(`"${nameOrId}" is ambiguous — use the vault id`, 2);
  return (matches[0] as VaultInfo).vaultId;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

export async function commandBackup(
  args: string[],
  fail: (msg: string, code?: number) => never,
  deps?: { provider?: BackupProvider }
): Promise<void> {
  const [action, ...rest] = args;
  if (
    !action ||
    ![
      "status",
      "run",
      "list",
      "verify",
      "restore-verify",
      "restore",
      "kit",
    ].includes(action)
  ) {
    fail(
      "backup subcommand must be one of: status, run, list, verify, restore-verify, restore, kit",
      2
    );
  }
  const parsed = parseBackupArgs(rest, fail);
  const config = await resolveDaemonConfig(parsed, fail);
  if (!config.backup) {
    fail(
      'backup is not configured — add a "backup" block to your config file',
      2
    );
  }
  const layout = daemonLayoutFor(config.dataDir);
  if (!existsSync(layout.gatewayDbFile)) {
    fail(
      "gateway.db does not exist — start the daemon once before inspecting backups",
      2
    );
  }
  const readOnly = action === "status" || action === "list";
  let gatewayDatabase: GatewayDatabase;
  try {
    gatewayDatabase = GatewayDatabase.open(config.dataDir, {
      lock: readOnly ? "read-only" : "exclusive",
    });
  } catch (error) {
    if (error instanceof GatewayLockError) {
      fail(
        "the running daemon holds gateway.db — run this operation through it, or stop it first",
        2
      );
    }
    throw error;
  }
  const keyStore = daemonKeyStore(layout.keysDir);
  const endpointSecret = keyStore.load("endpoint-key.bin");
  if (!endpointSecret) {
    gatewayDatabase.close();
    fail(
      "gateway endpoint custody is missing — refusing to mint state from a backup command",
      2
    );
  }
  const registry = openVaultRegistry({
    rootDir: layout.vaultDir,
    cacheRootDir: layout.cacheDir,
    keyStore,
    logger: quietLogger,
    enableWalShipper: !readOnly,
  });
  const health = new HealthRegistry();
  const service = new BackupService({
    config: config.backup,
    cacheDir: layout.cacheDir,
    gatewayDatabase,
    keyStore,
    sourceInstanceId: deriveBackupSourceInstanceId(endpointSecret),
    vaults: registry,
    health,
    logger: quietLogger,
    ...(deps?.provider ? { provider: deps.provider } : {}),
  });

  try {
    const vaultIds = parsed.vault
      ? [resolveVaultId(registry, parsed.vault, fail)]
      : registry.list().map((v) => v.vaultId);

    switch (action) {
      case "status": {
        const state = await service.status();
        for (const vaultId of vaultIds) {
          printJson({
            vaultId,
            ...(state[vaultId] ?? { note: "never backed up" }),
          });
        }
        return;
      }
      case "run": {
        await applyInOrder(vaultIds, async (vaultId) => {
          await service.runBackup(vaultId);
          const state = await service.status();
          printJson({ vaultId, ...state[vaultId] });
        });
        return;
      }
      case "verify": {
        await applyInOrder(vaultIds, async (vaultId) => {
          const result = await service.runVerify(vaultId);
          printJson({ vaultId, result });
        });
        return;
      }
      case "restore-verify": {
        await applyInOrder(vaultIds, async (vaultId) => {
          await service.runRestoreVerify(vaultId);
          const state = await service.status();
          printJson({
            vaultId,
            lastRestoreVerifiedAt:
              state[vaultId]?.lastRestoreVerifiedAt ?? null,
          });
        });
        return;
      }
      case "list": {
        await applyInOrder(vaultIds, async (vaultId) => {
          try {
            const rows = await service.listSnapshots(vaultId);
            for (const row of rows) printJson({ vaultId, ...row });
          } catch (error) {
            process.stderr.write(
              `centraid-gateway: ${error instanceof Error ? error.message : String(error)}\n`
            );
          }
        });
        return;
      }
      case "restore": {
        if (!parsed.vault || !parsed.dest) {
          fail(
            "usage: backup restore --vault <id> --dest <dir> [--seq <n>] [--at <iso-time>] [--full] [--yes]",
            2
          );
        }
        const vaultId = resolveVaultId(registry, parsed.vault, fail);
        const estimate = await service.restoreEgressEstimate({
          vaultId,
          ...(parsed.seq === undefined ? {} : { seq: parsed.seq }),
          ...(parsed.atMs === undefined ? {} : { pointInTimeMs: parsed.atMs }),
        });
        if (estimate.costClass === "metered-egress" && !parsed.yes) {
          const fullSize =
            estimate.fullBytes === undefined
              ? "an unknown amount"
              : formatBytes(estimate.fullBytes);
          const lazyLine =
            !parsed.full && estimate.lazyAvailable
              ? "this restore is lazy by default and downloads only the vault database plus any " +
                "blob the remote CAS does not already hold; originals stream in on demand afterward. "
              : `a --full restore downloads the whole library (~${fullSize}). `;
          fail(
            `this home is metered-egress — restoring will incur egress charges. ${lazyLine}` +
              "Re-run with --yes to proceed.",
            2
          );
        }
        const result = await service.restore({
          vaultId,
          destDir: parsed.dest,
          ...(parsed.seq === undefined ? {} : { seq: parsed.seq }),
          ...(parsed.atMs === undefined ? {} : { pointInTimeMs: parsed.atMs }),
          ...(parsed.full ? { full: true } : {}),
        });
        printJson({ restored: parsed.dest, ...result });
        const mode = result.previewsWarm
          ? `lazy (previews-first; ${result.skippedBlobs.length} blob(s) left remote-only, ` +
            `${result.previewsWarm.tiniesWarmed}/${result.previewsWarm.tiniesTotal} tinies warmed)`
          : "full (every blob materialized)";
        process.stderr.write(
          `centraid-gateway: materialized snapshot seq ${result.seq} to ${path.resolve(parsed.dest)} ` +
            `— ${mode}. This does NOT swap the live vault (issue #439 R3): restore always writes a ` +
            "fresh side directory. A RESTORE_QUARANTINE.json marker sits beside the restored files; " +
            "the gateway parks outbox/automations/connections for review the first time this " +
            "directory is mounted as a live vault — a separate, deliberate step.\n"
        );
        return;
      }
      case "kit": {
        if (!parsed.out || !parsed.passwordFile) {
          fail("usage: backup kit --out <file> --password-file <file>", 2);
        }
        const password = readFileSync(parsed.passwordFile, "utf8").replace(
          /\r?\n$/u,
          ""
        );
        if (password.length === 0)
          fail("recovery-kit password file is empty", 2);
        await service.writeKit(parsed.out, password);
        printJson({ kit: parsed.out });
        process.stderr.write(
          "centraid-gateway: the kit file contains the LIVE backup keyring — store it offline; " +
            "anyone holding it and provider access can read every snapshot\n"
        );
        return;
      }
      default:
        fail(`unhandled backup action ${action}`, 2);
    }
  } finally {
    await service.stop();
    registry.stop();
    gatewayDatabase.close();
  }
}
