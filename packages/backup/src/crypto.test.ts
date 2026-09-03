import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import {
  activeMasterKey,
  chunkId,
  createKeyring,
  decrypt,
  deriveDataKey,
  deriveDedupKey,
  deriveNonce,
  encrypt,
  encryptWithNonce,
  loadKeyring,
  masterKeyForEpoch,
  rotateKeyring,
  saveKeyring,
} from "./crypto.js";
import type { Keyring } from "./crypto.js";

describe("encrypt/decrypt", () => {
  test("roundtrips", () => {
    const key = new Uint8Array(32).fill(7);
    const plain = new TextEncoder().encode("the quick brown fox");
    const blob = encrypt(key, plain);
    expect(blob).toHaveLength(12 + plain.length + 16);
    const back = decrypt(key, blob);
    expect(new TextDecoder().decode(back)).toBe("the quick brown fox");
  });

  test("random IV means two encryptions of the same plaintext differ", () => {
    const key = new Uint8Array(32).fill(3);
    const plain = new TextEncoder().encode("same plaintext");
    const a = encrypt(key, plain);
    const b = encrypt(key, plain);
    expect([...a]).not.toStrictEqual([...b]);
    expect(new TextDecoder().decode(decrypt(key, a))).toBe("same plaintext");
    expect(new TextDecoder().decode(decrypt(key, b))).toBe("same plaintext");
  });

  test("tamper (flip a ciphertext byte) throws", () => {
    const key = new Uint8Array(32).fill(1);
    const blob = encrypt(key, new TextEncoder().encode("secret"));
    const tampered = new Uint8Array(blob);
    const midpoint = Math.floor(tampered.length / 2);
    tampered[midpoint] = (tampered[midpoint]! ^ 0xff) & 0xff;
    expect(() => decrypt(key, tampered)).toThrow(
      /unsupported state or unable to authenticate data/iu
    );
  });

  test("tamper (flip a tag byte) throws", () => {
    const key = new Uint8Array(32).fill(1);
    const blob = encrypt(key, new TextEncoder().encode("secret"));
    const tampered = new Uint8Array(blob);
    const lastByte = tampered.length - 1;
    tampered[lastByte] = (tampered[lastByte]! ^ 0xff) & 0xff;
    expect(() => decrypt(key, tampered)).toThrow(
      /unsupported state or unable to authenticate data/iu
    );
  });

  test("wrong key throws", () => {
    const key = new Uint8Array(32).fill(1);
    const wrongKey = new Uint8Array(32).fill(2);
    const blob = encrypt(key, new TextEncoder().encode("secret"));
    expect(() => decrypt(wrongKey, blob)).toThrow(
      /unsupported state or unable to authenticate data/iu
    );
  });

  test("truncated blob throws", () => {
    const key = new Uint8Array(32).fill(1);
    expect(() => decrypt(key, new Uint8Array(10))).toThrow(
      "encrypted blob truncated"
    );
  });
});

describe("deriveNonce / encryptWithNonce (deterministic sealing — /1, issue #408)", () => {
  const key = new Uint8Array(32).fill(0x11);

  test("deriveNonce yields 12 bytes and is deterministic for the same (key, info)", () => {
    const a = deriveNonce(key, "centraid-backup:wal-nonce:vault:g:0:0:100");
    const b = deriveNonce(key, "centraid-backup:wal-nonce:vault:g:0:0:100");
    expect(a).toHaveLength(12);
    expect([...a]).toStrictEqual([...b]);
  });

  test("deriveNonce is info-sensitive — one character of drift means a fresh nonce", () => {
    const a = deriveNonce(key, "centraid-backup:wal-nonce:vault:g:0:0:100");
    const b = deriveNonce(key, "centraid-backup:wal-nonce:vault:g:0:0:101");
    expect([...a]).not.toStrictEqual([...b]);
  });

  test("deriveNonce is key-sensitive", () => {
    const otherKey = new Uint8Array(32).fill(0x12);
    const info = "same info string";
    expect([...deriveNonce(key, info)]).not.toStrictEqual([
      ...deriveNonce(otherKey, info),
    ]);
  });

  test("encryptWithNonce is fully deterministic and exposes the nonce as the first 12 bytes", () => {
    const nonce = deriveNonce(key, "nonce-info");
    const plain = new TextEncoder().encode("deterministic payload");
    const aad = new TextEncoder().encode("bound address");
    const a = encryptWithNonce(key, nonce, plain, aad);
    const b = encryptWithNonce(key, nonce, plain, aad);
    expect([...a]).toStrictEqual([...b]);
    expect([...a.subarray(0, 12)]).toStrictEqual([...nonce]);
    expect(a).toHaveLength(12 + plain.length + 16);
  });

  test("AAD roundtrip: decrypt succeeds only with the exact AAD it was sealed under", () => {
    const nonce = deriveNonce(key, "aad-roundtrip");
    const plain = new TextEncoder().encode("wal segment bytes");
    const aad = new TextEncoder().encode(
      "centraid-wal/1:vault-1:vault:g:0:0:17"
    );
    const blob = encryptWithNonce(key, nonce, plain, aad);
    expect([...decrypt(key, blob, aad)]).toStrictEqual([...plain]);
  });

  test("AAD mismatch throws — a swapped address must fail the tag check", () => {
    const nonce = deriveNonce(key, "aad-mismatch");
    const plain = new TextEncoder().encode("wal segment bytes");
    const aad = new TextEncoder().encode(
      "centraid-wal/1:vault-1:vault:g:0:0:17"
    );
    const blob = encryptWithNonce(key, nonce, plain, aad);
    const otherAad = new TextEncoder().encode(
      "centraid-wal/1:vault-1:vault:g:1:0:17"
    );
    expect(() => decrypt(key, blob, otherAad)).toThrow(
      /unsupported state or unable to authenticate data/iu
    );
    expect(() => decrypt(key, blob)).toThrow(
      /unsupported state or unable to authenticate data/iu
    );
    const noAadBlob = encryptWithNonce(key, nonce, plain);
    expect(() => decrypt(key, noAadBlob, aad)).toThrow(
      /unsupported state or unable to authenticate data/iu
    );
  });

  test("encryptWithNonce rejects a nonce that is not 12 bytes", () => {
    const plain = new TextEncoder().encode("x");
    expect(() => encryptWithNonce(key, new Uint8Array(11), plain)).toThrow(
      /12 bytes/u
    );
    expect(() => encryptWithNonce(key, new Uint8Array(16), plain)).toThrow(
      /12 bytes/u
    );
  });
});

describe("HKDF derivation", () => {
  test("deriveDataKey and deriveDedupKey are stable and distinct for the same input", () => {
    const master = new Uint8Array(32).fill(9);
    const dataKey1 = deriveDataKey(master, "vault-a");
    const dataKey2 = deriveDataKey(master, "vault-a");
    const dedupKey = deriveDedupKey(master, "vault-a");
    expect([...dataKey1]).toStrictEqual([...dataKey2]);
    expect([...dataKey1]).not.toStrictEqual([...dedupKey]);
    expect(dataKey1).toHaveLength(32);
  });

  test("different vaultId produces a different key (no cross-vault reuse)", () => {
    const master = new Uint8Array(32).fill(9);
    const keyA = deriveDataKey(master, "vault-a");
    const keyB = deriveDataKey(master, "vault-b");
    expect([...keyA]).not.toStrictEqual([...keyB]);
  });

  test("frozen HKDF vector — pins the exact info-string derivation", () => {
    const master = new Uint8Array(32).fill(0x42);
    const dataKey = deriveDataKey(master, "vault-frozen");
    const dedupKey = deriveDedupKey(master, "vault-frozen");
    expect(Buffer.from(dataKey).toString("hex")).toBe(
      "2c4b05ea97c0bc7191ad311e32c9902f17e8b1615ee69f7cc59acb997640e442"
    );
    expect(Buffer.from(dedupKey).toString("hex")).toBe(
      "e12bcf5846425642b5c02db8e746e129a98631a4b1666a34c4afb3b88119809e"
    );
  });

  test("chunkId is a deterministic keyed HMAC", () => {
    const dedupKey = new Uint8Array(32).fill(5);
    const plain = new TextEncoder().encode("chunk contents");
    const id1 = chunkId(dedupKey, plain);
    const id2 = chunkId(dedupKey, plain);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{64}$/u);
    const otherKey = new Uint8Array(32).fill(6);
    expect(chunkId(otherKey, plain)).not.toBe(id1);
  });
});

describe("keyring", () => {
  test("createKeyring mints a single-epoch keyring, mode 0600", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "keyring.json");
    const keyring = await createKeyring(file);
    expect(keyring.version).toBe(1);
    expect(keyring.active).toBe(1);
    expect(keyring.epochs).toHaveLength(1);
    const st = await fs.stat(file);
    expect(st.mode & 0o777).toBe(0o600);
  });

  test("createKeyring refuses to overwrite an existing file", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "keyring.json");
    await createKeyring(file);
    await expect(createKeyring(file)).rejects.toThrow(/already exists/u);
  });

  test("load/save roundtrip", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "keyring.json");
    const created = await createKeyring(file);
    const loaded = await loadKeyring(file);
    expect(loaded).toStrictEqual(created);
  });

  test("saveKeyring is atomic and mode 0600", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "keyring.json");
    const keyring: Keyring = {
      version: 1,
      active: 1,
      epochs: [
        {
          epoch: 1,
          key: Buffer.alloc(32, 1).toString("base64"),
          createdAt: new Date().toISOString(),
        },
      ],
    };
    await saveKeyring(file, keyring);
    const st = await fs.stat(file);
    expect(st.mode & 0o777).toBe(0o600);
    await expect(loadKeyring(file)).resolves.toStrictEqual(keyring);
  });

  test("rotateKeyring adds a new epoch and makes it active, retaining the old one", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "keyring.json");
    const original = await createKeyring(file);
    const rotated = await rotateKeyring(file);
    expect(rotated.active).toBe(2);
    expect(rotated.epochs).toHaveLength(2);
    expect(rotated.epochs[0]).toStrictEqual(original.epochs[0]);
    expect(rotated.epochs[1]!.epoch).toBe(2);

    const oldKey = masterKeyForEpoch(rotated, 1);
    expect(Buffer.from(oldKey).toString("base64")).toBe(
      original.epochs[0]!.key
    );

    const active = activeMasterKey(rotated);
    expect(active.epoch).toBe(2);
  });

  test("rotating twice keeps all three epochs, active = newest", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "keyring.json");
    await createKeyring(file);
    await rotateKeyring(file);
    const twiceRotated = await rotateKeyring(file);
    expect(twiceRotated.active).toBe(3);
    expect(twiceRotated.epochs.map((e) => e.epoch)).toStrictEqual([1, 2, 3]);
  });

  test("masterKeyForEpoch throws for an unknown epoch", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "keyring.json");
    const keyring = await createKeyring(file);
    expect(() => masterKeyForEpoch(keyring, 999)).toThrow(
      "keyring has no epoch 999"
    );
  });

  test("loadKeyring rejects a malformed file", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "keyring.json");
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, active: 1, epochs: [] })
    );
    await expect(loadKeyring(file)).rejects.toThrow(
      'keyring: missing "epochs"'
    );
  });
});
