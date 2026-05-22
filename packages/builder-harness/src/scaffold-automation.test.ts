import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseManifest } from '@centraid/runtime-core';
import { scaffoldAutomationProject, validateAutomationId } from './scaffold-automation.js';
import { HarnessError } from './types.js';

describe('scaffoldAutomationProject', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-autoscaffold-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes a valid automation.json + handler.js + versions dir', async () => {
    const info = await scaffoldAutomationProject(dir, 'daily-digest', {
      name: 'Daily digest',
      prompt: 'Summarize my PRs',
      cronExpr: '0 8 * * *',
      apps: ['todos'],
    });
    assert.equal(info.id, 'daily-digest');
    assert.equal(info.name, 'Daily digest');

    const manifest = parseManifest(
      await fs.readFile(path.join(dir, 'daily-digest', 'automation.json'), 'utf8'),
    );
    assert.equal(manifest.name, 'Daily digest');
    assert.equal(manifest.prompt, 'Summarize my PRs');
    assert.deepEqual(manifest.triggers, [{ kind: 'cron', expr: '0 8 * * *' }]);
    assert.deepEqual(manifest.apps, ['todos']);
    assert.equal(manifest.enabled, true);

    const handler = await fs.readFile(path.join(dir, 'daily-digest', 'handler.js'), 'utf8');
    assert.match(handler, /export default async/);
    const stat = await fs.stat(path.join(dir, 'daily-digest', 'versions'));
    assert.ok(stat.isDirectory());
  });

  it('defaults to a daily schedule and an id-derived name', async () => {
    await scaffoldAutomationProject(dir, 'autox');
    const manifest = parseManifest(
      await fs.readFile(path.join(dir, 'autox', 'automation.json'), 'utf8'),
    );
    assert.equal(manifest.name, 'autox');
    assert.deepEqual(manifest.triggers, [{ kind: 'cron', expr: '0 9 * * *' }]);
  });

  it('rejects a duplicate directory', async () => {
    await scaffoldAutomationProject(dir, 'dup');
    await assert.rejects(() => scaffoldAutomationProject(dir, 'dup'), HarnessError);
  });

  it('rejects an invalid id', () => {
    assert.throws(() => validateAutomationId('has space'), HarnessError);
    assert.throws(() => validateAutomationId('_leading'), HarnessError);
  });
});
