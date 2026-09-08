/*
 * THE UNLOCK BOUNDARY, DESKTOP AND PWA (#996, ruling R13; OQ-10 as ruled).
 *
 * STORAGE IS NOT AUTHORIZATION. That sentence is the whole reason this file
 * exists. A non-extractable WebCrypto key stops export, not use by app code
 * running on the page. Electron's `safeStorage` encrypts at rest and prompts
 * for nothing. IndexedDB is readable by the origin that wrote it. Each of
 * those makes `K` harder to CARRY AWAY and none of them makes a person prove
 * they are present — so none of them is a boundary, and shipping one as if it
 * were is how the permit the gateway used to mint gets deleted in exchange
 * for nothing.
 *
 * What a boundary needs is something the owner KNOWS or IS. Touch ID is the
 * `IS` half and is deferred: it needs a signed, entitled macOS build, and an
 * unsigned dev build rejects `promptTouchID` outright. So v0 is the `KNOWS`
 * half on both seats — one local passphrase, PBKDF2-SHA-256 over it,
 * AES-GCM around `K`, and the wrapped blob is all that is ever at rest. The
 * passphrase is never stored, never sent, and never derivable from what is:
 * losing it means re-enrolling the seat, which is the honest cost of the
 * boundary actually being one.
 *
 * A SESSION, NOT A MODE. Unlocking mints a session with a hard expiry, and
 * `key()` re-checks the clock on every call rather than trusting a timer that
 * a backgrounded tab may never fire. `lock()` drops the bytes. The numbers are
 * the ones the gateway's `locker-auth.ts` used before it was deleted — five
 * minutes for a session, thirty seconds for a single reveal — kept because
 * they were the product's answer, not the gateway's implementation detail.
 */

/** The unlock session's life. Was `LOCKER_SESSION_TIMEOUT_MS`. */
export const LOCKER_SESSION_TIMEOUT_MS = 5 * 60 * 1000;
/** One reveal's window, used or not. Was `LOCKER_ITEM_PERMIT_MS`. */
export const LOCKER_REVEAL_WINDOW_MS = 30 * 1000;
/** The `Lock.tsx` rule, restated where the derivation happens. */
export const LOCKER_PASSPHRASE_MINIMUM = 12;

/**
 * PBKDF2 rounds. High enough to cost a guesser real time, low enough that an
 * unlock on a phone-class CPU stays under a second — the same trade
 * `password-wrap.ts` makes for the recovery kit, in the primitive the
 * browser actually gives us.
 */
export const LOCKER_WRAP_ITERATIONS = 600_000;

const SALT_BYTES = 16;
const NONCE_BYTES = 12;

/** What is at rest. No plaintext key, no passphrase, no verifier. */
export interface WrappedVaultKey {
  readonly v: 1;
  readonly vaultId: string;
  readonly keyId: string;
  readonly kdf: "pbkdf2-sha256";
  readonly iterations: number;
  /** base64 */
  readonly salt: string;
  /** base64 */
  readonly nonce: string;
  /** base64 of AES-GCM(K) — the tag is appended by WebCrypto. */
  readonly ciphertext: string;
}

/** Distinguishable, because "wrong passphrase" and "corrupt" are not the same. */
export class LockerUnlockError extends Error {
  constructor(
    readonly code: "wrong_passphrase" | "locked" | "not_enrolled" | "too_short",
    message: string
  ) {
    super(message);
    this.name = "LockerUnlockError";
  }
}

function base64(bytes: Uint8Array): string {
  if (typeof globalThis.btoa === "function") {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return globalThis.btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

function unbase64(value: string): Uint8Array {
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

function subtle(): SubtleCrypto {
  const api = globalThis.crypto?.subtle;
  if (!api) {
    // A page served over plain HTTP has no `crypto.subtle`, and a boundary
    // that silently degrades to "no encryption" is worse than no boundary.
    throw new LockerUnlockError(
      "not_enrolled",
      "this browser exposes no WebCrypto — Locker cannot wrap the vault key here, and will not pretend to"
    );
  }
  return api;
}

async function wrappingKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const material = await subtle().importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return subtle().deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Wrap `K` under a passphrase. The result is the ONLY thing written down. */
export async function wrapVaultKey(
  passphrase: string,
  vault: { vaultId: string; keyId: string; key: Uint8Array }
): Promise<WrappedVaultKey> {
  if (passphrase.length < LOCKER_PASSPHRASE_MINIMUM) {
    throw new LockerUnlockError(
      "too_short",
      `a Locker passphrase is at least ${LOCKER_PASSPHRASE_MINIMUM} characters`
    );
  }
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const wrapper = await wrappingKey(passphrase, salt, LOCKER_WRAP_ITERATIONS);
  const sealed = await subtle().encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource },
    wrapper,
    vault.key as BufferSource
  );
  return {
    v: 1,
    vaultId: vault.vaultId,
    keyId: vault.keyId,
    kdf: "pbkdf2-sha256",
    iterations: LOCKER_WRAP_ITERATIONS,
    salt: base64(salt),
    nonce: base64(nonce),
    ciphertext: base64(new Uint8Array(sealed)),
  };
}

/**
 * Unwrap `K`. A wrong passphrase is an AEAD authentication failure, which is
 * the whole verifier — nothing at rest can be checked against a guess without
 * doing the derivation, so there is no cheap oracle to attack.
 */
export async function unwrapVaultKey(
  passphrase: string,
  wrapped: WrappedVaultKey
): Promise<Uint8Array> {
  const wrapper = await wrappingKey(
    passphrase,
    unbase64(wrapped.salt),
    wrapped.iterations
  );
  try {
    const opened = await subtle().decrypt(
      { name: "AES-GCM", iv: unbase64(wrapped.nonce) as BufferSource },
      wrapper,
      unbase64(wrapped.ciphertext) as BufferSource
    );
    return new Uint8Array(opened);
  } catch {
    throw new LockerUnlockError(
      "wrong_passphrase",
      "that passphrase does not open this Locker"
    );
  }
}

/** Where a seat keeps the wrapped blob. IndexedDB on the PWA, Electron storage on desktop. */
export interface WrappedVaultKeyStore {
  read: (vaultId: string) => Promise<WrappedVaultKey | null>;
  write: (wrapped: WrappedVaultKey) => Promise<void>;
  clear: (vaultId: string) => Promise<void>;
}

export interface LockerSessionOptions {
  readonly store: WrappedVaultKeyStore;
  readonly vaultId: string;
  readonly sessionTimeoutMs?: number;
  /** Injectable for tests; a session must never read a clock it cannot be told about. */
  readonly now?: () => number;
}

/* oxlint-disable max-classes-per-file -- the typed unlock failure is colocated with the boundary that throws it, exactly as `schema/key-store.ts` colocates KeyStoreError with KeyStore (#996, R13) */
/**
 * One seat's unlock session.
 *
 * The clock is CHECKED, not scheduled. A `setTimeout` in a backgrounded tab or
 * a suspended Electron window may fire minutes late or never, and a session
 * that expires only when a timer says so is a session that does not expire.
 */
export class LockerSession {
  #key: Uint8Array | undefined;
  #keyId: string | undefined;
  #expiresAt = 0;
  private readonly now: () => number;
  private readonly timeout: number;

  constructor(private readonly options: LockerSessionOptions) {
    this.now = options.now ?? (() => Date.now());
    this.timeout = options.sessionTimeoutMs ?? LOCKER_SESSION_TIMEOUT_MS;
  }

  /** True when this seat has a wrapped key at rest to unlock. */
  async enrolled(): Promise<boolean> {
    return (await this.options.store.read(this.options.vaultId)) !== null;
  }

  /** First run: wrap the key the door handed us and write it down. */
  async enroll(
    passphrase: string,
    vault: { keyId: string; key: Uint8Array }
  ): Promise<void> {
    await this.options.store.write(
      await wrapVaultKey(passphrase, {
        vaultId: this.options.vaultId,
        keyId: vault.keyId,
        key: vault.key,
      })
    );
  }

  async unlock(passphrase: string): Promise<void> {
    const wrapped = await this.options.store.read(this.options.vaultId);
    if (!wrapped) {
      throw new LockerUnlockError(
        "not_enrolled",
        "this device has no Locker key yet — pair it with your gateway first"
      );
    }
    this.#key = await unwrapVaultKey(passphrase, wrapped);
    this.#keyId = wrapped.keyId;
    this.#expiresAt = this.now() + this.timeout;
  }

  get unlocked(): boolean {
    return this.#key !== undefined && this.now() < this.#expiresAt;
  }

  /** Milliseconds left, or 0. What the countdown in the UI reads. */
  get remainingMs(): number {
    return this.unlocked ? this.#expiresAt - this.now() : 0;
  }

  /**
   * The key, if the session is live. Expiry LOCKS as a side effect — a caller
   * that asks after the window has closed must not be able to ask again and
   * get a different answer.
   */
  key(): { keyId: string; key: Uint8Array } {
    if (!this.unlocked) {
      this.lock();
      throw new LockerUnlockError(
        "locked",
        "this Locker session has ended — unlock again to reveal a secret"
      );
    }
    return { keyId: this.#keyId as string, key: this.#key as Uint8Array };
  }

  /** Extend on deliberate use. Idle is what ends a session, not elapsed time. */
  touch(): void {
    if (this.unlocked) this.#expiresAt = this.now() + this.timeout;
  }

  lock(): void {
    // Zero before dropping the reference: the bytes are the secret, and a
    // garbage collector is not a promise about when they stop existing.
    this.#key?.fill(0);
    this.#key = undefined;
    this.#keyId = undefined;
    this.#expiresAt = 0;
  }

  /** Forget this seat entirely — the revoke gesture's local half. */
  async forget(): Promise<void> {
    this.lock();
    await this.options.store.clear(this.options.vaultId);
  }
}
