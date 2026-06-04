import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteAt, list, readAppOwned, readAppAt, setEnabledAt } from './app.js';
import type { Manifest } from '../manifest/manifest.js';

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    name: 'Digest',
    version: '0.1.0',
    enabled: true,
    prompt: 'do the thing',
    triggers: [{ kind: 'cron', expr: '0 9 * * *' }],
    requires: {},
    history: { keep: { count: 100 } },
    generated: { by: 'test', at: '2026-05-22' },
    ...over,
  };
}

/** Write a flat (draft-layout) automation at `<appsDir>/<appId>/automations/<id>/`. */
async function writeAutomation(
  appsDir: string,
  appId: string,
  id: string,
  m: Manifest,
  handler = 'export default async () => ({});',
): Promise<string> {
  const dir = path.join(appsDir, appId, 'automations', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'automation.json'), JSON.stringify(m, null, 2));
  await fs.writeFile(path.join(dir, 'handler.js'), handler);
  return dir;
}

describe('automation-app', () => {
  let appsDir: string;

  beforeEach(async () => {
    appsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-apps-'));
  });
  afterEach(async () => {
    await fs.rm(appsDir, { recursive: true, force: true });
  });

  it('list returns an empty result for a missing directory', async () => {
    const res = await list(path.join(appsDir, 'nope'));
    assert.deepEqual(res, { rows: [], errors: [] });
  });

  it('reads an app and hoists the scheduler fields + handle', async () => {
    const dir = await writeAutomation(
      appsDir,
      'auto.digest',
      'digest',
      manifest({ name: 'Morning digest' }),
    );
    const row = await readAppAt(dir, 'auto.digest');
    assert.ok(row);
    assert.equal(row.id, 'digest');
    assert.equal(row.ownerApp, 'auto.digest');
    assert.equal(row.ref, 'auto.digest/digest');
    assert.equal(row.name, 'Morning digest');
    assert.deepEqual(row.triggers, [{ kind: 'cron', expr: '0 9 * * *' }]);
    assert.equal(row.enabled, true);
  });

  it('readAppOwned resolves by (appId, automationId)', async () => {
    await writeAutomation(appsDir, 'auto.digest', 'digest', manifest());
    const row = await readAppOwned(appsDir, 'auto.digest', 'digest');
    assert.equal(row?.ref, 'auto.digest/digest');
    assert.equal(await readAppOwned(appsDir, 'auto.digest', 'ghost'), undefined);
  });

  it('lists automations across app folders sorted by name, reports invalid ones', async () => {
    await writeAutomation(appsDir, 'auto.zebra', 'z', manifest({ name: 'Zebra' }));
    await writeAutomation(appsDir, 'ui-app', 'a', manifest({ name: 'Alpha' }));
    const badDir = path.join(appsDir, 'ui-app', 'automations', 'broken');
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, 'automation.json'), '{not json');
    const res = await list(appsDir);
    assert.deepEqual(
      res.rows.map((r) => r.name),
      ['Alpha', 'Zebra'],
    );
    assert.deepEqual(
      res.rows.map((r) => r.ref),
      ['ui-app/a', 'auto.zebra/z'],
    );
    assert.equal(res.errors.length, 1);
    assert.equal(res.errors[0]!.id, 'ui-app/broken');
  });

  it('setEnabledAt rewrites the manifest in place', async () => {
    const dir = await writeAutomation(
      appsDir,
      'auto.digest',
      'digest',
      manifest({ enabled: true }),
    );
    const updated = await setEnabledAt(dir, 'auto.digest', false);
    assert.equal(updated?.enabled, false);
    const reread = await readAppAt(dir, 'auto.digest');
    assert.equal(reread?.enabled, false);
  });

  it('deleteAt removes the directory and is idempotent', async () => {
    const dir = await writeAutomation(appsDir, 'auto.digest', 'digest', manifest());
    await deleteAt(dir);
    assert.equal(await readAppAt(dir, 'auto.digest'), undefined);
    await deleteAt(dir);
  });
});
