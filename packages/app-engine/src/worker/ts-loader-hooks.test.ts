/**
 * Direct unit tests for the handler worker TS loader hooks (issue #545 B5).
 */

import { tempDir } from '@centraid/test-kit/temp-dir';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { load, resolve } from './ts-loader-hooks.js';

describe('ts-loader-hooks resolve', () => {
  it('falls through to nextResolve when it succeeds', async () => {
    const next = async () => ({ url: 'file:///ok.js', format: 'module' as const });
    await expect(
      resolve('./x', { parentURL: 'file:///a/b.ts', conditions: [], importAttributes: {} }, next),
    ).resolves.toStrictEqual({ url: 'file:///ok.js', format: 'module' });
  });

  it('rewrites ./util.js → ./util.ts when the .ts sibling exists on disk', async () => {
    const dir = await tempDir('ts-hooks-resolve-');
    await writeFile(path.join(dir, 'util.ts'), 'export const n = 1;\n');
    const parentURL = pathToFileURL(path.join(dir, 'handler.ts')).href;
    const next = async () => {
      throw Object.assign(new Error('not found'), { code: 'ERR_MODULE_NOT_FOUND' });
    };
    const result = await resolve(
      './util.js',
      { parentURL, conditions: [], importAttributes: {} },
      next,
    );
    expect(result.shortCircuit).toBe(true);
    expect(result.format).toBe('module');
    expect(result.url).toBe(pathToFileURL(path.join(dir, 'util.ts')).href);
  });

  it('rewrites extensionless ./util → ./util.ts', async () => {
    const dir = await tempDir('ts-hooks-resolve2-');
    await writeFile(path.join(dir, 'util.ts'), 'export const n = 1;\n');
    const parentURL = pathToFileURL(path.join(dir, 'handler.ts')).href;
    const next = async () => {
      throw new Error('not found');
    };
    const result = await resolve(
      './util',
      { parentURL, conditions: [], importAttributes: {} },
      next,
    );
    expect(result.url).toBe(pathToFileURL(path.join(dir, 'util.ts')).href);
  });

  it('rethrows when no TS candidate exists', async () => {
    const next = async () => {
      throw new Error('boom');
    };
    await expect(
      resolve(
        './missing.js',
        {
          parentURL: pathToFileURL('/tmp/x.ts').href,
          conditions: [],
          importAttributes: {},
        },
        next,
      ),
    ).rejects.toThrow('boom');
  });
});

describe('ts-loader-hooks load', () => {
  it('defers non-TS urls to nextLoad', async () => {
    const next = async () => ({ format: 'module' as const, source: 'export {}' });
    await expect(
      load('file:///a.js', { conditions: [], importAttributes: {} }, next),
    ).resolves.toStrictEqual({ format: 'module', source: 'export {}' });
  });

  it('compiles .ts source to ESM via esbuild', async () => {
    const dir = await tempDir('ts-hooks-load-');
    const file = path.join(dir, 'add.ts');
    await writeFile(file, 'export const add = (a: number, b: number): number => a + b;\n');
    const url = pathToFileURL(file).href;
    const next = async () => {
      throw new Error('should not call nextLoad for .ts');
    };
    const result = await load(url, { conditions: [], importAttributes: {} }, next);
    expect(result.shortCircuit).toBe(true);
    expect(result.format).toBe('module');
    expect(String(result.source)).toMatch(/\badd\b/);
    expect(String(result.source)).toMatch(/export\s*\{/);
    expect(String(result.source)).not.toMatch(/: number/);
  });
});
