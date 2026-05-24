/*
 * Persisted secret for the custom OpenAI-compatible provider's API key.
 *
 * Stored encrypted at `<userData>/gateways/<id>/provider-key.bin` via
 * Electron's `safeStorage` (macOS Keychain / DPAPI / libsecret). The
 * plaintext key never reaches the renderer or `identity.sqlite` — the
 * renderer asks main to "set" / "has" / "clear" the key, and main is
 * the only process that ever sees plaintext.
 *
 * Per-gateway (issue #109) so the provider config and its API key live
 * at the same scope. The provider's URL + envKey are already stored
 * per-gateway in `identity.sqlite#agent.runner.provider.*`; storing the
 * key alongside (instead of one global slot) means a user can configure
 * different providers on different gateways — e.g., a local Ollama on
 * the local gateway and a corp-internal endpoint on a remote one — and
 * each gateway's saved key matches its saved provider config.
 *
 * The local-runtime's prefs loader calls `getProviderApiKey(gatewayId)`
 * when building `RunnerPrefs.provider.apiKey`, so the engine plumbing in
 * `@centraid/agent-runtime` keeps its existing in-memory shape — only
 * the *source* of the key changed.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import { gatewayDir } from './gateway-paths.js';

const KEY_FILE_NAME = 'provider-key.bin';

function keyFilePath(gatewayId: string): string {
  return path.join(gatewayDir(gatewayId), KEY_FILE_NAME);
}

/**
 * `safeStorage` requires `app.whenReady()` and the OS keychain backend
 * to be available. On Linux without `libsecret`/gnome-keyring, encryption
 * falls back to plaintext (Electron logs a warning). We check up front
 * so the IPC handler can return a clear error instead of silently
 * persisting plaintext to disk.
 */
function ensureEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS keychain is not available — install gnome-keyring/libsecret on Linux, or run from a signed app bundle on macOS.',
    );
  }
}

export async function setProviderApiKey(gatewayId: string, plaintext: string): Promise<void> {
  ensureEncryptionAvailable();
  const file = keyFilePath(gatewayId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (!plaintext) {
    await clearProviderApiKey(gatewayId);
    return;
  }
  const encrypted = safeStorage.encryptString(plaintext);
  await fs.writeFile(file, encrypted, { mode: 0o600 });
}

export async function getProviderApiKey(gatewayId: string): Promise<string | undefined> {
  try {
    const encrypted = await fs.readFile(keyFilePath(gatewayId));
    if (encrypted.length === 0) return undefined;
    ensureEncryptionAvailable();
    return safeStorage.decryptString(encrypted);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    // Decryption failure (e.g. the OS keychain rotated) shouldn't crash
    // the agent — treat it as "no key" so the next turn surfaces the
    // 401 from the provider naturally.
    return undefined;
  }
}

export async function hasProviderApiKey(gatewayId: string): Promise<boolean> {
  try {
    const stat = await fs.stat(keyFilePath(gatewayId));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export async function clearProviderApiKey(gatewayId: string): Promise<void> {
  await fs.rm(keyFilePath(gatewayId), { force: true });
}
