/*
 * THE LOCKER KEY PLANE (#996, ruling R13).
 *
 * Locker v0 moves the boundary. Until now a secret sat in `vault.db` as
 * ciphertext the GATEWAY could open, and the thing standing between a caller
 * and the plaintext was a permit the gateway minted after checking a
 * passphrase it also held the verifier for. That is a boundary the gateway
 * can walk through on its own. Here the value is encrypted under a vault key
 * `K` that lives outside the vault file, the gateway never serves plaintext,
 * and the proof of presence moves to the seat that holds `K` behind its own
 * unlock.
 *
 * WHAT `K` IS. One random 256-bit key per vault, minted at vault founding into
 * the gateway's `keys/` directory — the SAME custody the seal key and the
 * identity seed already use (`schema/key-store.ts`), deliberately outside the
 * directory that export, backup and copy gestures move around. A copied vault
 * carries ciphertext only; `packages/server/src/backup/backup-sources.ts` says
 * long-lived keys never enter a snapshot, and the recovery kit is the one
 * artefact that carries them.
 *
 * WHAT IS ENCRYPTED. Secret VALUES only. Title, url and username stay
 * plaintext so a locked seat can still list and search offline — that is the
 * whole reason Locker is usable on a phone in airplane mode. The wire form is
 *
 *     lk1:<base64(nonce ‖ ciphertext ‖ tag)>
 *
 * AES-256-GCM, a fresh random 96-bit nonce per value stored beside its
 * ciphertext in the same envelope, and AAD = `<rowId>‖<keyId>`. The AAD is
 * what stops a ciphertext being moved between rows and what makes a ciphertext
 * unopenable under a key id it was not sealed with — the two failures a bare
 * "here is a blob" column invites.
 *
 * ROTATION IS AN ORDER, NOT A TRANSACTION. `keys/` and `vault.db` share no
 * transaction, so the order is the guarantee:
 *
 *   1. write `K′` to `keys/` as a NEW file (the old one is untouched);
 *   2. ONE DB transaction: insert the new `locker_key` row, re-encrypt every
 *      secret under `K′`, bump every `key_id`, retire the old row;
 *   3. delete the old key file.
 *
 * A crash between 1 and 2 leaves both files on disk and the DB still naming
 * the old key: nothing was re-encrypted, the orphan is swept at the next open.
 * A crash between 2 and 3 leaves both files and the DB naming the new key: the
 * retired file is swept the same way. At no point is any ciphertext under a
 * key the DB does not name, and at no point are two keys live — that is what
 * `locker_key_live_idx` and the single transaction in step 2 buy.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { KeyStore } from "../schema/key-store.js";

export const LOCKER_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Wire prefix of a value encrypted under `K` — the "is this ciphertext?" predicate. */
export const LOCKER_CIPHERTEXT_PREFIX = "lk1:";

/**
 * Which columns of which physical table hold ciphertext under `K`.
 *
 * Stated ONCE, here, and read by encryption, decryption, rotation and the
 * tests — the registry that used to say this (`schema/sealed.ts`'s
 * `SEALED_COLUMNS`) described a gateway-side pipeline that no longer exists
 * for Locker. The list is tight for the same reason its predecessor was: only
 * where the value IS the secret. Everything else on these tables is the
 * browsable half a locked seat still needs.
 */
export const LOCKER_ENCRYPTED_COLUMNS: Readonly<
  Record<string, { readonly pk: string; readonly columns: readonly string[] }>
> = {
  locker_item: {
    pk: "item_id",
    columns: ["password", "otp_seed", "card_number", "cvv", "content"],
  },
  locker_item_field: { pk: "field_id", columns: ["value_sealed"] },
  locker_item_passkey: { pk: "item_id", columns: ["private_key"] },
};

/** A key-plane failure a caller must distinguish, never a bare Error. */
export class LockerKeyError extends Error {
  constructor(
    readonly code: "missing" | "stale_key_id" | "not_founded",
    message: string
  ) {
    super(message);
    this.name = "LockerKeyError";
  }
}

/** Deterministic key path for `<dataRoot>/keys/<vaultId>.locker.<keyId>.key`. */
export function lockerKeyFileName(vaultId: string, keyId: string): string {
  return `${vaultId}.locker.${keyId}.key`;
}

/**
 * The `keys/` directory that owns a vault directory's key files.
 *
 * Mirrors `sealKeyFileFor`: `<dataRoot>/vault/<id>` → `<dataRoot>/keys`, so
 * `K` shares custody, permissions and envelope with the seal key rather than
 * inventing a second key directory nothing else knows to back up.
 */
export function lockerKeyDirFor(vaultDir: string): string {
  const resolved = path.resolve(vaultDir);
  const vaultRoot = path.dirname(resolved);
  const dataRoot =
    path.basename(vaultRoot) === "vault" ? path.dirname(vaultRoot) : vaultRoot;
  return path.join(dataRoot, "keys");
}

export interface LockerKeyRow {
  readonly keyId: string;
  readonly createdAt: string;
  readonly retiredAt: string | null;
}

/** Every `locker_key` row, newest first. Ids only — never key material. */
export function lockerKeyRows(vault: DatabaseSync): LockerKeyRow[] {
  const rows = vault
    .prepare(
      `SELECT key_id, created_at, retired_at FROM locker_key ORDER BY created_at DESC, key_id DESC`
    )
    .all() as {
    key_id: string;
    created_at: string;
    retired_at: string | null;
  }[];
  return rows.map((row) => ({
    keyId: row.key_id,
    createdAt: row.created_at,
    retiredAt: row.retired_at,
  }));
}

/** The live key id, or null on a vault whose key plane was never founded. */
export function liveLockerKeyId(vault: DatabaseSync): string | null {
  const row = vault
    .prepare(`SELECT key_id FROM locker_key WHERE retired_at IS NULL LIMIT 1`)
    .get() as { key_id: string } | undefined;
  return row?.key_id ?? null;
}

export interface LockerKeyCustody {
  /** Where the key files live. */
  readonly store: KeyStore;
  readonly vaultId: string;
}

export function lockerKeyCustody(
  vaultDir: string,
  vaultId: string,
  keyStore?: KeyStore
): LockerKeyCustody {
  const dir = lockerKeyDirFor(vaultDir);
  if (keyStore && keyStore.dir !== path.resolve(dir)) {
    throw new Error(
      `locker key custody store ${keyStore.dir} does not own ${path.resolve(dir)}`
    );
  }
  return { store: keyStore ?? new KeyStore(dir), vaultId };
}

/**
 * Mint `K` at vault founding: one key file, one live `locker_key` row.
 *
 * FOUNDING, NOT FIRST-NEED. The seal key was minted lazily and #298 spent a
 * whole ruling on what that cost — a vault that had never sealed could mint
 * freely, so "is this the right key" had no answer until the first secret
 * existed. The key plane has no such window: the row and the file are written
 * together at founding, `liveLockerKeyId` is non-null for the life of the
 * vault, and a missing file is unambiguously custody loss.
 *
 * Idempotent: a vault already founded gets its existing key back.
 */
export function foundLockerKey(
  vault: DatabaseSync,
  custody: LockerKeyCustody,
  now: string = new Date().toISOString()
): { keyId: string; key: Buffer } {
  const live = liveLockerKeyId(vault);
  if (live !== null) return { keyId: live, key: loadLockerKey(custody, live) };
  const keyId = randomUUID();
  // The FILE first, then the row — the same order rotation uses, and for the
  // same reason: a row naming a key file that does not exist is unrecoverable,
  // a key file no row names is a sweepable orphan.
  const key = custody.store.create(lockerKeyFileName(custody.vaultId, keyId));
  vault
    .prepare(
      `INSERT INTO locker_key (key_id, created_at, retired_at) VALUES (?, ?, NULL)`
    )
    .run(keyId, now);
  return { keyId, key };
}

/** Load `K` for a key id, or fail loudly — a missing file is custody loss. */
export function loadLockerKey(
  custody: LockerKeyCustody,
  keyId: string
): Buffer {
  const name = lockerKeyFileName(custody.vaultId, keyId);
  const key = custody.store.load(name);
  if (!key) {
    throw new LockerKeyError(
      "missing",
      `locker key file missing at ${custody.store.file(name)} — this vault's Locker secrets are encrypted under key ${keyId} and are unrecoverable without it. The recovery kit carries every live key file; a directory copy alone never does.`
    );
  }
  return key;
}

/** AAD binding a ciphertext to its row AND its key: `<rowId>‖<keyId>`. */
export function lockerAad(rowId: string, keyId: string): string {
  return `${rowId}‖${keyId}`;
}

export function isLockerCiphertext(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith(LOCKER_CIPHERTEXT_PREFIX))
    return false;
  const body = value.slice(LOCKER_CIPHERTEXT_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(body) || body.length % 4 !== 0)
    return false;
  return Buffer.from(body, "base64").length >= NONCE_BYTES + TAG_BYTES;
}

/** Encrypt one secret under `K`. Fresh nonce every call, never derived. */
export function encryptUnderLockerKey(
  key: Buffer,
  keyId: string,
  rowId: string,
  plaintext: string
): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(lockerAad(rowId, keyId), "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return (
    LOCKER_CIPHERTEXT_PREFIX +
    Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString("base64")
  );
}

/** Decrypt under `K`. Throws on tampering, a wrong row, or a wrong key id. */
export function decryptUnderLockerKey(
  key: Buffer,
  keyId: string,
  rowId: string,
  value: string
): string {
  if (!value.startsWith(LOCKER_CIPHERTEXT_PREFIX))
    throw new Error("value is not locker ciphertext");
  const raw = Buffer.from(
    value.slice(LOCKER_CIPHERTEXT_PREFIX.length),
    "base64"
  );
  if (raw.length < NONCE_BYTES + TAG_BYTES)
    throw new Error("locker ciphertext truncated");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    raw.subarray(0, NONCE_BYTES)
  );
  decipher.setAAD(Buffer.from(lockerAad(rowId, keyId), "utf8"));
  decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Refuse a write whose author was looking at a key the vault has rotated past.
 *
 * The seat encrypted with the key it holds; if the vault moved on, storing
 * that ciphertext would put a row under a key nothing can open. The message is
 * the one R13 names, because "re-enter this secret" is the only repair — the
 * gateway cannot decrypt the intent to re-encrypt it, which is the point.
 */
export function assertLiveLockerKeyId(
  vault: DatabaseSync,
  keyId: string
): void {
  const live = liveLockerKeyId(vault);
  if (live === null) {
    throw new LockerKeyError(
      "not_founded",
      "this vault has no Locker key plane — no secret can be stored until one is founded"
    );
  }
  if (live !== keyId) {
    throw new LockerKeyError(
      "stale_key_id",
      `this secret was encrypted under Locker key ${keyId}, which is no longer live (${live}) — re-enter this secret`
    );
  }
}

export interface LockerRotation {
  readonly previousKeyId: string;
  readonly keyId: string;
  readonly key: Buffer;
  /** Rows re-encrypted, by physical table. */
  readonly rewritten: Readonly<Record<string, number>>;
}

export interface RotateLockerKeyOptions {
  readonly now?: string;
  /**
   * Fault-injection seam for the crash test: called AFTER `K′` is on disk and
   * BEFORE the DB transaction opens. Throwing here reproduces the one crash
   * window rotation has, and the recovery below is what must survive it.
   */
  readonly beforeCommit?: (keyId: string) => void;
}

/**
 * Rotate `K` → `K′` in the order the header states. Returns the new key.
 *
 * Revoke IS rotate: a device that held `K` keeps a key that opens nothing
 * written after this call. R13 is honest about the trade — rotation protects
 * what comes after, not what a revoked device already read.
 */
export function rotateLockerKey(
  vault: DatabaseSync,
  custody: LockerKeyCustody,
  options: RotateLockerKeyOptions = {}
): LockerRotation {
  const now = options.now ?? new Date().toISOString();
  const previousKeyId = liveLockerKeyId(vault);
  if (previousKeyId === null) {
    throw new LockerKeyError(
      "not_founded",
      "this vault has no Locker key plane to rotate"
    );
  }
  const previousKey = loadLockerKey(custody, previousKeyId);
  const keyId = randomUUID();

  // STEP 1 — the new key file, before anything in the DB names it.
  const key = custody.store.create(lockerKeyFileName(custody.vaultId, keyId));
  options.beforeCommit?.(keyId);

  // STEP 2 — one transaction. Either every ciphertext is under `K′` and every
  // `key_id` says so, or none of it happened.
  const rewritten: Record<string, number> = {};
  vault.exec("BEGIN IMMEDIATE");
  try {
    // Retire BEFORE inserting: `locker_key_live_idx` is checked per statement,
    // not per transaction, so "two live rows" is unrepresentable even for the
    // instant between these two writes. Nothing observes the gap — both are
    // inside one transaction, and a reader outside it sees the old row live
    // until the commit makes the new one live.
    vault
      .prepare(`UPDATE locker_key SET retired_at = ? WHERE key_id = ?`)
      .run(now, previousKeyId);
    vault
      .prepare(
        `INSERT INTO locker_key (key_id, created_at, retired_at) VALUES (?, ?, NULL)`
      )
      .run(keyId, now);
    for (const [table, spec] of Object.entries(LOCKER_ENCRYPTED_COLUMNS)) {
      const select = vault.prepare(
        `SELECT ${spec.pk} AS pk, ${spec.columns.join(", ")} FROM ${table} WHERE key_id = ?`
      );
      const update = vault.prepare(
        `UPDATE ${table} SET ${spec.columns.map((c) => `${c} = ?`).join(", ")}, key_id = ? WHERE ${spec.pk} = ?`
      );
      let count = 0;
      for (const row of select.all(previousKeyId) as Record<
        string,
        unknown
      >[]) {
        const rowId = String(row["pk"]);
        const next = spec.columns.map((column) => {
          const value = row[column];
          if (!isLockerCiphertext(value)) return value ?? null;
          return encryptUnderLockerKey(
            key,
            keyId,
            rowId,
            decryptUnderLockerKey(previousKey, previousKeyId, rowId, value)
          );
        });
        update.run(...(next as (string | null)[]), keyId, rowId);
        count += 1;
      }
      // Rows written before the plane existed carry a NULL key id; they hold
      // no ciphertext, so they simply join the live key.
      vault
        .prepare(`UPDATE ${table} SET key_id = ? WHERE key_id IS NULL`)
        .run(keyId);
      rewritten[table] = count;
    }
    vault.exec("COMMIT");
  } catch (error) {
    vault.exec("ROLLBACK");
    // The new file is now an orphan no row names. Sweep it here rather than
    // leaving it for the next open: a failed rotation should cost nothing.
    custody.store.destroy(lockerKeyFileName(custody.vaultId, keyId));
    throw error;
  }

  // STEP 3 — the old file, last. Everything above already reads `K′`.
  custody.store.destroy(lockerKeyFileName(custody.vaultId, previousKeyId));
  return { previousKeyId, keyId, key, rewritten };
}

/**
 * Reconcile `keys/` with the DB after a crash. Returns the files it removed.
 *
 * The whole recovery story of the two-store order: whatever the DB names is
 * live, every other Locker key file for this vault is a leftover of an
 * interrupted rotation. Called on open, so a crash in either window costs one
 * directory listing rather than an operator gesture.
 */
export function sweepRetiredLockerKeys(
  vault: DatabaseSync,
  custody: LockerKeyCustody
): string[] {
  const live = liveLockerKeyId(vault);
  if (live === null) return [];
  const dir = custody.store.dir;
  if (!existsSync(dir)) return [];
  const keep = lockerKeyFileName(custody.vaultId, live);
  const prefix = `${custody.vaultId}.locker.`;
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".key")) continue;
    if (name === keep) continue;
    rmSync(path.join(dir, name), { force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * Every LIVE key file for this vault, for the recovery kit (R13 as corrected).
 *
 * "Every live key file" is not always one: `K′` exists on disk before the DB
 * names it, so a kit written mid-rotation must carry both or the restore it
 * promises is a placebo. The sweep above is what makes the set small again;
 * this is what makes it complete while it is not.
 */
export function lockerKeyFilesInCustody(
  custody: LockerKeyCustody
): { keyId: string; key: Buffer }[] {
  const out: { keyId: string; key: Buffer }[] = [];
  const dir = custody.store.dir;
  if (!existsSync(dir)) return out;
  const prefix = `${custody.vaultId}.locker.`;
  for (const name of readdirSync(dir).sort()) {
    if (!name.startsWith(prefix) || !name.endsWith(".key")) continue;
    const keyId = name.slice(prefix.length, -".key".length);
    if (keyId.length === 0) continue;
    const key = custody.store.load(name);
    if (key) out.push({ keyId, key });
  }
  return out;
}

/** The same set, checked against the DB's word on which key is live. */
export function liveLockerKeyFiles(
  vault: DatabaseSync,
  custody: LockerKeyCustody
): { keyId: string; key: Buffer }[] {
  const files = lockerKeyFilesInCustody(custody);
  const live = liveLockerKeyId(vault);
  if (live !== null && !files.some((file) => file.keyId === live)) {
    throw new LockerKeyError(
      "missing",
      `recovery kit: vault "${custody.vaultId}" names Locker key ${live} but holds no key file for it`
    );
  }
  return files;
}

/**
 * Found the plane on a vault with no key directory (an in-memory test vault).
 *
 * The ROW still exists — `locker_item.key_id` references it, and a schema
 * whose foreign key resolves only on disk is a schema with two shapes. The
 * key is ephemeral and lives in the process, exactly as `ephemeralSealKey`
 * does and for the same reason: nothing durable was written, so nothing
 * durable can be lost.
 */
export function ephemeralLockerKeyId(
  vault: DatabaseSync,
  now: string = new Date().toISOString()
): string {
  const live = liveLockerKeyId(vault);
  if (live !== null) return live;
  const keyId = randomUUID();
  vault
    .prepare(
      `INSERT INTO locker_key (key_id, created_at, retired_at) VALUES (?, ?, NULL)`
    )
    .run(keyId, now);
  return keyId;
}

/**
 * Destroy EVERY Locker key file for a vault. Returns the files it removed.
 *
 * The erase half of custody (#555's crypto-erase, extended by #996 R13). An
 * erase that destroyed the DEK and left `K` behind would leave the one key
 * that still opens the vault's secrets sitting beside the rubble — and a
 * re-created vault of the same id would inherit a key file its own
 * `locker_key` row does not name. `sweepRetiredLockerKeys` cannot do this job:
 * it asks the database which key is live, and an erase has already removed it.
 */
export function destroyLockerKeys(custody: LockerKeyCustody): string[] {
  const removed: string[] = [];
  for (const entry of lockerKeyFilesInCustody(custody)) {
    const name = lockerKeyFileName(custody.vaultId, entry.keyId);
    if (custody.store.destroy(name)) removed.push(name);
  }
  return removed;
}

/**
 * The vault's own id, from `core_vault` — what a Locker key file is named for.
 *
 * NOT `path.basename(vaultDir)`. That spelling is what `sealKeyFileFor` uses,
 * and it survives only because a vault that has never sealed anything may mint
 * a fresh DEK: a restored, adopted or renamed directory silently gets a new
 * key and nobody notices until a secret exists. `K` has no such escape — the
 * plane always names a live key — so the name has to follow the VAULT, and a
 * vault carries its identity in its own file.
 */
export function vaultIdOf(vault: DatabaseSync): string {
  const row = vault.prepare(`SELECT vault_id FROM core_vault LIMIT 1`).get() as
    | { vault_id: string }
    | undefined;
  if (!row) {
    throw new LockerKeyError(
      "not_founded",
      "this file has no core_vault row yet — the Locker key plane is founded with the vault, not before it"
    );
  }
  return row.vault_id;
}

/**
 * THE WRITE PATH NAMES ITS KEY (#996, ruling R13).
 *
 * Called from `sealWrites` — the one chokepoint every writer passes — so the
 * rule is the engine's rather than each command's. Three cases, and the third
 * is the one this exists for:
 *
 *   - a row with no `lk1:` ciphertext holds no secret under `K`; it joins the
 *     live key so the next write has something to compare against;
 *   - a row whose ciphertext is under the live key is stamped and stored;
 *   - a row whose ciphertext is under any OTHER key — an offline seat's
 *     intent that was queued before a rotation, or a `key_id` that names
 *     nothing — is REFUSED with "re-enter this secret". The gateway cannot
 *     repair it: it holds `K′` and the ciphertext is under `K`, and it will
 *     not decrypt on a caller's behalf even when it could. The only repair is
 *     the owner typing the secret again, so that is what the message says.
 *
 * The seat checks this too, before it posts, where the plaintext is still in
 * hand. That check is a courtesy to the owner; this one is the rule.
 */
export function stampLockerKeyOnWrite(
  vault: DatabaseSync,
  physical: string,
  rowId: string
): void {
  const spec = LOCKER_ENCRYPTED_COLUMNS[physical];
  if (!spec) return;
  const row = vault
    .prepare(
      `SELECT key_id, ${spec.columns.join(", ")} FROM ${physical} WHERE ${spec.pk} = ?`
    )
    .get(rowId) as Record<string, unknown> | undefined;
  if (!row) return;
  const carriesCiphertext = spec.columns.some((column) =>
    isLockerCiphertext(row[column])
  );
  const live = liveLockerKeyId(vault);
  if (live === null) {
    if (!carriesCiphertext) return;
    throw new LockerKeyError(
      "not_founded",
      "this vault has no Locker key plane — no secret can be stored until one is founded"
    );
  }
  const declared = row["key_id"];
  if (carriesCiphertext) {
    // NULL is a refusal, not a default. Ciphertext whose key nothing names is
    // ciphertext nobody can ever open, and stamping the live id over it would
    // record a lie that only surfaces at the next reveal.
    if (typeof declared !== "string" || declared.length === 0) {
      throw new LockerKeyError(
        "stale_key_id",
        "this secret arrived as ciphertext naming no Locker key — re-enter this secret"
      );
    }
    assertLiveLockerKeyId(vault, declared);
    return;
  }
  if (declared !== live) {
    vault
      .prepare(`UPDATE ${physical} SET key_id = ? WHERE ${spec.pk} = ?`)
      .run(live, rowId);
  }
}
