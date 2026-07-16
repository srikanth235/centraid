import type { DatabaseSync } from 'node:sqlite';
import type { LocalBlobStore } from './local.js';
import { remoteEncryptionKey, type RemoteTier } from './custody-types.js';
import { verifyRemoteSealedObject } from './remote-verify.js';
import { assertSha, sha256OfBytes } from './store.js';

/** Authenticated/range-bounded for sealed CAS; full-SHA fallback for plaintext tiers. */
export async function auditRemoteBlob(input: {
  vault: DatabaseSync;
  local: LocalBlobStore;
  remote: RemoteTier | null;
  sha256: string;
  knownSealedSize?: number;
}): Promise<void> {
  const sha = assertSha(input.sha256);
  if (!input.remote) throw new Error('remote CAS is unavailable');
  const stat =
    input.knownSealedSize === undefined
      ? await input.remote.store.stat(sha)
      : { size: input.knownSealedSize };
  if (!stat) throw new Error(`remote CAS is missing ${sha}`);
  const expected =
    input.local.statSync(sha)?.size ??
    (
      input.vault
        .prepare(
          `SELECT byte_size FROM (
           SELECT byte_size FROM core_content_item WHERE sha256 = ? AND deleted_at IS NULL
           UNION ALL SELECT byte_size FROM blob_staging WHERE sha256 = ?
           UNION ALL SELECT byte_size FROM blob_replica WHERE sha256 = ?
         ) LIMIT 1`,
        )
        .get(sha, sha, sha) as { byte_size: number } | undefined
    )?.byte_size;
  const key = remoteEncryptionKey(input.remote, sha);
  if (key) {
    await verifyRemoteSealedObject({
      store: input.remote.store,
      sha256: sha,
      key,
      sealedSize: stat.size,
      ...(expected === undefined ? {} : { expectedPlaintextSize: expected }),
    });
    return;
  }
  const plain = await input.remote.store.get(sha);
  if (
    !plain ||
    sha256OfBytes(plain) !== sha ||
    (expected !== undefined && plain.length !== expected)
  ) {
    throw new Error(`remote CAS plaintext verification failed for ${sha}`);
  }
}
