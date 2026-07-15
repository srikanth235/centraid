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
 *   centraid-gateway vault list   --data-dir <path> [--json]
 *   centraid-gateway vault create --data-dir <path> [--name <name>] [--json]
 *   centraid-gateway vault rename --data-dir <path> <vaultId> <name>
 *   centraid-gateway vault delete --data-dir <path> <vaultId>
 *
 * `--json` (issue #382) wraps `list`/`create`'s output in a single
 * `{ok, vaults:[...]}` / `{ok, vaultId, name}` line instead of the default
 * one-JSON-object-per-line stream — a caller driving this over SSH (the
 * desktop's ConnectFlow) wants one line to parse, not an NDJSON stream.
 */

import { openVaultRegistry, VaultRegistryError, type VaultInfo } from '../serve/vault-registry.js';
import { daemonLayoutFor } from './paths.js';
import { jsonFail, runJson, type Fail } from './json-cli.js';

const quietLogger = {
  info: () => undefined,
  warn: (msg: string) => process.stderr.write(`centraid-gateway: ${msg}\n`),
  error: (msg: string) => process.stderr.write(`centraid-gateway: ${msg}\n`),
};

interface VaultArgs {
  dataDir?: string;
  name?: string;
  json?: boolean;
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
    } else if (flag === '--json') {
      out.json = true;
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
  // Pre-scan for `--json` so it governs the whole run — including a
  // `fail()` triggered by argument parsing itself — regardless of flag order.
  const json = args.includes('--json');
  // Explicit annotation: TS's never-return control-flow narrowing (used
  // below on `parsed.dataDir`) only kicks in when the call-derived const is
  // annotated — inferred-from-call-expression alone doesn't carry it.
  const localFail: Fail = jsonFail(json, fail);
  await runJson(json, fail, async () => {
    const [action, ...rest] = args;
    if (!action || !['list', 'create', 'rename', 'delete'].includes(action)) {
      localFail('vault subcommand must be one of: list, create, rename, delete', 2);
    }
    const parsed = parseVaultArgs(rest, localFail);
    if (!parsed.dataDir) localFail('--data-dir is required', 2);
    const layout = daemonLayoutFor(parsed.dataDir);
    const registry = openVaultRegistry({
      rootDir: layout.vaultDir,
      logger: quietLogger,
      enableWalShipper: false,
    });
    try {
      switch (action) {
        case 'list': {
          const vaults = registry.list();
          if (json) {
            process.stdout.write(`${JSON.stringify({ ok: true, vaults })}\n`);
          } else {
            for (const v of vaults) printVault(v);
          }
          return;
        }
        case 'create': {
          const created = registry.create(parsed.name);
          if (json) {
            process.stdout.write(
              `${JSON.stringify({ ok: true, vaultId: created.vaultId, name: created.name })}\n`,
            );
          } else {
            printVault(created);
          }
          return;
        }
        case 'rename': {
          const [vaultId, name] = parsed.positional;
          if (!vaultId || !name) {
            localFail('usage: vault rename --data-dir <path> <vaultId> <name>', 2);
          }
          printVault(registry.rename(vaultId, name));
          return;
        }
        case 'delete': {
          const [vaultId] = parsed.positional;
          if (!vaultId) localFail('usage: vault delete --data-dir <path> <vaultId>', 2);
          registry.delete(vaultId);
          process.stdout.write(`${JSON.stringify({ deleted: vaultId })}\n`);
          return;
        }
        default:
          localFail(`unknown vault subcommand "${action}"`, 2);
      }
    } catch (err) {
      if (err instanceof VaultRegistryError) localFail(err.message, 1);
      throw err;
    } finally {
      registry.stop();
    }
  });
}
