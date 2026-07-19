import { describe, expect, test, vi } from 'vitest';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { BlobCustody } from './custody.js';
import { FsBlobStore, MemoryBlobStore } from './local.js';
import { sha256OfBytes, type BlobRange } from './store.js';

async function collect(source: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('remote-only blob streaming', () => {
  test('bounds each provider read while preserving the complete content address', async () => {
    const root = await tempDir('centraid-remote-stream-');
    const bytes = Buffer.alloc(9 * 1024 * 1024 + 31, 0x5a);
    const sha = sha256OfBytes(bytes);
    const remote = new MemoryBlobStore();
    await remote.put(sha, bytes);
    const reads: BlobRange[] = [];
    const get = remote.get.bind(remote);
    vi.spyOn(remote, 'get').mockImplementation((key, range) => {
      if (range) reads.push(range);
      return get(key, range);
    });
    const local = new FsBlobStore(root);
    const custody = new BlobCustody(local, () => ({ store: remote }));

    const stream = custody.openRemoteReadStream(sha, bytes.length);

    expect(stream).not.toBeNull();
    const streamed = await collect(stream!);
    expect(streamed.length).toBe(bytes.length);
    expect(sha256OfBytes(streamed)).toBe(sha);
    expect(reads).toHaveLength(3);
    expect(reads.every(({ start, end }) => end! - start + 1 <= 4 * 1024 * 1024)).toBe(true);
    expect(local.statSync(sha)?.size).toBe(bytes.length);
    expect(sha256OfBytes(local.getSync(sha)!)).toBe(sha);
  });

  test('rejects a corrupt full read after bounded delivery', async () => {
    const bytes = Buffer.alloc(5 * 1024 * 1024, 0x2a);
    const claimedSha = sha256OfBytes(Buffer.from('different'));
    const remote = new MemoryBlobStore();
    await remote.put(claimedSha, bytes);
    const custody = new BlobCustody(new MemoryBlobStore(), () => ({ store: remote }));

    const stream = custody.openRemoteReadStream(claimedSha, bytes.length);

    await expect(collect(stream!)).rejects.toThrow('failed content verification');
  });

  test('fetches only the requested remote range', async () => {
    const bytes = Buffer.from('0123456789abcdef');
    const sha = sha256OfBytes(bytes);
    const remote = new MemoryBlobStore();
    await remote.put(sha, bytes);
    const get = vi.spyOn(remote, 'get');
    const custody = new BlobCustody(new MemoryBlobStore(), () => ({ store: remote }));

    const stream = custody.openRemoteReadStream(sha, bytes.length, { start: 3, end: 7 });

    await expect(collect(stream!)).resolves.toEqual(Buffer.from('34567'));
    expect(get).toHaveBeenCalledWith(sha, { start: 3, end: 7 });
  });
});
