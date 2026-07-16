// Enqueue: addressing bytes and the structural maths the gateway is told at
// `begin`. Sizes here are exact, not approximate — `sealedSize` is a promise
// the client makes before uploading and `verifyRemoteSealedObject` checks it.

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FRAME_BYTES } from './cbsf';
import { enqueueLocalFile, sha256OfFile, type StreamingDigest } from './enqueue';
import { bytesFileSource } from './file-source';
import { NodeSqliteFileDriver } from './node-sqlite-driver';
import { UploadQueueStore } from './store';

let dir: string;
let driver: NodeSqliteFileDriver;
let store: UploadQueueStore;

const BYTES = new Uint8Array(5_000).map((_, index) => (index * 13) & 0xff);
const openFile = async () => bytesFileSource(BYTES);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'centraid-enqueue-'));
  driver = new NodeSqliteFileDriver(join(dir, 'uploads.db'));
  store = UploadQueueStore.create(driver);
});

afterEach(() => {
  driver.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('enqueue', () => {
  it('addresses the file by a streamed sha that matches node:crypto', async () => {
    const { sha256, size } = await sha256OfFile(openFile, 'file://x');
    expect(size).toBe(BYTES.byteLength);
    expect(sha256).toBe(createHash('sha256').update(BYTES).digest('hex'));
  });

  it('persists the sha and the structural plan', async () => {
    const item = await enqueueLocalFile(
      { store, openFile, newId: () => 'item-1' },
      {
        localUri: 'file://x',
        plaintextSize: BYTES.byteLength,
        mediaType: 'image/jpeg',
        filename: 'x.jpg',
      },
    );
    expect(item.sha256).toBe(createHash('sha256').update(BYTES).digest('hex'));
    expect(item.state).toBe('pending');
    expect(item.frameCount).toBe(1);
    expect(item.partCount).toBe(1);
    // header 37 + (nonce 12 + algo 1 + 5000 + tag 16) + directory 48 + trailer 13
    expect(item.sealedSize).toBe(BYTES.byteLength + 94 + 33);
    expect(item.mediaType).toBe('image/jpeg');
  });

  it('refuses a file whose size does not match the caller', async () => {
    await expect(
      enqueueLocalFile(
        { store, openFile, newId: () => 'item-1' },
        { localUri: 'file://x', plaintextSize: 4 },
      ),
    ).rejects.toThrow(/caller declared 4/);
    expect(store.pending()).toHaveLength(0);
  });

  it('hashes in bounded windows rather than slurping the file', async () => {
    const reads: number[] = [];
    const bigOpen = async () => {
      const source = bytesFileSource(new Uint8Array(FRAME_BYTES * 2 + 10));
      return {
        ...source,
        read: async (offset: number, length: number) => {
          reads.push(length);
          return source.read(offset, length);
        },
      };
    };
    await sha256OfFile(bigOpen, 'file://big');
    // Never a single read of the whole file; every window is capped at 4 MiB.
    expect(Math.max(...reads)).toBeLessThanOrEqual(FRAME_BYTES);
    expect(reads).toEqual([FRAME_BYTES, FRAME_BYTES, 10]);
  });

  it('accepts an injected native digest, which is how a device escapes the pure-JS hash', async () => {
    const nodeDigest = (): StreamingDigest => {
      const hash = createHash('sha256');
      return { update: (bytes) => hash.update(bytes), digestHex: () => hash.digest('hex') };
    };
    const createDigest = vi.fn(nodeDigest);
    const item = await enqueueLocalFile(
      { store, openFile, newId: () => 'item-1', createDigest },
      { localUri: 'file://x', plaintextSize: BYTES.byteLength },
    );
    expect(createDigest).toHaveBeenCalled();
    expect(item.sha256).toBe(createHash('sha256').update(BYTES).digest('hex'));
  });
});
