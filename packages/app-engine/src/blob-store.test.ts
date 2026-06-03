import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.equal(first.hash, hashBytes(bytes));
    assert.equal(first.sizeBytes, bytes.byteLength);
    assert.equal(first.deduped, false);
    const second = await store.put('app', bytes);
    assert.equal(second.hash, first.hash);
    assert.equal(second.deduped, true, 'identical bytes write once');
  });

  it('round-trips bytes through read; missing hash → undefined', async () => {
    const store = new BlobStore(freshAppsDir());
    const { hash } = await store.put('app', Buffer.from('data'));
    assert.deepEqual(await store.read('app', hash), Buffer.from('data'));
    assert.equal(await store.read('app', 'f'.repeat(64)), undefined);
  });

  it('rejects a non-sha256 hash (path-traversal guard)', () => {
    const store = new BlobStore(freshAppsDir());
    assert.throws(() => store.pathFor('app', '../escape'), /invalid hash/i);
  });

  it('gc removes blobs not in the referenced set, keeps referenced ones', async () => {
    const dir = freshAppsDir();
    const store = new BlobStore(dir);
    const keep = await store.put('app', Buffer.from('keep'));
    const drop = await store.put('app', Buffer.from('drop'));
    assert.equal(existsSync(store.pathFor('app', drop.hash)), true);

    const { removed } = await store.gc('app', new Set([keep.hash]));
    assert.equal(removed, 1);
    assert.equal(existsSync(store.pathFor('app', keep.hash)), true);
    assert.equal(existsSync(store.pathFor('app', drop.hash)), false);
    assert.deepEqual(readdirSync(join(dir, 'app', 'blobs')), [keep.hash]);
  });

  it('gc on an app with no blobs dir is a no-op', async () => {
    const store = new BlobStore(freshAppsDir());
    assert.deepEqual(await store.gc('app', new Set()), { removed: 0 });
  });

  it('blobUrl builds the chat-history download path', () => {
    assert.equal(
      blobUrl('app', 'a'.repeat(64)),
      `/_centraid-chat/apps/app/blobs/${'a'.repeat(64)}`,
    );
  });
});
