/*
 * `centraid-gateway vault …` — the ADMIN plane for vault lifecycle
 * (issue #289).
 *
 * Vault create/delete left the HTTP surface: they are landlord acts,
 * guarded by having shell access to the box — a family member's device can
 * never delete a sibling's vault because no route exists. The daemon picks
 * up a newly created vault on the first request that names it (the
 * registry rescans on miss); deletion is safest with the daemon stopped.
 *
 *   centraid-gateway vault list   --data-dir <path>
 *   centraid-gateway vault create --data-dir <path> [--name <name>]
 *   centraid-gateway vault rename --data-dir <path> <vaultId> <name>
 *   centraid-gateway vault delete --data-dir <path> <vaultId>
 */

import { openVaultRegistry, VaultRegistryError, type VaultInfo } from '../serve/vault-registry.js';
import { daemonLayoutFor } from './paths.js';

const quietLogger = {
  info: () => undefined,
  warn: (msg: string) => process.stderr.write(`centraid-gateway: ${msg}\n`),
  error: (msg: string) => process.stderr.write(`centraid-gateway: ${msg}\n`),
};

interface VaultArgs {
  dataDir?: string;
  name?: string;
  positional: string[];
}

function parseVaultArgs(args: string[], fail: (msg: string, code?: number) => never): VaultArgs {
  const out: VaultArgs = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === undefined) continue;
    if (flag === '--data-dir') {
      const v = args[++i];
      if (v === undefined) fail('--data-dir requires a value', 2);
      out.dataDir = v;
    } else if (flag === '--name') {
      const v = args[++i];
      if (v === undefined) fail('--name requires a value', 2);
      out.name = v;
    } else if (flag.startsWith('--')) {
      fail(`unknown flag "${flag}"`, 2);
    } else {
      out.positional.push(flag);
    }
  }
  return out;
}

function printVault(v: VaultInfo): void {
  process.stdout.write(`${JSON.stringify(v)}\n`);
}

export async function commandVault(
  args: string[],
  fail: (msg: string, code?: number) => never,
): Promise<void> {
  const [action, ...rest] = args;
  if (!action || !['list', 'create', 'rename', 'delete'].includes(action)) {
    fail('vault subcommand must be one of: list, create, rename, delete', 2);
  }
  const parsed = parseVaultArgs(rest, fail);
  if (!parsed.dataDir) fail('--data-dir is required', 2);
  const layout = daemonLayoutFor(parsed.dataDir);
  const registry = openVaultRegistry({ rootDir: layout.vaultDir, logger: quietLogger });
  try {
    switch (action) {
      case 'list': {
        for (const v of registry.list()) printVault(v);
        return;
      }
      case 'create': {
        printVault(registry.create(parsed.name));
        return;
      }
      case 'rename': {
        const [vaultId, name] = parsed.positional;
        if (!vaultId || !name) fail('usage: vault rename --data-dir <path> <vaultId> <name>', 2);
        printVault(registry.rename(vaultId, name));
        return;
      }
      case 'delete': {
        const [vaultId] = parsed.positional;
        if (!vaultId) fail('usage: vault delete --data-dir <path> <vaultId>', 2);
        registry.delete(vaultId);
        process.stdout.write(`${JSON.stringify({ deleted: vaultId })}\n`);
        return;
      }
      default:
        fail(`unknown vault subcommand "${action}"`, 2);
    }
  } catch (err) {
    if (err instanceof VaultRegistryError) fail(err.message, 1);
    throw err;
  } finally {
    registry.stop();
  }
}
