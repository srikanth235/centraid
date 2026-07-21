// Per-gateway bearer-token storage.
//
// Issue #109. Remote-gateway tokens never live in a JSON file on disk.
// Each gateway gets its own encrypted blob at
// `<userData>/gateways/<id>/token.bin`, written via Electron's
// `safeStorage` (Keychain on macOS, DPAPI on Windows, libsecret on
// Linux). Removing a gateway wipes its directory, which takes the
// token with it.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import { gatewayDir } from './gateway-paths.js';

const TOKEN_FILE_NAME = 'token.bin';

function tokenFilePath(gatewayId: string): string {
  return path.join(gatewayDir(gatewayId), TOKEN_FILE_NAME);
}

function ensureEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS keychain is not available — install gnome-keyring/libsecret on Linux, or run from a signed app bundle on macOS.',
    );
  }
}

/**
 * Persist a gateway's bearer token. Empty string deletes the entry.
 * The caller is responsible for ensuring the gateway dir already
 * exists (typically the addGateway path mkdir's it before this call).
 */
export async function setGatewayToken(gatewayId: string, plaintext: string): Promise<void> {
  const file = tokenFilePath(gatewayId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (!plaintext) {
    await clearGatewayToken(gatewayId);
    return;
  }
  ensureEncryptionAvailable();
  const encrypted = safeStorage.encryptString(plaintext);
  await fs.writeFile(file, encrypted, { mode: 0o600 });
}

/**
 * Read a gateway's bearer token. Returns undefined when the entry
 * doesn't exist or the OS keychain rotated and the blob can no longer
 * be decrypted — callers treat both as "no token" and let the next
 * HTTP request surface a 401 naturally.
 */
export async function getGatewayToken(gatewayId: string): Promise<string | undefined> {
  try {
    const encrypted = await fs.readFile(tokenFilePath(gatewayId));
    if (encrypted.length === 0) return undefined;
    ensureEncryptionAvailable();
    return safeStorage.decryptString(encrypted);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    return undefined;
  }
}

export async function clearGatewayToken(gatewayId: string): Promise<void> {
  await fs.rm(tokenFilePath(gatewayId), { force: true });
}
