/*
 * Persistent shared-bearer token for the daemon.
 *
 * Minted on first boot, persisted at `<dataDir>/token.bin` with mode
 * `0o600`. The daemon prints it on startup and exposes a
 * `centraid-gateway print-token` subcommand so the user can paste the
 * URL + token into the desktop's "Add remote gateway" form.
 *
 * This token is the ADMIN/landlord plane: any holder can address every
 * vault on the daemon — never treat it as per-tenant auth. The TENANT
 * plane is per-device HTTP tokens (issue #376, `serve/device-token-
 * store.ts`), minted by `POST /centraid/_gateway/pair` or the iroh
 * pairing ceremony and confined to their device's enrollments by
 * `build-gateway.ts`'s `composedHandler`; the shared token here plays no
 * part in that check.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TOKEN_BYTES = 32;

export async function readOrMintToken(tokenFile: string): Promise<string> {
  try {
    const buf = await fs.readFile(tokenFile, 'utf8');
    const trimmed = buf.trim();
    if (trimmed.length > 0) return trimmed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  await fs.mkdir(path.dirname(tokenFile), { recursive: true });
  await fs.writeFile(tokenFile, token, { mode: 0o600 });
  return token;
}

export async function readPersistedToken(tokenFile: string): Promise<string | undefined> {
  try {
    const buf = await fs.readFile(tokenFile, 'utf8');
    const trimmed = buf.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
