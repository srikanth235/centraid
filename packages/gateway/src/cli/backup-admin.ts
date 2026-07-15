/*
 * `centraid-gateway backup …` — the offsite backup engine's CLI surface
 * (PROTOCOL.md/FORMAT.md), constructed from the SAME resolved config
 * `serve` boots with (`--config <path>` or `--data-dir <path>`, reading
 * the config file's `"backup"` key — see `cli/config.ts`).
 *
 *   centraid-gateway backup status  [--config <path> | --data-dir <path>]
 *   centraid-gateway backup run     [--config <path> | --data-dir <path>] [--vault <id>]
 *   centraid-gateway backup list    [--config <path> | --data-dir <path>] [--vault <id>]
 *   centraid-gateway backup verify  [--config <path> | --data-dir <path>] [--vault <id>]
 *   centraid-gateway backup restore-verify [--config <path> | --data-dir <path>] [--vault <id>]
 *   centraid-gateway backup restore [--config <path> | --data-dir <path>] --vault <id> --dest <dir> [--seq <n>] [--at <iso-time>]
 *   centraid-gateway backup kit     [--config <path> | --data-dir <path>] --out <file>
 *
 * `restore` materializes a snapshot into a FRESH `--dest` directory — it
 * NEVER swaps the live vault (FORMAT.md restore rule 3); adopting the
 * result as a live vault, and clearing the resulting quarantine marker,
 * are separate, deliberate operator steps. `--at` is point-in-time restore
 * (issue #408): the newest snapshot at or before that instant plus every
 * shipped WAL segment up to it. `restore-verify` performs a REAL restore
 * from the remote into a scratch dir and runs the full check battery (G9)
 * — a backup that has never been restored is a hypothesis. `kit` emits the
 * recovery kit — live key material — with a loud "store this offline"
 * warning.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { openVaultRegistry, type VaultInfo, type VaultRegistry } from '../serve/vault-registry.js';
import { HealthRegistry } from '../serve/health-registry.js';
import {
  LEASE_FILE_NAME,
  LEASE_FRESH_WINDOW_MS,
  type LeaseRecord,
} from '../serve/gateway-instance-lease.js';
import { BackupService } from '../backup/backup-service.js';
import { daemonLayoutFor } from './paths.js';
import { resolveDaemonConfig } from './resolve-config.js';

/**
 * Refuse to touch a vault root a LIVE gateway holds (issue #408): mounting
 * planes here constructs WAL shippers over the daemon's OWN wal-ship state,
 * and a backup run checkpoints the live WALs — a second checkpointer is
 * exactly the I2 violation the shipper's detectors treat as foreign
 * (generation break + full base re-upload at best; interleaved state-file
 * writes at worst). The old `stageVaultDbs` CLI path was read-only, so this
 * gate is new WITH the shipper, not before it.
 */
function refuseIfDaemonHoldsRoot(
  vaultRoot: string,
  fail: (msg: string, code?: number) => never,
): void {
  let lease: LeaseRecord | undefined;
  try {
    lease = JSON.parse(readFileSync(path.join(vaultRoot, LEASE_FILE_NAME), 'utf8')) as LeaseRecord;
  } catch {
    return; // no lease file (or a torn one) — no live daemon
  }
  const age = Date.now() - Date.parse(lease.renewedAt);
  if (Number.isFinite(age) && age >= 0 && age < LEASE_FRESH_WINDOW_MS) {
    fail(
      `a live gateway (pid ${lease.pid} on ${lease.hostname}) holds this vault root — ` +
        'run backup operations through the running gateway (desktop/HTTP), or stop it first',
      2,
    );
  }
}

interface BackupArgs {
  configPath?: string;
  dataDir?: string;
  vault?: string;
  dest?: string;
  seq?: number;
  out?: string;
  /** Point-in-time restore target, epoch ms (parsed from `--at <iso>`). */
  atMs?: number;
}

function parseBackupArgs(args: string[], fail: (msg: string, code?: number) => never): BackupArgs {
  const out: BackupArgs = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === undefined) continue;
    const take = (): string => {
      const v = args[++i];
      if (v === undefined) fail(`${flag} requires a value`, 2);
      return v;
    };
    if (flag === '--config') out.configPath = take();
    else if (flag === '--data-dir') out.dataDir = take();
    else if (flag === '--vault') out.vault = take();
    else if (flag === '--dest') out.dest = take();
    else if (flag === '--out') out.out = take();
    else if (flag === '--seq') {
      const n = Number(take());
      if (!Number.isInteger(n)) fail('--seq must be an integer', 2);
      out.seq = n;
    } else if (flag === '--at') {
      const raw = take();
      const ms = Date.parse(raw);
      if (Number.isNaN(ms)) fail(`--at needs an ISO-8601 time, got "${raw}"`, 2);
      out.atMs = ms;
    } else fail(`unknown flag "${flag}"`, 2);
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
  fail: (msg: string, code?: number) => never,
): string {
  const matches = registry.list().filter((v) => v.vaultId === nameOrId || v.name === nameOrId);
  if (matches.length === 0) fail(`no vault matches "${nameOrId}"`, 2);
  if (matches.length > 1) fail(`"${nameOrId}" is ambiguous — use the vault id`, 2);
  return (matches[0] as VaultInfo).vaultId;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export async function commandBackup(
  args: string[],
  fail: (msg: string, code?: number) => never,
): Promise<void> {
  const [action, ...rest] = args;
  if (
    !action ||
    !['status', 'run', 'list', 'verify', 'restore-verify', 'restore', 'kit'].includes(action)
  ) {
    fail(
      'backup subcommand must be one of: status, run, list, verify, restore-verify, restore, kit',
      2,
    );
  }
  const parsed = parseBackupArgs(rest, fail);
  const config = await resolveDaemonConfig(parsed, fail);
  if (!config.backup) {
    fail('backup is not configured — add a "backup" block to your config file', 2);
  }
  const layout = daemonLayoutFor(config.dataDir);
  refuseIfDaemonHoldsRoot(layout.vaultDir, fail);
  const registry = openVaultRegistry({ rootDir: layout.vaultDir, logger: quietLogger });
  const health = new HealthRegistry();
  const service = new BackupService({
    config: config.backup,
    backupDir: layout.backupDir ?? path.join(config.dataDir, 'backup'),
    vaults: registry,
    health,
    logger: quietLogger,
  });

  try {
    const vaultIds = parsed.vault
      ? [resolveVaultId(registry, parsed.vault, fail)]
      : registry.list().map((v) => v.vaultId);

    switch (action) {
      case 'status': {
        const state = await service.status();
        for (const vaultId of vaultIds) {
          printJson({ vaultId, ...(state[vaultId] ?? { note: 'never backed up' }) });
        }
        return;
      }
      case 'run': {
        for (const vaultId of vaultIds) {
          await service.runBackup(vaultId);
          const state = await service.status();
          printJson({ vaultId, ...state[vaultId] });
        }
        return;
      }
      case 'verify': {
        for (const vaultId of vaultIds) {
          const result = await service.runVerify(vaultId);
          printJson({ vaultId, result });
        }
        return;
      }
      case 'restore-verify': {
        for (const vaultId of vaultIds) {
          await service.runRestoreVerify(vaultId);
          const state = await service.status();
          printJson({
            vaultId,
            lastRestoreVerifiedAt: state[vaultId]?.lastRestoreVerifiedAt ?? null,
          });
        }
        return;
      }
      case 'list': {
        for (const vaultId of vaultIds) {
          try {
            const rows = await service.listSnapshots(vaultId);
            for (const row of rows) printJson({ vaultId, ...row });
          } catch (err) {
            process.stderr.write(
              `centraid-gateway: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
        return;
      }
      case 'restore': {
        if (!parsed.vault || !parsed.dest) {
          fail('usage: backup restore --vault <id> --dest <dir> [--seq <n>] [--at <iso-time>]', 2);
        }
        const vaultId = resolveVaultId(registry, parsed.vault, fail);
        const result = await service.restore({
          vaultId,
          destDir: parsed.dest,
          ...(parsed.seq !== undefined ? { seq: parsed.seq } : {}),
          ...(parsed.atMs !== undefined ? { pointInTimeMs: parsed.atMs } : {}),
        });
        printJson({ restored: parsed.dest, ...result });
        process.stderr.write(
          `centraid-gateway: materialized snapshot seq ${result.seq} to ${path.resolve(parsed.dest)} — ` +
            'this does NOT swap the live vault. A RESTORE_QUARANTINE.json marker sits beside the ' +
            'restored files; the gateway parks outbox/automations/connections for review the first ' +
            'time this directory is mounted as a live vault.\n',
        );
        return;
      }
      case 'kit': {
        if (!parsed.out) fail('usage: backup kit --out <file>', 2);
        await service.writeKit(parsed.out);
        printJson({ kit: parsed.out });
        process.stderr.write(
          'centraid-gateway: the kit file contains the LIVE backup keyring — store it offline; ' +
            'anyone holding it and provider access can read every snapshot\n',
        );
        return;
      }
      default:
        fail(`unhandled backup action ${action}`, 2);
    }
  } finally {
    registry.stop();
  }
}
