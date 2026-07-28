import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { describe, expect, it } from 'vitest';
import { parseAdditionalDirectories, parseWorkspaceKind } from './turn-sse-support.js';

describe('conversation workspace parsing', () => {
  it('accepts only the three first-class workspace choices', () => {
    expect(parseWorkspaceKind('vault-data')).toBe('vault-data');
    expect(parseWorkspaceKind('app')).toBe('app');
    expect(parseWorkspaceKind('draft')).toBe('draft');
    expect(parseWorkspaceKind('/arbitrary/path')).toBeUndefined();
  });

  it('persists canonical, deduplicated non-root additional directories', async () => {
    const dir = await tempDir('centraid-additional-dir-');
    const target = path.join(dir, 'target');
    const alias = path.join(dir, 'alias');
    await fs.mkdir(target);
    await fs.symlink(target, alias);

    await expect(parseAdditionalDirectories([target, alias])).resolves.toEqual([
      await fs.realpath(target),
    ]);
  });

  it('rejects relative paths, files, and the filesystem root', async () => {
    const dir = await tempDir('centraid-invalid-additional-dir-');
    const file = path.join(dir, 'file.txt');
    await fs.writeFile(file, 'x');
    await expect(parseAdditionalDirectories(['relative'])).rejects.toThrow(/absolute/);
    await expect(parseAdditionalDirectories([file])).rejects.toThrow(/non-root directory/);
    await expect(parseAdditionalDirectories([path.parse(dir).root])).rejects.toThrow(
      /non-root directory/,
    );
  });
});
