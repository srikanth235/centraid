import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { aesGcmKeyProtector, KeyStore } from "@centraid/vault";
import type { KeyProtector } from "@centraid/vault";

import {
  DEFAULT_LAUNCHD_LABEL,
  DEFAULT_SYSTEMD_UNIT_NAME,
  systemdCredentialPath,
} from "./service-unit.js";

const SYSTEMD_CREDENTIAL_ID = "centraid-keystore";
const MACOS_KEYCHAIN_SERVICE = "dev.centraid.gateway.keystore";
const warnedFallbacks = new Set<string>();

/**
 * macOS Keychain account for one data directory's keys (#568).
 *
 * Keyed by `keysDir` the same way `headlessCredentialFile` is: one account
 * name shared by every install would let `service install` for one data dir
 * overwrite (`security add-generic-password -U`) the credential another data
 * dir's keys are wrapped under, leaving every key in that tree unable to
 * unwrap.
 */
export function keychainAccountFor(
  keysDir: string,
  label = DEFAULT_LAUNCHD_LABEL
): string {
  const id = createHash("sha256")
    .update(path.resolve(keysDir))
    .digest("hex")
    .slice(0, 16);
  return `${label}.${id}`;
}

function credentialWrappingKey(
  keysDir: string,
  env: NodeJS.ProcessEnv
): string | undefined {
  const direct = env.CENTRAID_KEYSTORE_MASTER_KEY?.trim();
  if (direct) return direct;
  const credentialsDir = env.CREDENTIALS_DIRECTORY?.trim();
  if (credentialsDir) {
    const file = path.join(credentialsDir, SYSTEMD_CREDENTIAL_ID);
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
  }
  if (process.platform === "linux") {
    const encrypted =
      env.CENTRAID_KEYSTORE_CREDENTIAL_ENCRYPTED?.trim() ||
      systemdCredentialPath(os.homedir(), DEFAULT_SYSTEMD_UNIT_NAME);
    if (existsSync(encrypted)) {
      const result = spawnSync(
        "systemd-creds",
        ["decrypt", "--user", encrypted, "-"],
        {
          encoding: "utf8",
        }
      );
      if (result.status !== 0) {
        throw new Error(
          `could not decrypt KeyStore credential ${encrypted}: ${
            result.stderr?.trim() || `systemd-creds exited ${result.status}`
          }`
        );
      }
      return result.stdout.trim();
    }
  }
  if (process.platform === "darwin") {
    const service =
      env.CENTRAID_KEYSTORE_KEYCHAIN_SERVICE?.trim() || MACOS_KEYCHAIN_SERVICE;
    const account =
      env.CENTRAID_KEYSTORE_KEYCHAIN_ACCOUNT?.trim() ||
      keychainAccountFor(keysDir);
    return readKeychainCredential(service, account, (args) =>
      spawnSync("/usr/bin/security", args, { encoding: "utf8" })
    );
  }
  return undefined;
}

/** `security` exits 44 for "the item is not in the keychain" and nothing else. */
const KEYCHAIN_ITEM_NOT_FOUND = 44;

export interface KeychainProbeResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
}

/**
 * Read one keychain entry, telling ABSENT from UNREADABLE (#1014, X15).
 *
 * A locked keychain, a denied ACL prompt, or a `security` that could not be
 * spawned all exit non-zero without `itemNotFound`. Treating those as "no
 * credential" sent the caller down the external-0600-credential fallback,
 * which MINTS a fresh credential when none is on disk — so a transient
 * custody failure silently produced a wrapping key that cannot unwrap a
 * single existing key, and the gateway came up as if custody had never been
 * configured. Absence is the only answer that may fall through.
 */
export function readKeychainCredential(
  service: string,
  account: string,
  run: (args: string[]) => KeychainProbeResult
): string | undefined {
  const result = run([
    "find-generic-password",
    "-w",
    "-s",
    service,
    "-a",
    account,
  ]);
  if (result.status === 0) return result.stdout?.trim() ?? "";
  if (result.status === KEYCHAIN_ITEM_NOT_FOUND) return undefined;
  throw new Error(
    `could not read KeyStore credential from macOS Keychain (${service}/${account}): ${
      result.stderr?.trim() || `security exited ${result.status}`
    }`
  );
}

export function headlessCredentialFile(
  keysDir: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const root =
    env.CENTRAID_KEYSTORE_CREDENTIAL_ROOT?.trim() ||
    (env.VITEST
      ? path.join(os.tmpdir(), "centraid-vitest-credentials")
      : process.platform === "darwin"
        ? path.join(
            os.homedir(),
            "Library",
            "Application Support",
            "centraid",
            "credentials"
          )
        : process.platform === "win32"
          ? path.join(
              env.APPDATA?.trim() ||
                path.join(os.homedir(), "AppData", "Roaming"),
              "Centraid",
              "credentials"
            )
          : path.join(
              env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config"),
              "centraid",
              "credentials"
            ));
  const id = createHash("sha256").update(path.resolve(keysDir)).digest("hex");
  return path.join(root, `${id}.key`);
}

function loadOrCreateFileCredential(file: string): Buffer {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!existsSync(file)) {
    const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temp, `${randomBytes(32).toString("base64")}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    try {
      renameSync(temp, file);
    } catch (error) {
      if (existsSync(file)) {
        try {
          unlinkSync(temp);
        } catch {
          // The winning credential remains authoritative.
        }
      } else {
        throw error;
      }
    }
  }
  if ((statSync(file).mode & 0o777) !== 0o600) chmodSync(file, 0o600);
  const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  if (key.length !== 32) {
    throw new Error(
      `KeyStore wrapping credential ${file} is not a base64-encoded 32-byte key`
    );
  }
  return key;
}

/**
 * The external 0600 host credential `daemonKeyStore` falls back to, base64,
 * creating it when absent (#568).
 *
 * `service install` uses this instead of minting `randomBytes(32)`: a
 * headless `serve` has already wrapped every key under this credential, so a
 * fresh random key could not decrypt a single one of them — adoption would
 * throw AFTER the poisoned value had been committed to OS custody. Handing
 * the service the credential the keys are ALREADY wrapped under makes the
 * install idempotent and leaves a readable fallback if OS custody is later
 * cleared.
 */
export function hostCredentialKey(
  keysDir: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return loadOrCreateFileCredential(
    headlessCredentialFile(keysDir, env)
  ).toString("base64");
}

function lazyAesProtector(loadKey: () => Buffer): KeyProtector {
  return {
    scheme: "aes-256-gcm-v1",
    protect: (secret) => aesGcmKeyProtector(loadKey()).protect(secret),
    unprotect: (payload) => aesGcmKeyProtector(loadKey()).unprotect(payload),
  };
}

/** Build the daemon KeyStore from OS custody or an external 0600 host credential. */
export function daemonKeyStore(
  keysDir: string,
  options: {
    env?: NodeJS.ProcessEnv;
    warn?: (message: string) => void;
  } = {}
): KeyStore {
  const env = options.env ?? process.env;
  const encoded = credentialWrappingKey(keysDir, env);
  const wrappingKey = encoded ? Buffer.from(encoded, "base64") : undefined;
  if (wrappingKey && wrappingKey.length !== 32) {
    throw new Error(
      "KeyStore wrapping credential must be one base64-encoded 32-byte key"
    );
  }
  const fallbackFile = headlessCredentialFile(keysDir, env);
  const protector = wrappingKey
    ? aesGcmKeyProtector(wrappingKey)
    : lazyAesProtector(() => {
        if (!warnedFallbacks.has(fallbackFile)) {
          warnedFallbacks.add(fallbackFile);
          options.warn?.(
            `OS credential custody is unavailable; using external 0600 host credential ${fallbackFile}`
          );
        }
        return loadOrCreateFileCredential(fallbackFile);
      });
  return new KeyStore(keysDir, {
    protector,
    ...(options.warn ? { warn: options.warn } : {}),
  });
}
