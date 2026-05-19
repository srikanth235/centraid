/*
 * Persisted secret for the custom OpenAI-compatible provider's API key.
 *
 * Stored encrypted at `<userData>/local-runtime/provider-key.bin` via
 * Electron's `safeStorage` (macOS Keychain / DPAPI / libsecret depending
 * on platform). The plaintext key never reaches the renderer or
 * `user_prefs.sqlite` — the renderer asks main to "set" / "has" / "clear"
 * the key, and main is the only process that ever sees plaintext.
 *
 * The local-runtime's prefs loader calls `getProviderApiKey()` when
 * building `RunnerPrefs.provider.apiKey`, so the engine plumbing in
 * `@centraid/agent-runtime` keeps its existing in-memory shape — only
 * the *source* of the key changed.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';

const KEY_FILE_NAME = 'provider-key.bin';

function keyFilePath(): string {
  return path.join(app.getPath('userData'), 'local-runtime', KEY_FILE_NAME);
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

export async function setProviderApiKey(plaintext: string): Promise<void> {
  ensureEncryptionAvailable();
  const file = keyFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (!plaintext) {
    await clearProviderApiKey();
    return;
  }
  const encrypted = safeStorage.encryptString(plaintext);
  await fs.writeFile(file, encrypted, { mode: 0o600 });
}

export async function getProviderApiKey(): Promise<string | undefined> {
  try {
    const encrypted = await fs.readFile(keyFilePath());
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

export async function hasProviderApiKey(): Promise<boolean> {
  try {
    const stat = await fs.stat(keyFilePath());
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export async function clearProviderApiKey(): Promise<void> {
  await fs.rm(keyFilePath(), { force: true });
}
