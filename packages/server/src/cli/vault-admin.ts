/*
 * `centraid-gateway vault …` — stopped-daemon vault lifecycle maintenance
 * (#289). Create/delete are landlord acts guarded by shell access alone.
 * Mutations hold gateway.db's exclusive lock and refuse while the daemon
 * runs. `--json` (#382) = single line, not NDJSON.
 */

import { GatewayDatabase, GatewayLockError } from "../serve/gateway-db.js";
import {
  openVaultRegistry,
  VaultRegistryError,
} from "../serve/vault-registry.js";
import type { VaultInfo } from "../serve/vault-registry.js";
import { jsonFail, runJson } from "./json-cli.js";
import type { Fail } from "./json-cli.js";
import { daemonKeyStore } from "./key-store.js";
import { daemonLayoutFor } from "./paths.js";

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

function parseVaultArgs(
  args: string[],
  fail: (msg: string, code?: number) => never
): VaultArgs {
  const out: VaultArgs = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === undefined) continue;
    if (flag === "--data-dir") {
      const v = args[++i];
      if (v === undefined) fail("--data-dir requires a value", 2);
      out.dataDir = v;
    } else if (flag === "--name") {
      const v = args[++i];
      if (v === undefined) fail("--name requires a value", 2);
      out.name = v;
    } else if (flag === "--json") {
      out.json = true;
    } else if (flag.startsWith("--")) {
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
  fail: (msg: string, code?: number) => never
): Promise<void> {
  // Pre-scan `--json`: it governs the whole run incl. arg-parse failures, any flag order.
  const json = args.includes("--json");
  // Annotation required for TS never-return narrowing on a call-derived const.
  const localFail: Fail = jsonFail(json, fail);
  await runJson(json, fail, async () => {
    const [action, ...rest] = args;
    if (!action || !["list", "create", "rename", "delete"].includes(action)) {
      localFail(
        "vault subcommand must be one of: list, create, rename, delete",
        2
      );
    }
    const parsed = parseVaultArgs(rest, localFail);
    if (!parsed.dataDir) localFail("--data-dir is required", 2);
    const layout = daemonLayoutFor(parsed.dataDir);
    let mutationLock: GatewayDatabase | undefined;
    if (action !== "list") {
      try {
        mutationLock = GatewayDatabase.open(parsed.dataDir, {
          lock: "exclusive",
        });
      } catch (error) {
        if (error instanceof GatewayLockError) localFail(error.message, 1);
        throw error;
      }
    }
    const registry = openVaultRegistry({
      // Protector-less store can't unwrap sealed keys (#568): mounts fail.
      keyStore: daemonKeyStore(layout.keysDir),
      rootDir: layout.vaultDir,
      logger: quietLogger,
      enableWalShipper: false,
    });
    try {
      switch (action) {
        case "list": {
          const vaults = registry.list();
          // Unmountable vaults vanish from `list()` — surface failedMounts rather than silently fewer vaults (#603).
          const failedMounts = registry.failedMounts();
          if (json) {
            process.stdout.write(
              `${JSON.stringify({ ok: true, vaults, failedMounts })}\n`
            );
          } else {
            for (const v of vaults) printVault(v);
            for (const failure of failedMounts) {
              process.stderr.write(
                `failed to mount: ${failure.dir} — ${failure.message}\n`
              );
            }
          }
          return;
        }
        case "create": {
          const created = registry.create(parsed.name);
          if (json) {
            process.stdout.write(
              `${JSON.stringify({ ok: true, vaultId: created.vaultId, name: created.name })}\n`
            );
          } else {
            printVault(created);
          }
          return;
        }
        case "rename": {
          const [vaultId, name] = parsed.positional;
          if (!vaultId || !name) {
            localFail(
              "usage: vault rename --data-dir <path> <vaultId> <name>",
              2
            );
          }
          printVault(registry.rename(vaultId, name));
          return;
        }
        case "delete": {
          const [vaultId] = parsed.positional;
          if (!vaultId)
            localFail("usage: vault delete --data-dir <path> <vaultId>", 2);
          registry.delete(vaultId);
          process.stdout.write(`${JSON.stringify({ deleted: vaultId })}\n`);
          return;
        }
        default:
          localFail(`unknown vault subcommand "${action}"`, 2);
      }
    } catch (error) {
      if (error instanceof VaultRegistryError) localFail(error.message, 1);
      throw error;
    } finally {
      registry.stop();
      mutationLock?.close();
    }
  });
}
