/*
 * Filesystem-backed `SecretsProvider` for the standalone daemon.
 *
 * v0 stores the OpenAI-compatible provider API key as plaintext at
 * `<dataDir>/provider-key.bin` with mode `0o600`. The daemon logs a
 * one-line warning on startup so the gap vs. the Electron embed's
 * `safeStorage`-backed reader is honest.
 *
 * A future revision can swap in an OS keychain integration (or a
 * passphrase-derived envelope cipher) without changing this module's
 * `SecretsProvider` shape.
 */

import { promises as fs } from 'node:fs';
import type { SecretsProvider } from './secrets.js';

export function makeFileSecretsProvider(providerKeyFile: string): SecretsProvider {
  return {
    async getProviderApiKey(): Promise<string | undefined> {
      try {
        const buf = await fs.readFile(providerKeyFile, 'utf8');
        const trimmed = buf.trim();
        return trimmed.length > 0 ? trimmed : undefined;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        return undefined;
      }
    },
  };
}

/**
 * Persist a provider API key to disk at mode `0o600`. Called from the
 * config-seed path when a `provider` block with an `apiKey` field is
 * supplied in the daemon's JSON config.
 */
export async function writeProviderApiKey(providerKeyFile: string, key: string): Promise<void> {
  await fs.writeFile(providerKeyFile, key, { mode: 0o600 });
}
