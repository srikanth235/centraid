// The self-contained export/backup gesture (issue #296 §6: the exit ramp from
// S3 is a plain directory). Split out of custody.ts so the facade stays under
// the governance line-cap (issue #405 §3 note). The local tier is the spool AND
// cache — under the bounded storage tier (#405) it is no longer guaranteed
// complete, so this copies whatever bytes ARE resident; a caller wanting a full
// export first runs a sweep with a budget high enough to hold the whole vault.

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { asVaultDiskFullError } from '../errors.js';
import type { LocalBlobStore } from './local.js';

/** Copy every resident local blob into `destDir/blobs`. Returns how many. */
export function exportLocalTier(local: LocalBlobStore, destDir: string): { copied: number } {
  const destRoot = path.join(destDir, 'blobs');
  let copied = 0;
  for (const sha of local.listSync()) {
    const bytes = local.getSync(sha);
    if (!bytes) continue;
    const file = path.join(destRoot, 'sha256', sha.slice(0, 2), sha);
    if (!existsSync(file)) {
      writeBlobFile(file, bytes);
      copied += 1;
    }
  }
  return { copied };
}

/** Write-then-rename so a crashed export never leaves a half blob. */
function writeBlobFile(file: string, bytes: Buffer): void {
  const tmp = `${file}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    // Same rule as the CAS write path (blob/local.ts): a disk-full export
    // never leaves a partial `.tmp` file next to the real blob path.
    rmSync(tmp, { force: true });
    throw asVaultDiskFullError('blob export write', err);
  }
}
