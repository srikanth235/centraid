/*
 * The KeyStore credential an installed OS service carries (#351,
 * hardened in #568 item E).
 *
 * `service install` moves a data directory's key custody from wherever it
 * currently lives to an OS-held credential — the macOS Keychain or a
 * systemd-creds blob. That move is the single most destructive thing the
 * installer does: a credential the daemon cannot decrypt with makes every key
 * in the directory unreadable, and `security add-generic-password -U`
 * overwrites in place.
 *
 * Two rules follow, and they live here so both platform installers share
 * them:
 *
 *   1. ADOPT BEFORE WRITING. `adoptKeyStoreCredential` proves the credential
 *      reads (and rewraps) every key already in `keysDir`. A failure here must
 *      leave custody exactly as it was found, so the installer commits the
 *      credential only after this returns.
 *   2. The credential is per data directory. `keychainAccountFor` (see
 *      `key-store.ts`) keys the Keychain account by a `keysDir` hash the same
 *      way `headlessCredentialFile` does, so one install cannot clobber
 *      another data directory's custody.
 */

import { promises as fs } from "node:fs";

import { aesGcmKeyProtector, KeyStore } from "@centraid/vault";

export type ServiceKeyCredential =
  | { kind: "systemd"; path: string; encoded: string; keysDir: string }
  | {
      kind: "keychain";
      service: string;
      account: string;
      encoded: string;
      keysDir: string;
    };

/**
 * Prove `credential` can read this data directory's keys, rewrapping any
 * still-unprotected envelope under it on the way through.
 *
 * Throws (via `fail`) when the credential is malformed, and lets the
 * `KeyStore`'s own GCM authentication error escape when it cannot decrypt —
 * both are reasons to abort the install BEFORE anything is committed.
 */
export async function adoptKeyStoreCredential(
  fail: (message: string, code?: number) => never,
  credential: ServiceKeyCredential
): Promise<void> {
  const wrappingKey = Buffer.from(credential.encoded, "base64");
  if (wrappingKey.length !== 32) {
    fail(
      "KeyStore wrapping credential must be one base64-encoded 32-byte key",
      2
    );
  }
  const protectedStore = new KeyStore(credential.keysDir, {
    protector: aesGcmKeyProtector(wrappingKey),
  });
  const entries = await fs
    .readdir(credential.keysDir, { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.includes(".tmp")) continue;
    protectedStore.export(entry.name);
  }
}
