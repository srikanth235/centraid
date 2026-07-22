import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface AuthOptions {
  token?: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve a bearer for product CLI calls.
 * Precedence: --token > CENTRAID_TOKEN > <dataDir>/token.bin.
 */
export async function resolveToken(opts: AuthOptions): Promise<string | undefined> {
  if (opts.token && opts.token.trim() !== '') return opts.token.trim();
  const env = opts.env ?? process.env;
  const fromEnv = env.CENTRAID_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const dataDir = opts.dataDir?.trim() || env.CENTRAID_DATA_DIR?.trim();
  if (!dataDir) return undefined;
  try {
    const raw = await fs.readFile(path.join(dataDir, 'token.bin'), 'utf8');
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
