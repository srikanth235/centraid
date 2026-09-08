// THE UNLOCK BOUNDARY, DESKTOP AND PWA (#996, R13 / OQ-10).
//
// The claim under test is not "AES-GCM works". It is that the seat cannot
// produce a secret without someone proving presence: nothing at rest opens
// without the passphrase, the session ends on the clock rather than on a
// timer that may never fire, and a locked session hands back an error rather
// than stale bytes.
import { describe, expect, test } from "vitest";

import {
  LOCKER_PASSPHRASE_MINIMUM,
  LOCKER_REVEAL_WINDOW_MS,
  LOCKER_SESSION_TIMEOUT_MS,
  LockerSession,
  LockerUnlockError,
  unwrapVaultKey,
  wrapVaultKey,
} from "./locker-unlock.js";
import { memoryWrappedKeyStore } from "./wrapped-key-store.js";

const KEY = new Uint8Array(32).fill(9);
const PASSPHRASE = "correct horse battery staple";

function session(now: () => number = () => 0): {
  session: LockerSession;
  store: ReturnType<typeof memoryWrappedKeyStore>;
} {
  const store = memoryWrappedKeyStore();
  return {
    store,
    session: new LockerSession({ store, vaultId: "v-1", now }),
  };
}

describe("locker-unlock", () => {
  test("the numbers are the product's, carried over from the gateway gate", () => {
    expect(LOCKER_SESSION_TIMEOUT_MS).toBe(5 * 60 * 1000);
    expect(LOCKER_REVEAL_WINDOW_MS).toBe(30 * 1000);
    expect(LOCKER_PASSPHRASE_MINIMUM).toBe(12);
  });

  test("nothing at rest carries the key or the passphrase", async () => {
    const wrapped = await wrapVaultKey(PASSPHRASE, {
      vaultId: "v-1",
      keyId: "k-1",
      key: KEY,
    });
    const text = JSON.stringify(wrapped);
    expect(text).not.toContain(PASSPHRASE);
    expect(text).not.toContain(Buffer.from(KEY).toString("base64"));
    // And no verifier either: the only way to test a guess is to do the
    // derivation, so a copied blob is not a cheap oracle.
    expect(Object.keys(wrapped).toSorted()).toStrictEqual([
      "ciphertext",
      "iterations",
      "kdf",
      "keyId",
      "nonce",
      "salt",
      "v",
      "vaultId",
    ]);
  });

  test("round-trips under the right passphrase and refuses the wrong one", async () => {
    const wrapped = await wrapVaultKey(PASSPHRASE, {
      vaultId: "v-1",
      keyId: "k-1",
      key: KEY,
    });
    await expect(unwrapVaultKey(PASSPHRASE, wrapped)).resolves.toStrictEqual(
      KEY
    );
    await expect(
      unwrapVaultKey("correct horse battery stapl", wrapped)
    ).rejects.toThrow(expect.objectContaining({ code: "wrong_passphrase" }));
  });

  test("a fresh wrap of the same key is different bytes", async () => {
    // Salt and nonce are per wrap, so two enrolments of one vault are not
    // comparable at rest — which is what stops "these two seats hold the same
    // secret" being readable off disk.
    const a = await wrapVaultKey(PASSPHRASE, {
      vaultId: "v-1",
      keyId: "k",
      key: KEY,
    });
    const b = await wrapVaultKey(PASSPHRASE, {
      vaultId: "v-1",
      keyId: "k",
      key: KEY,
    });
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.salt).not.toBe(b.salt);
  });

  test("the 12-character rule is enforced where the derivation happens", async () => {
    await expect(
      wrapVaultKey("short", { vaultId: "v-1", keyId: "k", key: KEY })
    ).rejects.toThrow(expect.objectContaining({ code: "too_short" }));
  });

  test("a session is locked until it is unlocked, and unlocking needs the passphrase", async () => {
    const { session: live } = session();
    await expect(live.enrolled()).resolves.toBe(false);
    expect(() => live.key()).toThrow(
      expect.objectContaining({ code: "locked" })
    );
    await expect(live.unlock(PASSPHRASE)).rejects.toThrow(
      expect.objectContaining({ code: "not_enrolled" })
    );

    await live.enroll(PASSPHRASE, { keyId: "k-1", key: KEY });
    await expect(live.enrolled()).resolves.toBe(true);
    // Enrolling did not unlock: writing the blob is not proving presence.
    expect(live.unlocked).toBe(false);
    await expect(live.unlock("wrong passphrase here")).rejects.toThrow(
      expect.objectContaining({ code: "wrong_passphrase" })
    );
    expect(live.unlocked).toBe(false);

    await live.unlock(PASSPHRASE);
    expect(live.key()).toStrictEqual({ keyId: "k-1", key: KEY });
  });

  test("the session ends on the clock, not on a timer that may never fire", async () => {
    let now = 0;
    const { session: live } = session(() => now);
    await live.enroll(PASSPHRASE, { keyId: "k-1", key: KEY });
    await live.unlock(PASSPHRASE);
    expect(live.remainingMs).toBe(LOCKER_SESSION_TIMEOUT_MS);

    // A backgrounded tab: no timer ran, and the session is over anyway.
    now = LOCKER_SESSION_TIMEOUT_MS;
    expect(live.unlocked).toBe(false);
    expect(() => live.key()).toThrow(
      expect.objectContaining({ code: "locked" })
    );
    expect(live.remainingMs).toBe(0);
  });

  test("deliberate use extends the session; idle is what ends it", async () => {
    let now = 0;
    const { session: live } = session(() => now);
    await live.enroll(PASSPHRASE, { keyId: "k-1", key: KEY });
    await live.unlock(PASSPHRASE);
    now = LOCKER_SESSION_TIMEOUT_MS - 1;
    live.touch();
    now = LOCKER_SESSION_TIMEOUT_MS + 1;
    expect(live.unlocked).toBe(true);
    // …but a touch after the end does not resurrect it.
    now = 2 * LOCKER_SESSION_TIMEOUT_MS + 1;
    live.touch();
    expect(live.unlocked).toBe(false);
  });

  test("lock() drops the bytes, and forget() drops the enrolment", async () => {
    const { session: live, store } = session();
    await live.enroll(PASSPHRASE, { keyId: "k-1", key: new Uint8Array(KEY) });
    await live.unlock(PASSPHRASE);
    live.lock();
    expect(() => live.key()).toThrow(LockerUnlockError);

    await live.unlock(PASSPHRASE);
    await live.forget();
    await expect(store.read("v-1")).resolves.toBeNull();
    await expect(live.unlock(PASSPHRASE)).rejects.toThrow(
      expect.objectContaining({ code: "not_enrolled" })
    );
  });
});
