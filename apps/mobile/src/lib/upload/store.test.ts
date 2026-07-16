// Queue conformance: enqueue, dedupe, resume, state transitions, and the
// guarantee that the replica store's schema rebuild is not collateral damage.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NodeSqliteFileDriver } from './node-sqlite-driver';
import { UploadQueueStore, type NewUpload } from './store';

let dir: string;
let driver: NodeSqliteFileDriver;
let store: UploadQueueStore;

function upload(overrides: Partial<NewUpload> = {}): NewUpload {
  return {
    itemId: 'item-1',
    sha256: 'a'.repeat(64),
    localUri: 'file://a.jpg',
    plaintextSize: 100,
    sealedSize: 227,
    frameCount: 1,
    partCount: 1,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'centraid-queue-'));
  driver = new NodeSqliteFileDriver(join(dir, 'uploads.db'));
  store = UploadQueueStore.create(driver);
});

afterEach(() => {
  driver.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('UploadQueueStore', () => {
  it('enqueues an item with one row per part', () => {
    const item = store.enqueue(upload({ partCount: 3 }));
    expect(item.state).toBe('pending');
    expect(store.parts(item.itemId).map((part) => part.partNumber)).toEqual([1, 2, 3]);
    expect(store.parts(item.itemId).every((part) => part.state === 'pending')).toBe(true);
  });

  it('dedupes by content sha rather than queueing the same bytes twice', () => {
    const first = store.enqueue(upload());
    const second = store.enqueue(upload({ itemId: 'item-2', localUri: 'file://copy.jpg' }));
    expect(second.itemId).toBe(first.itemId);
    expect(store.pending()).toHaveLength(1);
  });

  it('returns non-terminal items oldest first, and drops terminal ones', () => {
    store.enqueue(upload({ itemId: 'item-1', sha256: 'a'.repeat(64) }));
    store.enqueue(upload({ itemId: 'item-2', sha256: 'b'.repeat(64) }));
    store.enqueue(upload({ itemId: 'item-3', sha256: 'c'.repeat(64) }));
    expect(store.pending().map((item) => item.itemId)).toEqual(['item-1', 'item-2', 'item-3']);

    store.settle('item-1', { casAck: 'replicated' });
    store.fail('item-2', 'nope', true);
    expect(store.pending().map((item) => item.itemId)).toEqual(['item-3']);
    expect(store.isTerminal('item-1')).toBe(true);
    expect(store.isTerminal('item-2')).toBe(true);
    expect(store.isTerminal('item-3')).toBe(false);
  });

  it('walks the item state machine and persists the settlement receipt', () => {
    const item = store.enqueue(upload());
    store.markBegun(item.itemId, 'session-1');
    expect(store.get(item.itemId)?.state).toBe('begun');
    expect(store.get(item.itemId)?.sessionId).toBe('session-1');

    store.setState(item.itemId, 'uploading');
    store.setState(item.itemId, 'completing');
    store.settle(item.itemId, { casAck: 'replicated', custody: 'remote-only' });

    const settled = store.get(item.itemId);
    expect(settled?.state).toBe('settled');
    expect(settled?.receipt).toEqual({ casAck: 'replicated', custody: 'remote-only' });
  });

  it('walks the part state machine', () => {
    const item = store.enqueue(upload({ partCount: 2 }));
    store.markPartPut(item.itemId, 1, '"etag-1"');
    expect(store.parts(item.itemId)[0]).toEqual({
      partNumber: 1,
      state: 'put',
      etag: '"etag-1"',
    });
    store.markPartRecorded(item.itemId, 1, '"etag-1"');
    expect(store.parts(item.itemId)[0]?.state).toBe('recorded');
    // A gateway-reported completedPart may be recorded without a local PUT.
    store.markPartRecorded(item.itemId, 2, '"etag-2"');
    expect(store.parts(item.itemId)[1]).toEqual({
      partNumber: 2,
      state: 'recorded',
      etag: '"etag-2"',
    });
  });

  it('a non-terminal failure returns the item to the queue; a terminal one does not', () => {
    const item = store.enqueue(upload());
    store.fail(item.itemId, 'offline', false);
    expect(store.get(item.itemId)?.state).toBe('pending');
    expect(store.get(item.itemId)?.lastError).toBe('offline');
    expect(store.pending()).toHaveLength(1);

    store.fail(item.itemId, 'refused', true);
    expect(store.pending()).toHaveLength(0);
  });

  it('counts attempts across drains', () => {
    const item = store.enqueue(upload());
    store.countAttempt(item.itemId);
    store.countAttempt(item.itemId);
    expect(store.get(item.itemId)?.attempts).toBe(2);
  });

  it('survives reopen, which is the whole point of the queue', () => {
    const item = store.enqueue(upload({ partCount: 2 }));
    store.markBegun(item.itemId, 'session-9');
    store.markPartPut(item.itemId, 1, '"etag-1"');
    driver.close();

    driver = new NodeSqliteFileDriver(join(dir, 'uploads.db'));
    store = UploadQueueStore.create(driver);
    const recovered = store.pending();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.sessionId).toBe('session-9');
    expect(store.parts(item.itemId)[0]).toEqual({
      partNumber: 1,
      state: 'put',
      etag: '"etag-1"',
    });
  });

  it('never persists a content key or a presigned URL', () => {
    store.enqueue(upload());
    const columns = driver
      .all<{ name: string }>("SELECT name FROM pragma_table_info('upload_item')")
      .concat(driver.all<{ name: string }>("SELECT name FROM pragma_table_info('upload_part')"))
      .map((row) => row.name);
    for (const forbidden of ['key', 'key_base64', 'url', 'upload_url', 'signature']) {
      expect(columns, `queue must not persist ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('leaves foreign tables alone when it rebuilds its own schema', () => {
    // Mirrors the replica store's own guarantee: a schema-version mismatch
    // drops only the tables this module names.
    driver.exec('CREATE TABLE replica_intent_outbox (intent_id TEXT PRIMARY KEY)');
    driver.run("INSERT INTO replica_intent_outbox(intent_id) VALUES ('keep-me')");
    store.enqueue(upload());

    driver.exec('PRAGMA user_version = 99');
    store = UploadQueueStore.create(driver);

    expect(store.pending(), 'own tables rebuild').toHaveLength(0);
    expect(
      driver.all<{ intent_id: string }>('SELECT intent_id FROM replica_intent_outbox'),
      'foreign tables survive',
    ).toEqual([{ intent_id: 'keep-me' }]);
  });
});
