import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { applyAppVisualIdentity, stampAppVisualIdentity } from './app-rewrites.js';

describe('applyAppVisualIdentity', () => {
  const manifest = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ id: 'hydrate', name: 'Hydrate', version: '0.1.0', ...extra }, null, 2) + '\n';

  it('backfills missing iconKey/colorKey', () => {
    const next = applyAppVisualIdentity(manifest(), { iconKey: 'Water', colorKey: 'teal' });
    const parsed = JSON.parse(next!) as { iconKey: string; colorKey: string };
    expect(parsed.iconKey).toBe('Water');
    expect(parsed.colorKey).toBe('teal');
  });

  it('keeps keys the manifest already declares', () => {
    const next = applyAppVisualIdentity(manifest({ iconKey: 'Todo', colorKey: 'indigo' }), {
      iconKey: 'Water',
      colorKey: 'teal',
    });
    const parsed = JSON.parse(next!) as { iconKey: string; colorKey: string };
    expect(parsed.iconKey).toBe('Todo');
    expect(parsed.colorKey).toBe('indigo');
  });

  it('fills only the missing half of a partial identity', () => {
    const next = applyAppVisualIdentity(manifest({ iconKey: 'Todo' }), {
      iconKey: 'Water',
      colorKey: 'teal',
    });
    const parsed = JSON.parse(next!) as { iconKey: string; colorKey: string };
    expect(parsed.iconKey).toBe('Todo');
    expect(parsed.colorKey).toBe('teal');
  });

  it('returns null on unparseable input', () => {
    expect(applyAppVisualIdentity('not json', { iconKey: 'Water' })).toBe(null);
  });
});

describe('stampAppVisualIdentity', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tempDir('centraid-visual-');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('stamps app.json on disk', async () => {
    await fs.writeFile(
      path.join(dir, 'app.json'),
      JSON.stringify({ id: 'x', name: 'X', version: '0.1.0' }, null, 2) + '\n',
    );
    await stampAppVisualIdentity(dir, { iconKey: 'Water', colorKey: 'teal' });
    const parsed = JSON.parse(await fs.readFile(path.join(dir, 'app.json'), 'utf8')) as {
      iconKey: string;
      colorKey: string;
    };
    expect(parsed.iconKey).toBe('Water');
    expect(parsed.colorKey).toBe('teal');
  });

  it('is a no-op when app.json is missing', async () => {
    await stampAppVisualIdentity(dir, { iconKey: 'Water' });
    await expect(fs.access(path.join(dir, 'app.json'))).rejects.toThrow();
  });
});
