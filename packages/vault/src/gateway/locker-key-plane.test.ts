// THE KEY PLANE (#996, R13): `K` at founding, the AAD binding, the rotation
// order across two stores that share no transaction, and the crash between
// them. The crash test is the one that matters — `keys/` and `vault.db` cannot
// commit together, so the ONLY guarantee available is the order, and a test
// that never interrupts it proves nothing about the property it claims.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import {
  LOCKER_CIPHERTEXT_PREFIX,
  assertLiveLockerKeyId,
  decryptUnderLockerKey,
  encryptUnderLockerKey,
  foundLockerKey,
  isLockerCiphertext,
  liveLockerKeyFiles,
  liveLockerKeyId,
  loadLockerKey,
  lockerKeyCustody,
  lockerKeyFileName,
  lockerKeyRows,
  rotateLockerKey,
  stampLockerKeyOnWrite,
  sweepRetiredLockerKeys,
} from "./locker-key-plane.js";
import type { LockerKeyCustody } from "./locker-key-plane.js";

let root: string;
let vaultDir: string;
let vaultId: string;
let db: VaultDb;
let custody: LockerKeyCustody;

function keyFiles(): string[] {
  const dir = custody.store.dir;
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => n.includes(".locker.") && n.endsWith(".key"))
        .sort()
    : [];
}

/** One login with a secret already encrypted under the live key. */
function seedItem(id: string, secret: string): void {
  const { keyId, key } = db.lockerKey();
  db.vault
    .prepare(
      `INSERT INTO core_entity (entity_id, entity_type, created_at)
       VALUES (?, 'locker.item', '2026-01-01T00:00:00.000Z')`
    )
    .run(id);
  db.vault
    .prepare(
      `INSERT INTO locker_item (item_id, type, title, password, created_at, key_id)
       VALUES (?, 'login', 'example.com', ?, '2026-01-01T00:00:00.000Z', ?)`
    )
    .run(id, encryptUnderLockerKey(key, keyId, id, secret), keyId);
}

function storedPassword(id: string): string {
  return (
    db.vault
      .prepare(`SELECT password FROM locker_item WHERE item_id = ?`)
      .get(id) as {
      password: string;
    }
  ).password;
}

describe("locker-key-plane", () => {
  beforeEach(() => {
    root = tempDirSync("locker-key-plane-");
    vaultDir = path.join(root, "vault", "vault-a");
    db = openVaultDb({ dir: vaultDir });
    // `K` is named for the VAULT, not for its directory, so the vault has to
    // exist before there is a key to found (db.ts, `lockerKey`).
    vaultId = bootstrapVault(db, { ownerName: "Priya" }).vaultId;
    custody = lockerKeyCustody(vaultDir, vaultId);
  });

  afterEach(() => {
    db.close();
  });

  test("`K` is minted at founding, once, with one live row and one file", () => {
    // Founding happens on the first ask, because `K` is named for the vault
    // and the vault does not exist until it is bootstrapped.
    const keyId = db.lockerKey().keyId;
    expect(liveLockerKeyId(db.vault)).toBe(keyId);
    expect(db.lockerKey().key).toHaveLength(32);
    expect(keyFiles()).toStrictEqual([lockerKeyFileName(vaultId, keyId)]);
    // Idempotent: reopening does not mint a second key.
    const again = foundLockerKey(db.vault, custody);
    expect(again.keyId).toBe(keyId);
    expect(again.key.equals(db.lockerKey().key)).toBe(true);
    expect(lockerKeyRows(db.vault)).toHaveLength(1);
  });

  test("the key file lives outside the vault directory", () => {
    // The property a `cp -r vault/` gesture rests on: a copied vault is
    // ciphertext, because the key was never inside what was copied.
    expect(custody.store.dir.startsWith(path.resolve(vaultDir))).toBe(false);
    expect(existsSync(path.join(vaultDir, "vault.db"))).toBe(true);
  });

  test("AAD binds a ciphertext to its row AND its key id", () => {
    const keyId = db.lockerKey().keyId;
    const ct = encryptUnderLockerKey(
      db.lockerKey().key,
      keyId,
      "row-1",
      "hunter2"
    );
    expect(ct.startsWith(LOCKER_CIPHERTEXT_PREFIX)).toBe(true);
    expect(isLockerCiphertext(ct)).toBe(true);
    expect(decryptUnderLockerKey(db.lockerKey().key, keyId, "row-1", ct)).toBe(
      "hunter2"
    );
    // Moved to another row, or claimed under another key id: both refuse.
    expect(() =>
      decryptUnderLockerKey(db.lockerKey().key, keyId, "row-2", ct)
    ).toThrow(/unable to authenticate/u);
    expect(() =>
      decryptUnderLockerKey(db.lockerKey().key, "another-key", "row-1", ct)
    ).toThrow(/unable to authenticate/u);
  });

  test("a fresh nonce per value — the same plaintext twice is two ciphertexts", () => {
    const a = encryptUnderLockerKey(
      db.lockerKey().key,
      db.lockerKey().keyId,
      "row-1",
      "same"
    );
    const b = encryptUnderLockerKey(
      db.lockerKey().key,
      db.lockerKey().keyId,
      "row-1",
      "same"
    );
    expect(a).not.toBe(b);
  });

  test("a stale `key_id` intent is refused with the message", () => {
    seedItem("item-1", "hunter2");
    const stale = db.lockerKey().keyId;
    rotateLockerKey(db.vault, custody);
    expect(() => assertLiveLockerKeyId(db.vault, stale)).toThrow(
      expect.objectContaining({
        name: "LockerKeyError",
        code: "stale_key_id",
        message: expect.stringContaining("re-enter this secret"),
      })
    );
  });

  test("rotation re-encrypts under `K′` and leaves exactly one key file", () => {
    seedItem("item-1", "hunter2");
    const before = storedPassword("item-1");
    const original = db.lockerKey();
    const rotation = rotateLockerKey(db.vault, custody);

    expect(rotation.previousKeyId).toBe(original.keyId);
    expect(rotation.rewritten["locker_item"]).toBe(1);
    expect(liveLockerKeyId(db.vault)).toBe(rotation.keyId);
    // The ciphertext CHANGED and opens only under the new key.
    const after = storedPassword("item-1");
    expect(after).not.toBe(before);
    expect(
      decryptUnderLockerKey(rotation.key, rotation.keyId, "item-1", after)
    ).toBe("hunter2");
    expect(() =>
      decryptUnderLockerKey(original.key, original.keyId, "item-1", after)
    ).toThrow(/unable to authenticate/u);
    // Step 3 ran: the old file is gone, and only the live key remains.
    expect(keyFiles()).toStrictEqual([
      lockerKeyFileName(vaultId, rotation.keyId),
    ]);
    const rows = lockerKeyRows(db.vault);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.retiredAt === null)).toHaveLength(1);
  });

  test("a crash between the key-file write and the DB commit recovers", () => {
    seedItem("item-1", "hunter2");
    const originalKeyId = db.lockerKey().keyId;
    const originalCiphertext = storedPassword("item-1");
    let crashedKeyId = "";

    // THE CRASH: `K′` is on disk, nothing in the DB names it yet.
    expect(() =>
      rotateLockerKey(db.vault, custody, {
        beforeCommit: (keyId) => {
          crashedKeyId = keyId;
          throw new Error("power loss between the key file and the commit");
        },
      })
    ).toThrow(/power loss/u);

    // The DB is untouched: the old key is still live and the ciphertext is
    // still under it. Nothing is under two keys, because nothing moved.
    expect(liveLockerKeyId(db.vault)).toBe(originalKeyId);
    expect(storedPassword("item-1")).toBe(originalCiphertext);
    expect(
      decryptUnderLockerKey(
        db.lockerKey().key,
        originalKeyId,
        "item-1",
        originalCiphertext
      )
    ).toBe("hunter2");

    // Reopening recovers: the sweep removes the orphan `K′` the DB never
    // named, and the live key still opens every secret.
    db.close();
    db = openVaultDb({ dir: vaultDir });
    expect(db.lockerKey().keyId).toBe(originalKeyId);
    expect(keyFiles()).toStrictEqual([
      lockerKeyFileName(vaultId, originalKeyId),
    ]);
    expect(keyFiles()).not.toContain(lockerKeyFileName(vaultId, crashedKeyId));
    expect(
      decryptUnderLockerKey(
        db.lockerKey().key,
        originalKeyId,
        "item-1",
        storedPassword("item-1")
      )
    ).toBe("hunter2");
  });

  test("a crash between the DB commit and the old file's deletion recovers", () => {
    seedItem("item-1", "hunter2");
    const staleKeyId = db.lockerKey().keyId;
    // Simulate: rotate, then put the retired file back as an interrupted
    // step 3 would have left it.
    const rotation = rotateLockerKey(db.vault, custody);
    custody.store.import(
      lockerKeyFileName(vaultId, staleKeyId),
      Buffer.alloc(32, 7)
    );
    expect(keyFiles()).toHaveLength(2);

    // The DB is the authority on which of the two is live, so recovery needs
    // no memory of where the crash happened.
    const removed = sweepRetiredLockerKeys(db.vault, custody);
    expect(removed).toStrictEqual([lockerKeyFileName(vaultId, staleKeyId)]);
    expect(keyFiles()).toStrictEqual([
      lockerKeyFileName(vaultId, rotation.keyId),
    ]);
    expect(
      decryptUnderLockerKey(
        rotation.key,
        rotation.keyId,
        "item-1",
        storedPassword("item-1")
      )
    ).toBe("hunter2");
  });

  test("the recovery kit's key set carries every live key file", () => {
    const live = db.lockerKey();
    const files = liveLockerKeyFiles(db.vault, custody);
    expect(files).toHaveLength(1);
    expect(files[0]!.keyId).toBe(live.keyId);
    expect(files[0]!.key.equals(live.key)).toBe(true);

    // MID-ROTATION the set is TWO. A kit written in that window and carrying
    // only the live id would restore ciphertext it cannot open the moment the
    // rotation completes — a placebo, which is the failure the kit exists to
    // rule out.
    custody.store.import(
      lockerKeyFileName(vaultId, "in-flight"),
      Buffer.alloc(32, 3)
    );
    expect(
      liveLockerKeyFiles(db.vault, custody)
        .map((f) => f.keyId)
        .sort()
    ).toStrictEqual([live.keyId, "in-flight"].sort());
  });

  test("the write path stamps the live key onto a row that holds no ciphertext", () => {
    // A row with nothing under `K` still names the live key, so the NEXT
    // write has something to compare against rather than a NULL to interpret.
    db.vault
      .prepare(
        `INSERT INTO core_entity (entity_id, entity_type, created_at)
         VALUES ('item-plain', 'locker.item', '2026-01-01T00:00:00.000Z')`
      )
      .run();
    db.vault
      .prepare(
        `INSERT INTO locker_item (item_id, type, title, created_at)
         VALUES ('item-plain', 'login', 'example.com', '2026-01-01T00:00:00.000Z')`
      )
      .run();
    stampLockerKeyOnWrite(db.vault, "locker_item", "item-plain");
    expect(
      (
        db.vault
          .prepare(
            `SELECT key_id FROM locker_item WHERE item_id = 'item-plain'`
          )
          .get() as { key_id: string }
      ).key_id
    ).toBe(db.lockerKey().keyId);
  });

  test("the write path refuses ciphertext under a key the vault moved past", () => {
    seedItem("item-1", "hunter2");
    const stale = db.lockerKey().keyId;
    rotateLockerKey(db.vault, custody);
    // An offline seat's intent, queued before the rotation and replayed after
    // it: the ciphertext is under `K` and the vault holds `K′`. The gateway
    // will not decrypt on the caller's behalf even though it still could, so
    // the only repair is the owner typing the secret again.
    db.vault
      .prepare(`UPDATE locker_item SET key_id = ? WHERE item_id = 'item-1'`)
      .run(stale);
    expect(() =>
      stampLockerKeyOnWrite(db.vault, "locker_item", "item-1")
    ).toThrow(
      expect.objectContaining({
        code: "stale_key_id",
        message: expect.stringContaining("re-enter this secret"),
      })
    );
  });

  test("the write path refuses ciphertext that names no key at all", () => {
    seedItem("item-1", "hunter2");
    // Stamping the live id over this would record a lie that only surfaces at
    // the next reveal, so a NULL beside ciphertext is a refusal, not a default.
    db.vault
      .prepare(`UPDATE locker_item SET key_id = NULL WHERE item_id = 'item-1'`)
      .run();
    expect(() =>
      stampLockerKeyOnWrite(db.vault, "locker_item", "item-1")
    ).toThrow(
      expect.objectContaining({
        code: "stale_key_id",
        message: expect.stringContaining("re-enter this secret"),
      })
    );
  });

  test("a missing key file is loud custody loss, never a re-mint", () => {
    const keyId = db.lockerKey().keyId;
    custody.store.destroy(lockerKeyFileName(vaultId, keyId));
    expect(() => loadLockerKey(custody, keyId)).toThrow(
      expect.objectContaining({
        name: "LockerKeyError",
        code: "missing",
        message: expect.stringContaining("recovery kit"),
      })
    );
    // And the kit refuses to claim it can restore what it cannot carry.
    expect(() => liveLockerKeyFiles(db.vault, custody)).toThrow(
      /holds no key file/u
    );
  });
});
