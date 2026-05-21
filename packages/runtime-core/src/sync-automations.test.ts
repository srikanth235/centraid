import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { makeActivityDbProvider } from './gateway-db.js';
import { AutomationStore } from './automation-store.js';
import { syncAutomationsFromDisk } from './sync-automations.js';
import type { AutomationManifest } from './automation-manifest.js';

function setup(): {
  automationsDir: string;
  store: AutomationStore;
  writeManifest: (name: string, manifest: AutomationManifest) => Promise<void>;
  writeRaw: (name: string, text: string) => Promise<void>;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'centraid-sync-auto-'));
  const automationsDir = path.join(root, 'automations');
  const store = new AutomationStore(makeActivityDbProvider(path.join(root, 'activity.sqlite')));
  return {
    automationsDir,
    store,
    writeManifest: async (name, manifest) => {
      await fs.mkdir(automationsDir, { recursive: true });
      await fs.writeFile(
        path.join(automationsDir, `${name}.json`),
        JSON.stringify(manifest, null, 2),
      );
    },
    writeRaw: async (name, text) => {
      await fs.mkdir(automationsDir, { recursive: true });
      await fs.writeFile(path.join(automationsDir, `${name}.json`), text);
    },
  };
}

const baseManifest: AutomationManifest = {
  prompt: 'weekly recap',
  trigger: { kind: 'cron', expr: '0 20 * * 0' },
  requires: { model: 'anthropic/claude-3-5-sonnet' },
  history: { keep: { count: 100 } },
  generated: { by: 'builder', at: '2026-05-19T00:00:00Z' },
};

describe('syncAutomationsFromDisk', () => {
  it('returns an empty diff when the automations dir is missing', async () => {
    const { automationsDir, store } = setup();
    const r = await syncAutomationsFromDisk({ userId: 'u1', automationsDir, store });
    assert.deepEqual(r, { added: [], updated: [], removed: [], unchanged: [], errors: [] });
  });

  it('adds new manifests as enabled', async () => {
    const ctx = setup();
    await ctx.writeManifest('weekly-recap', baseManifest);
    const r = await syncAutomationsFromDisk({
      userId: 'u1',
      automationsDir: ctx.automationsDir,
      store: ctx.store,
    });
    assert.deepEqual(r.added, ['weekly-recap']);
    assert.deepEqual(r.updated, []);
    assert.deepEqual(r.removed, []);
    const row = ctx.store.getByName('u1', 'weekly-recap');
    assert.equal(row?.enabled, true);
  });

  it('preserves the enabled flag and the UUID across re-sync', async () => {
    const ctx = setup();
    await ctx.writeManifest('weekly-recap', baseManifest);
    await syncAutomationsFromDisk({
      userId: 'u1',
      automationsDir: ctx.automationsDir,
      store: ctx.store,
    });
    const first = ctx.store.getByName('u1', 'weekly-recap');
    assert.ok(first);
    // User toggles off — the row's `enabled` column is the source of truth.
    ctx.store.setEnabled(first.id, false);

    // Change the schedule on disk to force an update.
    await ctx.writeManifest('weekly-recap', {
      ...baseManifest,
      trigger: { kind: 'cron', expr: '0 21 * * 0' },
    });
    const r = await syncAutomationsFromDisk({
      userId: 'u1',
      automationsDir: ctx.automationsDir,
      store: ctx.store,
    });
    assert.deepEqual(r.updated, ['weekly-recap']);
    const row = ctx.store.getByName('u1', 'weekly-recap');
    assert.equal(row?.id, first.id, 'UUID survives resync');
    assert.equal(row?.enabled, false, 'enabled toggle must survive resync');
    assert.equal(row?.cronExpr, '0 21 * * 0');
  });

  it('removes rows whose on-disk manifest disappeared', async () => {
    const ctx = setup();
    await ctx.writeManifest('one', baseManifest);
    await ctx.writeManifest('two', baseManifest);
    await syncAutomationsFromDisk({
      userId: 'u1',
      automationsDir: ctx.automationsDir,
      store: ctx.store,
    });
    await fs.rm(path.join(ctx.automationsDir, 'two.json'));
    const r = await syncAutomationsFromDisk({
      userId: 'u1',
      automationsDir: ctx.automationsDir,
      store: ctx.store,
    });
    assert.deepEqual(r.removed, ['two']);
    assert.deepEqual(
      ctx.store.listByUser('u1').map((row) => row.name),
      ['one'],
    );
  });

  it('reports unchanged manifests separately from updated', async () => {
    const ctx = setup();
    await ctx.writeManifest('one', baseManifest);
    await syncAutomationsFromDisk({
      userId: 'u1',
      automationsDir: ctx.automationsDir,
      store: ctx.store,
    });
    const r = await syncAutomationsFromDisk({
      userId: 'u1',
      automationsDir: ctx.automationsDir,
      store: ctx.store,
    });
    assert.deepEqual(r.unchanged, ['one']);
    assert.deepEqual(r.added, []);
    assert.deepEqual(r.updated, []);
  });

  it('captures invalid manifests as errors without stopping other syncs', async () => {
    const ctx = setup();
    await ctx.writeManifest('good', baseManifest);
    await ctx.writeRaw('bad', '{ not valid json');
    const r = await syncAutomationsFromDisk({
      userId: 'u1',
      automationsDir: ctx.automationsDir,
      store: ctx.store,
    });
    assert.deepEqual(r.added, ['good']);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0]?.file, 'bad.json');
    assert.equal(r.errors[0]?.code, 'invalid_json');
  });

  it('rejects manifests that point the agent turn at the mock provider', async () => {
    const ctx = setup();
    await ctx.writeManifest('recurse', {
      ...baseManifest,
      requires: { model: 'centraid-mock/foo' },
    });
    const r = await syncAutomationsFromDisk({
      userId: 'u1',
      automationsDir: ctx.automationsDir,
      store: ctx.store,
    });
    assert.deepEqual(r.added, []);
    assert.equal(r.errors[0]?.code, 'mock_model_disallowed');
  });
});
