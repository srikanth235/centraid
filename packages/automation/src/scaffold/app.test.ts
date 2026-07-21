import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { list, readAppOwned, readAppAt } from './app.js';
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
    appsDir = await tempDir('centraid-apps-');
  });
  afterEach(async () => {
    await fs.rm(appsDir, { recursive: true, force: true });
  });

  it('list returns an empty result for a missing directory', async () => {
    const res = await list(path.join(appsDir, 'nope'));
    expect(res).toEqual({ rows: [], errors: [] });
  });

  it('reads an app and hoists the scheduler fields + handle', async () => {
    const dir = await writeAutomation(
      appsDir,
      'auto.digest',
      'digest',
      manifest({ name: 'Morning digest' }),
    );
    const row = await readAppAt(dir, 'auto.digest');
    expect(row).toBeTruthy();
    expect(row!.id).toBe('digest');
    expect(row!.ownerApp).toBe('auto.digest');
    expect(row!.ref).toBe('auto.digest/digest');
    expect(row!.name).toBe('Morning digest');
    expect(row!.triggers).toEqual([{ kind: 'cron', expr: '0 9 * * *' }]);
    expect(row!.enabled).toBe(true);
  });

  it('readAppOwned resolves by (appId, automationId)', async () => {
    await writeAutomation(appsDir, 'auto.digest', 'digest', manifest());
    const row = await readAppOwned(appsDir, 'auto.digest', 'digest');
    expect(row?.ref).toBe('auto.digest/digest');
    expect(await readAppOwned(appsDir, 'auto.digest', 'ghost')).toBe(undefined);
  });

  it('lists automations across app folders sorted by name, reports invalid ones', async () => {
    await writeAutomation(appsDir, 'auto.zebra', 'z', manifest({ name: 'Zebra' }));
    await writeAutomation(appsDir, 'ui-app', 'a', manifest({ name: 'Alpha' }));
    const badDir = path.join(appsDir, 'ui-app', 'automations', 'broken');
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, 'automation.json'), '{not json');
    const res = await list(appsDir);
    expect(res.rows.map((r) => r.name)).toEqual(['Alpha', 'Zebra']);
    expect(res.rows.map((r) => r.ref)).toEqual(['ui-app/a', 'auto.zebra/z']);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0]!.id).toBe('ui-app/broken');
  });
});
