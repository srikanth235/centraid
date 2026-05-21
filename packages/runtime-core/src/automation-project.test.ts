import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deleteAutomationProject,
  listAutomationProjects,
  readAutomationProject,
  setAutomationEnabled,
} from './automation-project.js';
import type { AutomationManifest } from './automation-manifest.js';

function manifest(over: Partial<AutomationManifest> = {}): AutomationManifest {
  return {
    name: 'Digest',
    version: '0.1.0',
    enabled: true,
    prompt: 'do the thing',
    trigger: { kind: 'cron', expr: '0 9 * * *' },
    requires: {},
    history: { keep: { count: 100 } },
    generated: { by: 'test', at: '2026-05-22' },
    ...over,
  };
}

async function writeProject(
  dir: string,
  id: string,
  m: AutomationManifest,
  handler = 'export default async () => ({});',
): Promise<void> {
  const projDir = path.join(dir, id);
  await fs.mkdir(projDir, { recursive: true });
  await fs.writeFile(path.join(projDir, 'automation.json'), JSON.stringify(m, null, 2));
  await fs.writeFile(path.join(projDir, 'handler.js'), handler);
}

describe('automation-project', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-autos-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('listAutomationProjects returns an empty result for a missing directory', async () => {
    const res = await listAutomationProjects(path.join(dir, 'nope'));
    assert.deepEqual(res, { rows: [], errors: [] });
  });

  it('reads a project and hoists the scheduler fields', async () => {
    await writeProject(dir, 'digest', manifest({ name: 'Morning digest' }));
    const row = await readAutomationProject(dir, 'digest');
    assert.ok(row);
    assert.equal(row.id, 'digest');
    assert.equal(row.name, 'Morning digest');
    assert.equal(row.cronExpr, '0 9 * * *');
    assert.equal(row.enabled, true);
  });

  it('returns undefined for a non-existent project', async () => {
    assert.equal(await readAutomationProject(dir, 'ghost'), undefined);
  });

  it('lists valid projects sorted by name and reports invalid ones', async () => {
    await writeProject(dir, 'b-auto', manifest({ name: 'Zebra' }));
    await writeProject(dir, 'a-auto', manifest({ name: 'Alpha' }));
    const badDir = path.join(dir, 'broken');
    await fs.mkdir(badDir);
    await fs.writeFile(path.join(badDir, 'automation.json'), '{not json');
    const res = await listAutomationProjects(dir);
    assert.deepEqual(
      res.rows.map((r) => r.name),
      ['Alpha', 'Zebra'],
    );
    assert.equal(res.errors.length, 1);
    assert.equal(res.errors[0]!.id, 'broken');
  });

  it('setAutomationEnabled rewrites the manifest in place', async () => {
    await writeProject(dir, 'digest', manifest({ enabled: true }));
    const updated = await setAutomationEnabled(dir, 'digest', false);
    assert.equal(updated?.enabled, false);
    const reread = await readAutomationProject(dir, 'digest');
    assert.equal(reread?.enabled, false);
  });

  it('deleteAutomationProject removes the directory and is idempotent', async () => {
    await writeProject(dir, 'digest', manifest());
    await deleteAutomationProject(dir, 'digest');
    assert.equal(await readAutomationProject(dir, 'digest'), undefined);
    await deleteAutomationProject(dir, 'digest');
  });
});
