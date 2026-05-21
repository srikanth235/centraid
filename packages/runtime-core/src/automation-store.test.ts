import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { makeActivityDbProvider } from './gateway-db.js';
import { AutomationStore } from './automation-store.js';
import type { AutomationManifest } from './automation-manifest.js';

function newStore(): AutomationStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'centraid-automation-store-'));
  return new AutomationStore(makeActivityDbProvider(path.join(dir, 'activity.sqlite')));
}

const sampleManifest: AutomationManifest = {
  prompt: 'every 30 min, summarize PRs',
  trigger: { kind: 'cron', expr: '*/30 * * * *' },
  requires: { mcps: ['github'], model: 'anthropic/claude-3-5-sonnet' },
  history: { keep: { count: 100 } },
  generated: { by: 'builder', at: '2026-05-19T00:00:00Z' },
};

describe('AutomationStore', () => {
  it('creates and reads back a manifest by UUID', () => {
    const store = newStore();
    const row = store.create('user-1', 'daily-digest', sampleManifest);
    assert.ok(row.id, 'expected a UUID id');
    assert.equal(row.userId, 'user-1');
    assert.equal(row.name, 'daily-digest');
    assert.equal(row.cronExpr, '*/30 * * * *');
    assert.equal(row.enabled, true);
    assert.equal(row.manifest.prompt, sampleManifest.prompt);

    const fetched = store.get(row.id);
    assert.equal(fetched?.manifest.trigger.expr, '*/30 * * * *');
  });

  it('returns undefined for missing rows', () => {
    assert.equal(newStore().get('no-such-id'), undefined);
  });

  it('upsert updates by (userId, name) rather than duplicating, keeping the UUID', () => {
    const store = newStore();
    const first = store.upsert('user-1', 'a', sampleManifest);
    const v2: AutomationManifest = {
      ...sampleManifest,
      trigger: { kind: 'cron', expr: '0 * * * *' },
      prompt: 'changed',
    };
    const updated = store.upsert('user-1', 'a', v2);
    assert.equal(updated.id, first.id, 'upsert keeps the existing UUID');
    assert.equal(updated.cronExpr, '0 * * * *');
    assert.equal(updated.prompt, 'changed');
    assert.equal(store.listByUser('user-1').length, 1);
  });

  it('listByUser / listAll', () => {
    const store = newStore();
    store.create('user-a', 'one', sampleManifest);
    store.create('user-a', 'two', sampleManifest);
    store.create('user-b', 'three', sampleManifest);
    assert.deepEqual(
      store.listByUser('user-a').map((r) => r.name),
      ['one', 'two'],
    );
    assert.equal(store.listAll().length, 3);
  });

  it('setEnabled and remove operate by id', () => {
    const store = newStore();
    const row = store.create('user-a', 'one', sampleManifest);
    store.setEnabled(row.id, false);
    assert.equal(store.get(row.id)?.enabled, false);
    store.remove(row.id);
    assert.equal(store.get(row.id), undefined);
  });

  it('removeByUser clears every row for that user', () => {
    const store = newStore();
    store.create('user-a', 'one', sampleManifest);
    store.create('user-a', 'two', sampleManifest);
    store.create('user-b', 'three', sampleManifest);
    store.removeByUser('user-a');
    assert.deepEqual(store.listByUser('user-a'), []);
    assert.equal(store.listByUser('user-b').length, 1);
  });

  it('rejects invalid automation names', () => {
    const store = newStore();
    assert.throws(
      () => store.create('user-a', 'has/slash', sampleManifest),
      /invalid automation name/,
    );
  });
});
