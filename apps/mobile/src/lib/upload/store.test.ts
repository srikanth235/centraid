import { tempDirSync } from '@centraid/test-kit/temp-dir';
// Queue conformance: enqueue, dedupe, resume, state transitions, and the
// guarantee that the replica store's schema rebuild is not collateral damage.

import { rmSync } from 'node:fs';
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
  dir = tempDirSync('centraid-queue-');
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

  it('persists canonical follow-ups until their bytes settle and replay completes', () => {
    const item = store.enqueue(upload());
    const first = store.enqueueFollowup({
      itemId: item.itemId,
      shape: 'photos',
      action: 'upload',
      input: { staged_sha: item.sha256, kind: 'photo' },
      derivatives: [{ variant: 'thumb', uri: 'file://thumb.jpg', mediaType: 'image/jpeg' }],
    });
    const duplicate = store.enqueueFollowup({
      itemId: item.itemId,
      shape: 'photos',
      action: 'upload',
      input: { staged_sha: item.sha256, kind: 'photo' },
    });
    store.enqueueFollowup({
      itemId: item.itemId,
      shape: 'docs',
      action: 'upload',
      input: { staged_sha: item.sha256, title: 'Same bytes, separate document' },
    });

    expect(duplicate.followupId).toBe(first.followupId);
    expect(duplicate.intentId).toBe(first.intentId);
    expect(store.pendingFollowups()).toHaveLength(0);
    store.settle(item.itemId, { casAck: 'replicated' });
    driver.close();

    driver = new NodeSqliteFileDriver(join(dir, 'uploads.db'));
    store = UploadQueueStore.create(driver);
    expect(store.pendingFollowups()).toMatchObject([
      {
        followupId: first.followupId,
        intentId: first.intentId,
        shape: 'photos',
        derivatives: [{ variant: 'thumb', uri: 'file://thumb.jpg' }],
      },
      { shape: 'docs' },
    ]);
    store.clearFollowup(first.followupId);
    expect(store.pendingFollowups().map((followup) => followup.shape)).toEqual(['docs']);
  });

  it('migrates the v1 byte ledger in place', () => {
    const item = store.enqueue(upload());
    driver.exec('DROP TABLE upload_followup');
    driver.exec('PRAGMA user_version = 1');

    store = UploadQueueStore.create(driver);

    expect(store.get(item.itemId)?.sha256).toBe(item.sha256);
    expect(
      store.enqueueFollowup({
        itemId: item.itemId,
        shape: 'docs',
        action: 'upload',
        input: { staged_sha: item.sha256 },
      }).shape,
    ).toBe('docs');
  });

  // The historical v2 follow-up table: no intent_id, no attempts/poison columns.
  const V2_FOLLOWUP_DDL = `
    CREATE TABLE upload_followup (
      followup_id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      shape TEXT NOT NULL,
      action TEXT NOT NULL,
      input_json TEXT NOT NULL,
      derivatives_json TEXT,
      FOREIGN KEY (item_id) REFERENCES upload_item(item_id) ON DELETE CASCADE,
      UNIQUE (item_id, shape, action, input_json)
    );
  `;

  function reopenAsV2(item: { itemId: string; sha256: string }): void {
    driver.exec('DROP TABLE upload_followup');
    driver.exec(V2_FOLLOWUP_DDL);
    driver.run(
      `INSERT INTO upload_followup(item_id, shape, action, input_json)
       VALUES (?, 'docs', 'upload', ?)`,
      [item.itemId, JSON.stringify({ staged_sha: item.sha256 })],
    );
    driver.exec('PRAGMA user_version = 2');
  }

  it('migrates a v2 follow-up ledger to the current schema in place', () => {
    const item = store.enqueue(upload());
    reopenAsV2(item);

    store = UploadQueueStore.create(driver);

    store.settle(item.itemId, { casAck: 'replicated' });
    const followups = store.pendingFollowups();
    expect(followups).toHaveLength(1);
    expect(followups[0]?.intentId, 'intent_id was backfilled').toMatch(/^upload-followup-/);
    expect(followups[0]?.attempts, 'attempts column added at v4').toBe(0);
  });

  it('survives a kill between the v2→v3 ALTER and its version bump (idempotent)', () => {
    const item = store.enqueue(upload());
    reopenAsV2(item);
    // The ALTER landed but the process died before `user_version` moved to 3.
    driver.exec('ALTER TABLE upload_followup ADD COLUMN intent_id TEXT');

    expect(() => {
      store = UploadQueueStore.create(driver);
    }, 'reopen must not throw "duplicate column name"').not.toThrow();
    store.settle(item.itemId, { casAck: 'replicated' });
    expect(store.pendingFollowups()[0]?.intentId).toMatch(/^upload-followup-/);
  });

  it('survives a kill between the v3→v4 ALTER and its version bump (idempotent)', () => {
    const item = store.enqueue(upload());
    reopenAsV2(item);
    // Walk to a clean v3 first, then simulate a half-applied v3→v4.
    driver.exec('ALTER TABLE upload_followup ADD COLUMN intent_id TEXT');
    driver.exec('ALTER TABLE upload_followup ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    driver.exec('PRAGMA user_version = 3');

    expect(() => {
      store = UploadQueueStore.create(driver);
    }, 'reopen must not throw on the already-added attempts column').not.toThrow();
    store.settle(item.itemId, { casAck: 'replicated' });
    expect(store.pendingFollowups()[0]?.attempts).toBe(0);
  });

  it('revives a terminally-failed item on re-enqueue rather than returning it stuck (F6)', () => {
    const item = store.enqueue(upload());
    store.countAttempt(item.itemId);
    store.fail(item.itemId, 'refused', true);
    expect(store.get(item.itemId)?.state).toBe('failed');

    const revived = store.enqueue(upload({ itemId: 'item-2', localUri: 'file://again.jpg' }));
    expect(revived.itemId, 'same sha, same row').toBe(item.itemId);
    expect(revived.state, 'reset to pending').toBe('pending');
    expect(revived.attempts, 'attempts cleared for a fresh run').toBe(0);
    expect(revived.lastError).toBeUndefined();
    expect(store.pending()).toHaveLength(1);
  });

  it('quarantines a follow-up and hides it from replay without blocking the rest (F4)', () => {
    const item = store.enqueue(upload());
    const bad = store.enqueueFollowup({
      itemId: item.itemId,
      shape: 'photos',
      action: 'upload',
      input: { staged_sha: item.sha256, kind: 'photo' },
    });
    store.enqueueFollowup({
      itemId: item.itemId,
      shape: 'docs',
      action: 'upload',
      input: { staged_sha: item.sha256, title: 'still fine' },
    });
    store.settle(item.itemId, { casAck: 'replicated' });

    expect(store.countFollowupAttempt(bad.followupId)).toBe(1);
    expect(store.countFollowupAttempt(bad.followupId)).toBe(2);
    store.poisonFollowup(bad.followupId, 'unreplayable payload');

    expect(store.poisonedFollowupCount()).toBe(1);
    expect(
      store.pendingFollowups().map((followup) => followup.shape),
      'the poisoned photos follow-up is gone; docs still replays',
    ).toEqual(['docs']);
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
