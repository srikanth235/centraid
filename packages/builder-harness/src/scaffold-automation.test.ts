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
    const info = await scaffoldAutomationProject(dir, 'daily-digest', {
      name: 'Daily digest',
      prompt: 'Summarize my PRs',
      cronExpr: '0 8 * * *',
      apps: ['todos'],
    });
    assert.equal(info.id, 'daily-digest');
    assert.equal(info.name, 'Daily digest');

    const appJson = JSON.parse(
      await fs.readFile(path.join(dir, 'daily-digest', 'app.json'), 'utf8'),
    ) as { name: string };
    assert.equal(appJson.name, 'Daily digest');

    const autoDir = path.join(dir, 'daily-digest', 'automations', 'daily-digest');
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
    await scaffoldAutomationProject(dir, 'autox');
    const autoDir = path.join(dir, 'autox', 'automations', 'autox');
    const manifest = parseManifest(
      await fs.readFile(path.join(autoDir, 'automation.json'), 'utf8'),
    );
    assert.equal(manifest.name, 'autox');
    assert.deepEqual(manifest.triggers, [{ kind: 'cron', expr: '0 9 * * *' }]);
  });

  it('honors an explicit automationId', async () => {
    await scaffoldAutomationProject(dir, 'bot', { automationId: 'job' });
    const autoDir = path.join(dir, 'bot', 'automations', 'job');
    assert.ok((await fs.stat(autoDir)).isDirectory());
  });

  it('rejects a duplicate app folder', async () => {
    await scaffoldAutomationProject(dir, 'dup');
    await assert.rejects(() => scaffoldAutomationProject(dir, 'dup'), HarnessError);
  });

  it('rejects a dotted / path-unsafe app id', async () => {
    await assert.rejects(() => scaffoldAutomationProject(dir, 'auto.x'), HarnessError);
  });

  it('validates ids', () => {
    assert.throws(() => validateAutomationId('has space'), HarnessError);
    assert.throws(() => validateAutomationId('_leading'), HarnessError);
    // Automation apps use a plain slug id now (kind marks them, not a
    // dotted prefix) — a dotted id is rejected, a slug accepted.
    assert.throws(() => validateAutomationAppId('auto.ok'), HarnessError);
    validateAutomationAppId('standup-bot');
  });
});
