/*
 * `centraid-gateway key …` — seal-key custody gestures (issue #298 items
 * 1+2+8). The DEK lives in the `keys/` sibling of the vault directory, so
 * the obvious backup gesture — copying the vault directory — carries
 * ciphertext only. These are the DECIDED recovery story: explicit,
 * receipted export/restore, plus rotation. ADMIN plane like `vault …`:
 * guarded by shell access, never HTTP.
 *
 *   centraid-gateway key status  --data-dir <path> --vault <name-or-id>
 *   centraid-gateway key export  --data-dir <path> --vault <name-or-id> --out <file>
 *   centraid-gateway key restore --data-dir <path> --vault <name-or-id> --from <file>
 *   centraid-gateway key rotate  --data-dir <path> --vault <name-or-id>
 *
 * Deliberately REGISTRY-FREE: a vault whose key is missing cannot even be
 * opened by the registry (that loud failure is the point of #298 item 1),
 * so restore works at the file level — raw sqlite reads for identity and
 * fingerprint, never a full plane open. Run with the daemon stopped.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  loadSealKey,
  resealVaultKey,
  openVaultDb,
  sealKeyFileFor,
  sealKeyFingerprint,
  writeReceipt,
  writeSealKeyFile,
} from '@centraid/vault';
import { daemonLayoutFor } from './paths.js';

interface KeyArgs {
  dataDir?: string;
  vault?: string;
  out?: string;
  from?: string;
}

function parseKeyArgs(args: string[], fail: (msg: string, code?: number) => never): KeyArgs {
  const out: KeyArgs = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === undefined) continue;
    const take = (): string => {
      const v = args[++i];
      if (v === undefined) fail(`${flag} requires a value`, 2);
      return v;
    };
    if (flag === '--data-dir') out.dataDir = take();
    else if (flag === '--vault') out.vault = take();
    else if (flag === '--out') out.out = take();
    else if (flag === '--from') out.from = take();
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
  const file = path.join(dir, 'vault.db');
  if (!existsSync(file)) return null;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db
        .prepare('SELECT vault_id, display_name, settings_json FROM core_vault LIMIT 1')
        .get() as { vault_id: string; display_name: string; settings_json: string } | undefined;
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
  fail: (msg: string, code?: number) => never,
): VaultRow {
  const rows: VaultRow[] = [];
  if (existsSync(rootDir)) {
    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const row = readVaultRow(path.join(rootDir, entry.name));
      if (row) rows.push(row);
    }
  }
  const matches = rows.filter((r) => r.vaultId === nameOrId || r.displayName === nameOrId);
  if (matches.length === 0) fail(`no vault matches "${nameOrId}"`, 2);
  if (matches.length > 1) fail(`"${nameOrId}" is ambiguous — use the vault id`, 2);
  return matches[0] as VaultRow;
}

/** Receipt a custody gesture into the vault's own journal (append-only). */
function receiptKeyGesture(
  vaultDir: string,
  action: 'key.export' | 'key.restore',
  detail: Record<string, unknown>,
): string {
  const journal = new DatabaseSync(path.join(vaultDir, 'journal.db'));
  try {
    // The WAL shipper (issue #408) is journal.db's sole checkpointer. Turning
    // autocheckpoint off is a PERF HINT, not a correctness requirement (issue
    // #411 action 1): the shipper VERIFIES salts/offsets every capture and
    // breaks the generation on any foreign checkpoint, so were this short-lived
    // write connection to autocheckpoint it would be caught and healed by a
    // ticking shipper (and is harmless with none running — no stream to hole);
    // the pragma just spares a base re-upload. (Its close, if it is
    // the LAST connection — gateway down — still runs SQLite's close-checkpoint;
    // the shipper detects that on next start and heals with a fresh base.)
    journal.exec('PRAGMA wal_autocheckpoint = 0');
    journal.exec('PRAGMA busy_timeout = 30000');
    return writeReceipt(journal, {
      grantId: null,
      invocationId: null,
      action,
      objectType: 'core.vault',
      objectId: 'seal-key',
      purpose: null,
      decision: 'allow',
      detail,
    });
  } finally {
    journal.close();
  }
}

/** The export envelope: identifiable, restorable, never mistaken for a key file. */
interface KeyEnvelope {
  version: 1;
  kind: 'centraid-seal-key';
  vaultId: string;
  fingerprint: string;
  key: string; // base64
  exportedAt: string;
}

export async function commandKey(
  args: string[],
  fail: (msg: string, code?: number) => never,
): Promise<void> {
  const [action, ...rest] = args;
  if (!action || !['status', 'export', 'restore', 'rotate'].includes(action)) {
    fail('key subcommand must be one of: status, export, restore, rotate', 2);
  }
  const parsed = parseKeyArgs(rest, fail);
  if (!parsed.dataDir) fail('--data-dir is required', 2);
  if (!parsed.vault) fail('--vault is required', 2);
  const layout = daemonLayoutFor(parsed.dataDir);
  const row = resolveVaultDir(layout.vaultDir, parsed.vault, fail);
  const keyFile = sealKeyFileFor(row.dir);
  const key = loadSealKey(keyFile);

  switch (action) {
    case 'status': {
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
        })}\n`,
      );
      return;
    }
    case 'export': {
      if (!parsed.out)
        fail('usage: key export --data-dir <path> --vault <name-or-id> --out <file>', 2);
      if (!key) fail(`no seal key at ${keyFile} — nothing to export`, 1);
      const envelope: KeyEnvelope = {
        version: 1,
        kind: 'centraid-seal-key',
        vaultId: row.vaultId,
        fingerprint: sealKeyFingerprint(key),
        key: key.toString('base64'),
        exportedAt: new Date().toISOString(),
      };
      writeFileSync(parsed.out, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
      const receiptId = receiptKeyGesture(row.dir, 'key.export', {
        fingerprint: envelope.fingerprint,
        out: path.basename(parsed.out),
      });
      process.stdout.write(
        `${JSON.stringify({ exported: parsed.out, fingerprint: envelope.fingerprint, receiptId })}\n`,
      );
      process.stderr.write(
        'centraid-gateway: the export file IS the secret — store it offline; anyone holding it and the vault directory can read every sealed value\n',
      );
      return;
    }
    case 'restore': {
      if (!parsed.from)
        fail('usage: key restore --data-dir <path> --vault <name-or-id> --from <file>', 2);
      const envelope = JSON.parse(readFileSync(parsed.from, 'utf8')) as KeyEnvelope;
      if (envelope.kind !== 'centraid-seal-key' || typeof envelope.key !== 'string') {
        fail(`${parsed.from} is not a centraid seal-key export`, 2);
      }
      const restored = Buffer.from(envelope.key, 'base64');
      const fp = sealKeyFingerprint(restored);
      if (fp !== envelope.fingerprint)
        fail('export file corrupt: key does not match its own fingerprint', 1);
      if (row.fingerprint !== null && fp !== row.fingerprint) {
        fail(
          `this is not the key that sealed vault ${row.vaultId} (${fp} vs stamped ${row.fingerprint}) — restoring it would not decrypt anything`,
          1,
        );
      }
      if (key && sealKeyFingerprint(key) !== fp) {
        fail(
          `a DIFFERENT key already sits at ${keyFile} — move it aside first; refusing to overwrite key material`,
          1,
        );
      }
      writeSealKeyFile(keyFile, restored);
      const receiptId = receiptKeyGesture(row.dir, 'key.restore', {
        fingerprint: fp,
        from: path.basename(parsed.from),
      });
      process.stdout.write(
        `${JSON.stringify({ restored: keyFile, fingerprint: fp, receiptId })}\n`,
      );
      return;
    }
    case 'rotate': {
      // Full open (migrates + custody-checks) — rotation only makes sense
      // for a vault that opens with its current key.
      const db = openVaultDb({ dir: row.dir });
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
