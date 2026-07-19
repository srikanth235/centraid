import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseManifest } from '../manifest/manifest.js';
import { scaffoldApp, validateId, validateAppId } from './scaffold.js';
import { AppScaffoldError } from '@centraid/blueprints';

describe('scaffoldApp', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tempDir('centraid-autoscaffold-');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes app.json + automations/<id>/{automation.json,handler.js}', async () => {
    const info = await scaffoldApp(dir, 'daily-digest', {
      name: 'Daily digest',
      prompt: 'Summarize my PRs',
      cronExpr: '0 8 * * *',
      apps: ['todos'],
    });
    expect(info.id).toBe('daily-digest');
    expect(info.name).toBe('Daily digest');

    const appJson = JSON.parse(
      await fs.readFile(path.join(dir, 'daily-digest', 'app.json'), 'utf8'),
    ) as { name: string };
    expect(appJson.name).toBe('Daily digest');

    const autoDir = path.join(dir, 'daily-digest', 'automations', 'daily-digest');
    const manifest = parseManifest(
      await fs.readFile(path.join(autoDir, 'automation.json'), 'utf8'),
    );
    expect(manifest.name).toBe('Daily digest');
    expect(manifest.prompt).toBe('Summarize my PRs');
    expect(manifest.triggers).toEqual([{ kind: 'cron', expr: '0 8 * * *' }]);
    expect(manifest.apps).toEqual(['todos']);
    expect(manifest.enabled).toBe(true);

    const handler = await fs.readFile(path.join(autoDir, 'handler.js'), 'utf8');
    expect(handler).toMatch(/export default async/);
  });

  it('derives the automation id from the app id, defaults a daily schedule', async () => {
    await scaffoldApp(dir, 'autox');
    const autoDir = path.join(dir, 'autox', 'automations', 'autox');
    const manifest = parseManifest(
      await fs.readFile(path.join(autoDir, 'automation.json'), 'utf8'),
    );
    expect(manifest.name).toBe('autox');
    expect(manifest.triggers).toEqual([{ kind: 'cron', expr: '0 9 * * *' }]);
  });

  it('honors an explicit automationId', async () => {
    await scaffoldApp(dir, 'bot', { automationId: 'job' });
    const autoDir = path.join(dir, 'bot', 'automations', 'job');
    expect((await fs.stat(autoDir)).isDirectory()).toBeTruthy();
  });

  it('rejects a duplicate app folder', async () => {
    await scaffoldApp(dir, 'dup');
    await expect((() => scaffoldApp(dir, 'dup'))()).rejects.toThrow(AppScaffoldError);
  });

  it('rejects a dotted / path-unsafe app id', async () => {
    await expect((() => scaffoldApp(dir, 'auto.x'))()).rejects.toThrow(AppScaffoldError);
  });

  it('validates ids', () => {
    expect(() => validateId('has space')).toThrow(AppScaffoldError);
    expect(() => validateId('_leading')).toThrow(AppScaffoldError);
    // Automation apps use a plain slug id now (kind marks them, not a
    // dotted prefix) — a dotted id is rejected, a slug accepted.
    expect(() => validateAppId('auto.ok')).toThrow(AppScaffoldError);
    validateAppId('standup-bot');
  });
});
