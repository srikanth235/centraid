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
  return new AutomationStore(makeActivityDbProvider(path.join(dir, 'gateway.sqlite')));
}

const sampleManifest: AutomationManifest = {
  prompt: 'every 30 min, summarize PRs',
  trigger: { kind: 'cron', expr: '*/30 * * * *' },
  action: 'summarize-prs.js',
  requires: { mcps: ['github'], model: 'anthropic/claude-3-5-sonnet' },
  history: { keep: { count: 100 } },
  generated: { by: 'builder', at: '2026-05-19T00:00:00Z' },
};

describe('AutomationStore', () => {
  it('upserts and reads back a manifest', () => {
    const store = newStore();
    const row = store.upsert('todos', 'daily-digest', sampleManifest);
    assert.equal(row.originAppId, 'todos');
    assert.equal(row.name, 'daily-digest');
    assert.equal(row.cronExpr, '*/30 * * * *');
    assert.equal(row.enabled, true);
    assert.equal(row.manifest.prompt, sampleManifest.prompt);

    const fetched = store.get('todos', 'daily-digest');
    assert.equal(fetched?.manifest.trigger.expr, '*/30 * * * *');
  });

  it('returns undefined for missing rows', () => {
    assert.equal(newStore().get('nope', 'nope'), undefined);
  });

  it('upsert updates rather than duplicates', () => {
    const store = newStore();
    store.upsert('todos', 'a', sampleManifest);
    const v2: AutomationManifest = {
      ...sampleManifest,
      trigger: { kind: 'cron', expr: '0 * * * *' },
      prompt: 'changed',
    };
    const updated = store.upsert('todos', 'a', v2);
    assert.equal(updated.cronExpr, '0 * * * *');
    assert.equal(updated.prompt, 'changed');
    assert.equal(store.listByApp('todos').length, 1);
  });

  it('listByApp / listAll', () => {
    const store = newStore();
    store.upsert('a', 'one', sampleManifest);
    store.upsert('a', 'two', sampleManifest);
    store.upsert('b', 'three', sampleManifest);
    assert.deepEqual(
      store.listByApp('a').map((r) => r.name),
      ['one', 'two'],
    );
    assert.equal(store.listAll().length, 3);
  });

  it('setEnabled and remove', () => {
    const store = newStore();
    store.upsert('a', 'one', sampleManifest);
    store.setEnabled('a', 'one', false);
    assert.equal(store.get('a', 'one')?.enabled, false);
    store.remove('a', 'one');
    assert.equal(store.get('a', 'one'), undefined);
  });

  it('removeByApp clears every row for that app', () => {
    const store = newStore();
    store.upsert('a', 'one', sampleManifest);
    store.upsert('a', 'two', sampleManifest);
    store.upsert('b', 'three', sampleManifest);
    store.removeByApp('a');
    assert.deepEqual(store.listByApp('a'), []);
    assert.equal(store.listByApp('b').length, 1);
  });

  it('rejects invalid automation names', () => {
    const store = newStore();
    assert.throws(() => store.upsert('a', 'has/slash', sampleManifest), /invalid automation name/);
  });
});
