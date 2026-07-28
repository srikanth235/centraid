/*
 * `centraid-gateway key …` — stopped-daemon seal-key inspection + rotation.
 * Recovery travels only through a password-wrapped recovery kit; this command
 * deliberately has no raw export/restore surface.
 *
 *   centraid-gateway key status  --data-dir <path> --vault <name-or-id>
 *   centraid-gateway key rotate  --data-dir <path> --vault <name-or-id>
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  loadSealKey,
  resealVaultKey,
  openVaultDb,
  sealKeyFileFor,
  sealKeyFingerprint,
} from "@centraid/vault";

import { daemonKeyStore } from "./key-store.js";
import { daemonLayoutFor } from "./paths.js";

interface KeyArgs {
  dataDir?: string;
  vault?: string;
}

function parseKeyArgs(
  args: string[],
  fail: (msg: string, code?: number) => never
): KeyArgs {
  const out: KeyArgs = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === undefined) continue;
    const take = (): string => {
      const v = args[++i];
      if (v === undefined) fail(`${flag} requires a value`, 2);
      return v;
    };
    if (flag === "--data-dir") out.dataDir = take();
    else if (flag === "--vault") out.vault = take();
    else fail(`unknown flag "${flag}"`, 2);
  }
  return out;
}

interface VaultRow {
  dir: string;
  vaultId: string;
  displayName: string;
  fingerprint: string | null;
}

/** Read identity + stamped fingerprint of one vault, without opening a plane. */
function readVaultRow(dir: string): VaultRow | null {
  const file = path.join(dir, "vault.db");
  if (!existsSync(file)) return null;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT vault_id, display_name, settings_json FROM core_vault LIMIT 1"
        )
        .get() as
        | { vault_id: string; display_name: string; settings_json: string }
        | undefined;
      if (!row) return null;
      const settings = JSON.parse(row.settings_json) as {
        seal_key?: { fingerprint?: string };
      };
      return {
        dir,
        vaultId: row.vault_id,
        displayName: row.display_name,
        fingerprint: settings.seal_key?.fingerprint ?? null,
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Resolve --vault by id or display name across the vault root, registry-free. */
function resolveVaultDir(
  rootDir: string,
  nameOrId: string,
  fail: (msg: string, code?: number) => never
): VaultRow {
  const rows: VaultRow[] = [];
  if (existsSync(rootDir)) {
    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const row = readVaultRow(path.join(rootDir, entry.name));
      if (row) rows.push(row);
    }
  }
  const matches = rows.filter(
    (r) => r.vaultId === nameOrId || r.displayName === nameOrId
  );
  if (matches.length === 0) fail(`no vault matches "${nameOrId}"`, 2);
  if (matches.length > 1)
    fail(`"${nameOrId}" is ambiguous — use the vault id`, 2);
  return matches[0] as VaultRow;
}

export async function commandKey(
  args: string[],
  fail: (msg: string, code?: number) => never
): Promise<void> {
  const [action, ...rest] = args;
  if (!action || !["status", "rotate"].includes(action)) {
    fail("key subcommand must be one of: status, rotate", 2);
  }
  const parsed = parseKeyArgs(rest, fail);
  if (!parsed.dataDir) fail("--data-dir is required", 2);
  if (!parsed.vault) fail("--vault is required", 2);
  const layout = daemonLayoutFor(parsed.dataDir);
  const row = resolveVaultDir(layout.vaultDir, parsed.vault, fail);
  const keyFile = sealKeyFileFor(row.dir);
  const keyStore = daemonKeyStore(layout.keysDir);
  const key = loadSealKey(keyFile, keyStore);

  switch (action) {
    case "status": {
      process.stdout.write(
        `${JSON.stringify({
          vaultId: row.vaultId,
          name: row.displayName,
          keyFile,
          keyPresent: key !== null,
          keyFingerprint: key ? sealKeyFingerprint(key) : null,
          stampedFingerprint: row.fingerprint,
          healthy:
            row.fingerprint === null ||
            (key !== null && sealKeyFingerprint(key) === row.fingerprint),
        })}\n`
      );
      return;
    }
    case "rotate": {
      // Full open (migrates + custody-checks) — rotation only makes sense
      // for a vault that opens with its current key.
      const db = openVaultDb({
        dir: row.dir,
        keyStore,
      });
      try {
        const result = resealVaultKey(db);
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } finally {
        db.close();
      }
      return;
    }
    default:
      fail(`unhandled key action ${action}`, 2);
  }
}
