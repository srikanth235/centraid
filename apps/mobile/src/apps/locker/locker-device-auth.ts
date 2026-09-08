/*
 * THE UNLOCK BOUNDARY, ON THE PHONE (#996, ruling R13; OQ-10 as ruled).
 *
 * The OS prompt was already here; what it guarded was the wrong thing. This
 * store held a DEVICE SECRET whose only job was to buy a permit from the
 * gateway, which then decrypted a secret and sent the plaintext back. Behind
 * the same prompt it now holds `K` — the vault key — and the reveal happens
 * on this device. The gateway never sees the value again, and the phone works
 * with the radio off, which is the property the permit could never have.
 *
 * `requireAuthentication` is what makes this a boundary rather than storage:
 * the keychain will not hand the item back without Face ID, Touch ID or the
 * device passcode, and `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY` means the item
 * does not exist on a device with no passcode and does not travel in a
 * backup. That is a person proving presence, which `safeStorage` and a
 * non-extractable WebCrypto key are not (R13 says so in those words).
 *
 * A SESSION CACHE, BECAUSE A PROMPT PER FIELD IS A PROMPT NOBODY READS. The
 * unwrapped key lives in JS memory for one session — the same five minutes
 * the gateway's gate used — and `lockLocker()` drops it. It rides
 * `clearSecureCache()` so a lock, a background, or a timeout empties every
 * decrypted credential the app holds in one gesture rather than three.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

import { clearSecureCache } from "../../lib/secure-storage";

const CREDENTIAL_ID_KEY = "centraid.v1.locker.device-credential-id";
const SECRET_KEY = "centraid.locker.device-secret";
/** `K` and its id, per vault, behind the same prompt. */
const VAULT_KEY_PREFIX = "centraid.locker.vault-key.";
/** The session's life. The gateway gate's five minutes, kept as the product's answer. */
export const LOCKER_SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const OPTIONS: SecureStore.SecureStoreOptions = {
  authenticationPrompt: "Authenticate for Locker",
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
  requireAuthentication: true,
};

export function lockerBiometricsSupported(): boolean {
  return SecureStore.canUseBiometricAuthentication();
}

export async function lockerDeviceCredentialId(): Promise<string | null> {
  return AsyncStorage.getItem(CREDENTIAL_ID_KEY);
}

export async function newLockerDeviceSecret(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(32);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

export async function storeLockerDeviceCredential(
  credentialId: string,
  secret: string
): Promise<void> {
  await SecureStore.setItemAsync(SECRET_KEY, secret, OPTIONS);
  const verified = await SecureStore.getItemAsync(SECRET_KEY, OPTIONS);
  if (verified !== secret) {
    await SecureStore.deleteItemAsync(SECRET_KEY, OPTIONS).catch(
      () => undefined
    );
    throw new Error("Locker could not verify the biometric credential.");
  }
  await AsyncStorage.setItem(CREDENTIAL_ID_KEY, credentialId);
}

export async function readLockerDeviceCredential(): Promise<{
  credentialId: string;
  secret: string;
} | null> {
  const credentialId = await lockerDeviceCredentialId();
  if (!credentialId) return null;
  const secret = await SecureStore.getItemAsync(SECRET_KEY, OPTIONS);
  if (!secret) return null;
  return { credentialId, secret };
}

export async function removeLockerDeviceCredential(): Promise<void> {
  await SecureStore.deleteItemAsync(SECRET_KEY, OPTIONS).catch(() => undefined);
  await AsyncStorage.removeItem(CREDENTIAL_ID_KEY);
}

// ─── `K` behind the OS prompt (#996, R13) ─────────────────────────────────

/** What the key door handed this device, as the keychain holds it. */
export interface LockerVaultKeyRecord {
  readonly keyId: string;
  /** base64 — the keychain stores strings. */
  readonly key: string;
}

interface CachedVaultKey extends LockerVaultKeyRecord {
  readonly vaultId: string;
  expiresAt: number;
}

/**
 * The session cache. Module-scoped ON PURPOSE and drained by `lockLocker()`:
 * a per-screen cache would leave one copy alive per mounted screen, and the
 * lock gesture has to be able to reach all of them.
 */
let session: CachedVaultKey | null = null;

function vaultKeyStoreKey(vaultId: string): string {
  return VAULT_KEY_PREFIX + vaultId;
}

/**
 * Store `K` behind `requireAuthentication`, then read it back before claiming
 * success — the same write-then-verify the device credential used, and for
 * the same reason: a keychain that accepted the write but cannot return the
 * item leaves a seat that believes it is enrolled and cannot reveal anything.
 */
export async function storeLockerVaultKey(
  vaultId: string,
  record: LockerVaultKeyRecord
): Promise<void> {
  const blob = JSON.stringify(record);
  await SecureStore.setItemAsync(vaultKeyStoreKey(vaultId), blob, OPTIONS);
  const verified = await SecureStore.getItemAsync(
    vaultKeyStoreKey(vaultId),
    OPTIONS
  );
  if (verified !== blob) {
    await SecureStore.deleteItemAsync(vaultKeyStoreKey(vaultId), OPTIONS).catch(
      () => undefined
    );
    throw new Error("Locker could not store this vault's key on this device.");
  }
}

/**
 * `K` for a reveal. Prompts unless a live session already holds it.
 *
 * The clock is CHECKED here rather than scheduled: a backgrounded React
 * Native app runs no timers, and a session that expires only when a timer
 * fires is a session that does not expire.
 */
export async function readLockerVaultKey(
  vaultId: string,
  now: number = Date.now()
): Promise<LockerVaultKeyRecord | null> {
  if (session && session.vaultId === vaultId && now < session.expiresAt) {
    session.expiresAt = now + LOCKER_SESSION_TIMEOUT_MS;
    return { keyId: session.keyId, key: session.key };
  }
  session = null;
  const blob = await SecureStore.getItemAsync(
    vaultKeyStoreKey(vaultId),
    OPTIONS
  );
  if (!blob) return null;
  const record = JSON.parse(blob) as LockerVaultKeyRecord;
  session = {
    vaultId,
    keyId: record.keyId,
    key: record.key,
    expiresAt: now + LOCKER_SESSION_TIMEOUT_MS,
  };
  return record;
}

/** True while a reveal would NOT prompt. What the lock indicator reads. */
export function lockerUnlocked(now: number = Date.now()): boolean {
  return session !== null && now < session.expiresAt;
}

/**
 * End the session — lock, background, timeout, revoke.
 *
 * Rides `clearSecureCache()` so one gesture drops every decrypted credential
 * the app holds rather than this one and whatever else remembered to listen.
 */
export function lockLocker(): void {
  session = null;
  clearSecureCache();
}

/** Forget `K` on this device entirely. The revoke screen's local half. */
export async function removeLockerVaultKey(vaultId: string): Promise<void> {
  lockLocker();
  await SecureStore.deleteItemAsync(vaultKeyStoreKey(vaultId), OPTIONS).catch(
    () => undefined
  );
}
