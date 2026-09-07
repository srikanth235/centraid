// REVEAL DECRYPTS LOCALLY (#996, R13), and the two implementations of the
// envelope agree.
//
// The seat's WebCrypto code and the gateway's node:crypto code are two
// implementations of one wire form, which is exactly the shape that drifts.
// So the test does not check each against itself: it encrypts on one and
// decrypts on the other, both ways.
import { describe, expect, test } from "vitest";

import {
  decryptUnderLockerKey,
  encryptUnderLockerKey,
  isLockerCiphertext as vaultIsLockerCiphertext,
} from "@centraid/vault";

import {
  assertLockerKeyIdLive,
  decryptLockerSecret,
  encryptLockerSecret,
  isLockerCiphertext,
  StaleLockerKeyError,
} from "./locker-secret.js";

const KEY = new Uint8Array(32).fill(5);
const VAULT = { keyId: "k-1", key: KEY };

describe("locker-secret", () => {
  test("what the gateway wrote, the seat opens", async () => {
    const ciphertext = encryptUnderLockerKey(
      Buffer.from(KEY),
      "k-1",
      "item-1",
      "hunter2-Corr3ct"
    );
    expect(isLockerCiphertext(ciphertext)).toBe(true);
    await expect(
      decryptLockerSecret(VAULT, { id: "item-1", keyId: "k-1" }, ciphertext)
    ).resolves.toBe("hunter2-Corr3ct");
  });

  test("what the seat wrote, the gateway opens", async () => {
    // The offline-write direction: a seat encrypts an edit under `K` and the
    // gateway stores the ciphertext without ever seeing the value.
    const ciphertext = await encryptLockerSecret(
      VAULT,
      "item-1",
      "новый пароль"
    );
    expect(vaultIsLockerCiphertext(ciphertext)).toBe(true);
    expect(
      decryptUnderLockerKey(Buffer.from(KEY), "k-1", "item-1", ciphertext)
    ).toBe("новый пароль");
  });

  test("the AAD binds a ciphertext to its row and its key on this side too", async () => {
    const ciphertext = await encryptLockerSecret(VAULT, "item-1", "hunter2");
    await expect(
      decryptLockerSecret(VAULT, { id: "item-2", keyId: "k-1" }, ciphertext)
    ).rejects.toThrow(/operation-specific reason|decrypt/iu);
    await expect(
      decryptLockerSecret(
        { keyId: "k-2", key: KEY },
        { id: "item-1", keyId: "k-2" },
        ciphertext
      )
    ).rejects.toThrow(/operation-specific reason|decrypt/iu);
  });

  test("a stale key_id is refused with the message, before anything is posted", () => {
    // The seat catches it while it still has the plaintext and can ask for
    // it again. `assertLiveLockerKeyId` is the gateway's own copy of this
    // check, so the refusal does not depend on the seat being honest.
    expect(() => assertLockerKeyIdLive("k-old", "k-new")).toThrow(
      "re-enter this secret"
    );
    expect(() => assertLockerKeyIdLive("k-old", "k-new")).toThrow(
      StaleLockerKeyError
    );
    // The live key, and a row that predates the plane, both pass.
    expect(() => assertLockerKeyIdLive("k-new", "k-new")).not.toThrow();
    expect(() => assertLockerKeyIdLive(null, "k-new")).not.toThrow();
  });

  test("a reveal under a rotated key never reaches the cipher", async () => {
    const ciphertext = await encryptLockerSecret(VAULT, "item-1", "hunter2");
    await expect(
      decryptLockerSecret(
        { keyId: "k-2", key: KEY },
        { id: "item-1", keyId: "k-1" },
        ciphertext
      )
    ).rejects.toThrow(StaleLockerKeyError);
  });

  test("the predicate is structural on both sides", async () => {
    for (const value of [
      "",
      "lk1:",
      "lk1:not base64!",
      "hunter2",
      "lk1:AAAA",
    ]) {
      expect(isLockerCiphertext(value), value).toBe(false);
      expect(vaultIsLockerCiphertext(value), value).toBe(false);
    }
  });
});
