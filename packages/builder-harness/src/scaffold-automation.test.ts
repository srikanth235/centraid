import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseManifest } from '@centraid/runtime-core';
import {
  scaffoldAutomationProject,
  validateAutomationId,
  validateAutomationAppId,
} from './scaffold-automation.js';
import { HarnessError } from './types.js';

describe('scaffoldAutomationProject', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-autoscaffold-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes app.json + automations/<id>/{automation.json,handler.js}', async () => {
    const info = await scaffoldAutomationProject(dir, 'auto.daily-digest', {
      name: 'Daily digest',
      prompt: 'Summarize my PRs',
      cronExpr: '0 8 * * *',
      apps: ['todos'],
    });
    assert.equal(info.id, 'auto.daily-digest');
    assert.equal(info.name, 'Daily digest');

    const appJson = JSON.parse(
      await fs.readFile(path.join(dir, 'auto.daily-digest', 'app.json'), 'utf8'),
    ) as { name: string };
    assert.equal(appJson.name, 'Daily digest');

    const autoDir = path.join(dir, 'auto.daily-digest', 'automations', 'daily-digest');
    const manifest = parseManifest(
      await fs.readFile(path.join(autoDir, 'automation.json'), 'utf8'),
    );
    assert.equal(manifest.name, 'Daily digest');
    assert.equal(manifest.prompt, 'Summarize my PRs');
    assert.deepEqual(manifest.triggers, [{ kind: 'cron', expr: '0 8 * * *' }]);
    assert.deepEqual(manifest.apps, ['todos']);
    assert.equal(manifest.enabled, true);

    const handler = await fs.readFile(path.join(autoDir, 'handler.js'), 'utf8');
    assert.match(handler, /export default async/);
  });

  it('derives the automation id from the app id, defaults a daily schedule', async () => {
    await scaffoldAutomationProject(dir, 'auto.autox');
    const autoDir = path.join(dir, 'auto.autox', 'automations', 'autox');
    const manifest = parseManifest(
      await fs.readFile(path.join(autoDir, 'automation.json'), 'utf8'),
    );
    assert.equal(manifest.name, 'auto.autox');
    assert.deepEqual(manifest.triggers, [{ kind: 'cron', expr: '0 9 * * *' }]);
  });

  it('honors an explicit automationId', async () => {
    await scaffoldAutomationProject(dir, 'auto.bot', { automationId: 'job' });
    const autoDir = path.join(dir, 'auto.bot', 'automations', 'job');
    assert.ok((await fs.stat(autoDir)).isDirectory());
  });

  it('rejects a duplicate app folder', async () => {
    await scaffoldAutomationProject(dir, 'auto.dup');
    await assert.rejects(() => scaffoldAutomationProject(dir, 'auto.dup'), HarnessError);
  });

  it('rejects an app id without the auto. prefix', async () => {
    await assert.rejects(() => scaffoldAutomationProject(dir, 'plain-app'), HarnessError);
  });

  it('validates ids', () => {
    assert.throws(() => validateAutomationId('has space'), HarnessError);
    assert.throws(() => validateAutomationId('_leading'), HarnessError);
    assert.throws(() => validateAutomationAppId('no-prefix'), HarnessError);
    validateAutomationAppId('auto.ok');
  });
});
