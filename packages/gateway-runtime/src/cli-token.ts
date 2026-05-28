/*
 * Persistent shared-bearer token for the daemon.
 *
 * Minted on first boot, persisted at `<dataDir>/token.bin` with mode
 * `0o600`. The daemon prints it on startup and exposes a
 * `centraid-gateway print-token` subcommand so the user can paste the
 * URL + token into the desktop's "Add remote gateway" form.
 *
 * v0 model: one shared token per daemon. Per-device tokens with a
 * revocation list are listed as out-of-scope on the parent issue.
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
