import { aesGcmKeyProtector, KeyStore, type KeyProtector } from '@centraid/vault';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_LAUNCHD_LABEL,
  DEFAULT_SYSTEMD_UNIT_NAME,
  systemdCredentialPath,
} from './service-unit.js';

const SYSTEMD_CREDENTIAL_ID = 'centraid-keystore';
const MACOS_KEYCHAIN_SERVICE = 'dev.centraid.gateway.keystore';
const warnedFallbacks = new Set<string>();

/**
 * macOS Keychain account for one data directory's keys (issue #568 item E).
 *
 * Keyed by `keysDir` the same way `headlessCredentialFile` is: a single
 * account name shared by every install meant that `service install` for one
 * data dir overwrote (`security add-generic-password -U`) the credential
 * another data dir's keys were wrapped under, and every key in that tree
 * then failed to unwrap.
 */
export function keychainAccountFor(keysDir: string, label = DEFAULT_LAUNCHD_LABEL): string {
  // SHA-256 derives a stable, non-secret keychain account name from the
  // data-directory path — a filesystem identifier, not password storage.
  const id = createHash('sha256').update(path.resolve(keysDir)).digest('hex').slice(0, 16); // lgtm[js/insufficient-password-hash]
  return `${label}.${id}`;
}

function credentialWrappingKey(keysDir: string, env: NodeJS.ProcessEnv): string | undefined {
  const direct = env.CENTRAID_KEYSTORE_MASTER_KEY?.trim();
  if (direct) return direct;
  const credentialsDir = env.CREDENTIALS_DIRECTORY?.trim();
  if (credentialsDir) {
    const file = path.join(credentialsDir, SYSTEMD_CREDENTIAL_ID);
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  }
  if (process.platform === 'linux') {
    const encrypted =
      env.CENTRAID_KEYSTORE_CREDENTIAL_ENCRYPTED?.trim() ||
      systemdCredentialPath(os.homedir(), DEFAULT_SYSTEMD_UNIT_NAME);
    if (existsSync(encrypted)) {
      const result = spawnSync('systemd-creds', ['decrypt', '--user', encrypted, '-'], {
        encoding: 'utf8',
      });
      if (result.status !== 0) {
        throw new Error(
          `could not decrypt KeyStore credential ${encrypted}: ${
            result.stderr?.trim() || `systemd-creds exited ${result.status}`
          }`,
        );
      }
      return result.stdout.trim();
    }
  }
  if (process.platform === 'darwin') {
    const explicit =
      Boolean(env.CENTRAID_KEYSTORE_KEYCHAIN_SERVICE?.trim()) ||
      Boolean(env.CENTRAID_KEYSTORE_KEYCHAIN_ACCOUNT?.trim());
    const service = env.CENTRAID_KEYSTORE_KEYCHAIN_SERVICE?.trim() || MACOS_KEYCHAIN_SERVICE;
    const account = env.CENTRAID_KEYSTORE_KEYCHAIN_ACCOUNT?.trim() || keychainAccountFor(keysDir);
    const result = spawnSync(
      '/usr/bin/security',
      ['find-generic-password', '-w', '-s', service, '-a', account],
      { encoding: 'utf8' },
    );
    if (result.status === 0) return result.stdout.trim();
    if (explicit) {
      throw new Error(
        `could not read KeyStore credential from macOS Keychain (${service}/${account}): ${
          result.stderr?.trim() || `security exited ${result.status}`
        }`,
      );
    }
  }
  return undefined;
}

export function headlessCredentialFile(
  keysDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root =
    env.CENTRAID_KEYSTORE_CREDENTIAL_ROOT?.trim() ||
    (env.VITEST
      ? path.join(os.tmpdir(), 'centraid-vitest-credentials')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'centraid', 'credentials')
        : process.platform === 'win32'
          ? path.join(
              env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming'),
              'Centraid',
              'credentials',
            )
          : path.join(
              env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'),
              'centraid',
              'credentials',
            ));
  // SHA-256 derives a stable, non-secret filename from the data-directory
  // path — a filesystem identifier, not password storage.
  const id = createHash('sha256').update(path.resolve(keysDir)).digest('hex'); // lgtm[js/insufficient-password-hash]
  return path.join(root, `${id}.key`);
}

function loadOrCreateFileCredential(file: string): Buffer {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!existsSync(file)) {
    const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(temp, `${randomBytes(32).toString('base64')}\n`, {
      mode: 0o600,
      flag: 'wx',
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
  // Operate on the file descriptor so the stat/chmod/read all refer to the
  // same open file, avoiding the path-based stat-then-read race.
  const fd = openSync(file, 'r');
  try {
    if ((fstatSync(fd).mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
    const key = Buffer.from(readFileSync(fd, 'utf8').trim(), 'base64');
    if (key.length !== 32) {
      throw new Error(`KeyStore wrapping credential ${file} is not a base64-encoded 32-byte key`);
    }
    return key;
  } finally {
    closeSync(fd);
  }
}

/**
 * The external 0600 host credential `daemonKeyStore` falls back to, base64,
 * creating it when absent (issue #568 item E).
 *
 * `service install` uses this instead of minting `randomBytes(32)`: a
 * headless `serve` has already wrapped every key under this credential, so a
 * fresh random key could not decrypt a single one of them — adoption would
 * throw AFTER the poisoned value had been committed to OS custody. Handing
 * the service the credential the keys are ALREADY wrapped under makes the
 * install idempotent and leaves a readable fallback if OS custody is later
 * cleared.
 */
export function hostCredentialKey(keysDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return loadOrCreateFileCredential(headlessCredentialFile(keysDir, env)).toString('base64');
}

function lazyAesProtector(loadKey: () => Buffer): KeyProtector {
  return {
    scheme: 'aes-256-gcm-v1',
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
  } = {},
): KeyStore {
  const env = options.env ?? process.env;
  const encoded = credentialWrappingKey(keysDir, env);
  const wrappingKey = encoded ? Buffer.from(encoded, 'base64') : undefined;
  if (wrappingKey && wrappingKey.length !== 32) {
    throw new Error('KeyStore wrapping credential must be one base64-encoded 32-byte key');
  }
  const fallbackFile = headlessCredentialFile(keysDir, env);
  const protector = wrappingKey
    ? aesGcmKeyProtector(wrappingKey)
    : lazyAesProtector(() => {
        if (!warnedFallbacks.has(fallbackFile)) {
          warnedFallbacks.add(fallbackFile);
          options.warn?.(
            `OS credential custody is unavailable; using external 0600 host credential ${fallbackFile}`,
          );
        }
        return loadOrCreateFileCredential(fallbackFile);
      });
  return new KeyStore(keysDir, {
    protector,
    ...(options.warn ? { warn: options.warn } : {}),
  });
}
