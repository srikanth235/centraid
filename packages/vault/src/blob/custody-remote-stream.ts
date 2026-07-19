import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import type { BlobCache } from './cache.js';
import { fetchFrameDirectory, fetchRemoteRange } from './custody-read.js';
import { remoteEncryptionKey, type RemoteTier } from './custody-types.js';
import type { LocalBlobStore } from './local.js';
import { resolveRange, type BlobRange, type BlobStore } from './store.js';

const REMOTE_STREAM_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Stream a remote-only blob without a whole-object Buffer. Full reads verify
 * the content address before completion; ranged framed reads retain per-frame
 * AEAD integrity. Each provider read is capped so aborts retain at most one
 * bounded chunk while Readable.from supplies response backpressure.
 */
export function createRemoteBlobStream(
  remote: RemoteTier,
  store: BlobStore,
  sha: string,
  size: number,
  range?: BlobRange,
  cache?: BlobCache,
  local?: LocalBlobStore,
): Readable | null {
  const resolved = resolveRange(size, range);
  if (!resolved) return null;
  const { start: firstByte, end: lastByte } = resolved;
  const fullRead = firstByte === 0 && lastByte === size - 1;
  const key = remoteEncryptionKey(remote, sha);

  async function* chunks(): AsyncGenerator<Buffer> {
    cache?.enterInteractive();
    let tempPath: string | undefined;
    let tempFile: fs.FileHandle | undefined;
    try {
      if (fullRead && !local?.hasSync(sha) && local?.promotionTempPathSync && local.adoptTempSync) {
        tempPath = local.promotionTempPathSync(sha);
        tempFile = await fs.open(tempPath, 'wx', 0o600);
      }
      const directory = key ? await fetchFrameDirectory(store, key, sha) : undefined;
      if (key && !directory) throw new Error(`remote blob ${sha} disappeared`);
      const digest = fullRead ? createHash('sha256') : undefined;
      for (let start = firstByte; start <= lastByte; start += REMOTE_STREAM_CHUNK_BYTES) {
        const end = Math.min(lastByte, start + REMOTE_STREAM_CHUNK_BYTES - 1);
        const bytes = key
          ? await fetchRemoteRange(store, key, sha, { start, end }, directory!)
          : await store.get(sha, { start, end });
        if (!bytes) throw new Error(`remote blob ${sha} disappeared`);
        if (bytes.length !== end - start + 1) {
          throw new Error(`remote blob ${sha} returned a short range`);
        }
        digest?.update(bytes);
        if (tempFile) {
          let written = 0;
          while (written < bytes.length) {
            written += (await tempFile.write(bytes, written)).bytesWritten;
          }
        }
        if (!fullRead) cache?.onRangedRemote(bytes.length);
        yield bytes;
      }
      if (digest && digest.digest('hex') !== sha) {
        throw new Error(`remote blob ${sha} failed content verification`);
      }
      if (tempFile && tempPath && local?.adoptTempSync) {
        await tempFile.sync();
        await tempFile.close();
        tempFile = undefined;
        const adopted = local.adoptTempSync(sha, tempPath);
        tempPath = undefined;
        if (adopted) cache?.onPut(size);
      }
      if (fullRead) {
        cache?.onReadThrough(size);
        cache?.access.touch(sha, size);
      }
    } finally {
      await tempFile?.close().catch(() => undefined);
      if (tempPath) await fs.rm(tempPath, { force: true });
      cache?.exitInteractive();
    }
  }

  return Readable.from(chunks());
}
