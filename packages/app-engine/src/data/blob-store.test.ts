import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore, hashBytes, blobUrl } from './blob-store.js';

function freshAppsDir(appId = 'app'): string {
  const dir = mkdtempSync(join(tmpdir(), 'centraid-blobs-'));
  mkdirSync(join(dir, appId), { recursive: true });
  return dir;
}

describe('BlobStore', () => {
  it('content-addresses bytes and dedups a second identical put', async () => {
    const store = new BlobStore(freshAppsDir());
    const bytes = Buffer.from('hello world');
    const first = await store.put('app', bytes);
    expect(first.hash).toBe(hashBytes(bytes));
    expect(first.sizeBytes).toBe(bytes.byteLength);
    expect(first.deduped).toBe(false);
    const second = await store.put('app', bytes);
    expect(second.hash).toBe(first.hash);
    expect(second.deduped).toBe(true);
  });

  it('round-trips bytes through read; missing hash → undefined', async () => {
    const store = new BlobStore(freshAppsDir());
    const { hash } = await store.put('app', Buffer.from('data'));
    expect(await store.read('app', hash)).toEqual(Buffer.from('data'));
    expect(await store.read('app', 'f'.repeat(64))).toBe(undefined);
  });

  it('rejects a non-sha256 hash (path-traversal guard)', () => {
    const store = new BlobStore(freshAppsDir());
    expect(() => store.pathFor('app', '../escape')).toThrow(/invalid hash/i);
  });

  it('gc removes blobs not in the referenced set, keeps referenced ones', async () => {
    const dir = freshAppsDir();
    const store = new BlobStore(dir);
    const keep = await store.put('app', Buffer.from('keep'));
    const drop = await store.put('app', Buffer.from('drop'));
    expect(existsSync(store.pathFor('app', drop.hash))).toBe(true);

    const { removed } = await store.gc('app', new Set([keep.hash]));
    expect(removed).toBe(1);
    expect(existsSync(store.pathFor('app', keep.hash))).toBe(true);
    expect(existsSync(store.pathFor('app', drop.hash))).toBe(false);
    expect(readdirSync(join(dir, 'app', 'blobs'))).toEqual([keep.hash]);
  });

  it('gc on an app with no blobs dir is a no-op', async () => {
    const store = new BlobStore(freshAppsDir());
    expect(await store.gc('app', new Set())).toEqual({ removed: 0 });
  });

  it('blobUrl builds the chat-history download path', () => {
    expect(blobUrl('app', 'a'.repeat(64))).toBe(
      `/_centraid-conversations/apps/app/blobs/${'a'.repeat(64)}`,
    );
  });
});
