import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { writeAppSetting, automationEnabledKey } from './app-settings.js';
import { makeAutomationDbProvider } from './gateway-db.js';
import { AutomationStore } from './automation-store.js';
import { syncAutomationsFromDisk } from './sync-automations.js';
import type { AutomationManifest } from './automation-manifest.js';

function setup(): {
  appDir: string;
  dataDbFile: string;
  store: AutomationStore;
  writeManifest: (name: string, manifest: AutomationManifest) => Promise<void>;
  writeRaw: (name: string, text: string) => Promise<void>;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'centraid-sync-auto-'));
  const appDir = path.join(root, 'app');
  const dataDbFile = path.join(root, 'data.sqlite');
  const store = new AutomationStore(makeAutomationDbProvider(path.join(root, 'gateway.sqlite')));
  return {
    appDir,
    dataDbFile,
    store,
    writeManifest: async (name, manifest) => {
      await fs.mkdir(path.join(appDir, 'automations'), { recursive: true });
      await fs.writeFile(
        path.join(appDir, 'automations', `${name}.json`),
        JSON.stringify(manifest, null, 2),
      );
    },
    writeRaw: async (name, text) => {
      await fs.mkdir(path.join(appDir, 'automations'), { recursive: true });
      await fs.writeFile(path.join(appDir, 'automations', `${name}.json`), text);
    },
  };
}

const baseManifest: AutomationManifest = {
  prompt: 'weekly recap',
  trigger: { kind: 'cron', expr: '0 20 * * 0' },
  action: 'weekly-recap.js',
  requires: { model: 'anthropic/claude-3-5-sonnet' },
  history: { keep: { count: 100 } },
  generated: { by: 'builder', at: '2026-05-19T00:00:00Z' },
};

describe('syncAutomationsFromDisk', () => {
  it('returns an empty diff when the automations dir is missing', async () => {
    const { appDir, store } = setup();
    const r = await syncAutomationsFromDisk({ appId: 'todos', appCodeDir: appDir, store });
    assert.deepEqual(r, { added: [], updated: [], removed: [], unchanged: [], errors: [] });
  });

  it('adds new manifests as enabled', async () => {
    const ctx = setup();
    await ctx.writeManifest('weekly-recap', baseManifest);
    const r = await syncAutomationsFromDisk({
      appId: 'journal',
      appCodeDir: ctx.appDir,
      store: ctx.store,
    });
    assert.deepEqual(r.added, ['weekly-recap']);
    assert.deepEqual(r.updated, []);
    assert.deepEqual(r.removed, []);
    const row = ctx.store.get('journal', 'weekly-recap');
    assert.equal(row?.enabled, true);
    assert.equal(row?.manifest.action, 'weekly-recap.js');
  });

  it('preserves the enabled flag across re-sync (reads from __centraid_settings)', async () => {
    const ctx = setup();
    await ctx.writeManifest('weekly-recap', baseManifest);
    await syncAutomationsFromDisk({
      appId: 'journal',
      appCodeDir: ctx.appDir,
      store: ctx.store,
      dataDbFile: ctx.dataDbFile,
    });
    // User toggles off via the new source of truth (per-app settings).
    writeAppSetting(ctx.dataDbFile, automationEnabledKey('weekly-recap'), false);

    // Change the schedule on disk to force an update.
    await ctx.writeManifest('weekly-recap', {
      ...baseManifest,
      trigger: { kind: 'cron', expr: '0 21 * * 0' },
    });
    const r = await syncAutomationsFromDisk({
      appId: 'journal',
      appCodeDir: ctx.appDir,
      store: ctx.store,
      dataDbFile: ctx.dataDbFile,
    });
    assert.deepEqual(r.updated, ['weekly-recap']);
    const row = ctx.store.get('journal', 'weekly-recap');
    assert.equal(row?.enabled, false, 'enabled toggle must survive resync');
    assert.equal(row?.cronExpr, '0 21 * * 0');
  });

  it('defaults enabled=true when dataDbFile is omitted (clone-time, no DB yet)', async () => {
    const ctx = setup();
    await ctx.writeManifest('weekly-recap', baseManifest);
    await syncAutomationsFromDisk({
      appId: 'journal',
      appCodeDir: ctx.appDir,
      store: ctx.store,
      // no dataDbFile — fresh clone before publish
    });
    assert.equal(ctx.store.get('journal', 'weekly-recap')?.enabled, true);
  });

  it('removes rows whose on-disk manifest disappeared', async () => {
    const ctx = setup();
    await ctx.writeManifest('one', baseManifest);
    await ctx.writeManifest('two', baseManifest);
    await syncAutomationsFromDisk({
      appId: 'a',
      appCodeDir: ctx.appDir,
      store: ctx.store,
    });
    await fs.rm(path.join(ctx.appDir, 'automations', 'two.json'));
    const r = await syncAutomationsFromDisk({
      appId: 'a',
      appCodeDir: ctx.appDir,
      store: ctx.store,
    });
    assert.deepEqual(r.removed, ['two']);
    assert.deepEqual(
      ctx.store.listByApp('a').map((row) => row.name),
      ['one'],
    );
  });

  it('reports unchanged manifests separately from updated', async () => {
    const ctx = setup();
    await ctx.writeManifest('one', baseManifest);
    await syncAutomationsFromDisk({
      appId: 'a',
      appCodeDir: ctx.appDir,
      store: ctx.store,
    });
    const r = await syncAutomationsFromDisk({
      appId: 'a',
      appCodeDir: ctx.appDir,
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
      appId: 'a',
      appCodeDir: ctx.appDir,
      store: ctx.store,
    });
    assert.deepEqual(r.added, ['good']);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0]?.file, 'bad.json');
    assert.equal(r.errors[0]?.code, 'invalid_json');
  });

  it('rejects manifests that point ctx.agent at the mock provider', async () => {
    const ctx = setup();
    await ctx.writeManifest('recurse', {
      ...baseManifest,
      requires: { model: 'centraid-mock/foo' },
    });
    const r = await syncAutomationsFromDisk({
      appId: 'a',
      appCodeDir: ctx.appDir,
      store: ctx.store,
    });
    assert.deepEqual(r.added, []);
    assert.equal(r.errors[0]?.code, 'mock_model_disallowed');
  });
});
