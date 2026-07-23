/* oxlint-disable typescript-eslint/ban-ts-comment -- the package tsconfig has
   no DOM lib; this test boots the browser scaffold under jsdom. */
// @ts-nocheck
// @vitest-environment jsdom
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { scaffoldAppFiles } from './scaffold-files.js';

const packageDir = path.resolve(import.meta.dirname, '..');
const scratchDir = path.join(packageDir, '.app-boot', '_scaffold');

describe('dependency-free app scaffold', () => {
  const errors: unknown[] = [];
  const capture = (error: unknown) => errors.push(error);
  let onChange: (() => void) | null = null;
  let response: unknown = {};

  beforeAll(() => {
    rmSync(scratchDir, { recursive: true, force: true });
    mkdirSync(scratchDir, { recursive: true });
    const app = scaffoldAppFiles('demo', { name: 'Demo' }).find((file) => file.path === 'app.js');
    expect(app, 'scaffold no longer emits app.js').toBeTruthy();
    writeFileSync(path.join(scratchDir, 'app.js'), app.content);
    process.on('unhandledRejection', capture);
    process.on('uncaughtException', capture);
    window.addEventListener('error', (event) => capture(event.error ?? event.message));
  });

  afterAll(() => {
    process.off('unhandledRejection', capture);
    process.off('uncaughtException', capture);
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('boots, shows consent denial, and recovers without a framework runtime', async () => {
    const html = scaffoldAppFiles('demo', { name: 'Demo' }).find(
      (file) => file.path === 'index.html',
    )!.content;
    const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html);
    expect(body, 'scaffold index.html has no body').toBeTruthy();
    document.body.innerHTML = body![1]!;

    window.centraid = {
      appId: 'demo',
      read: async () => response,
      write: async () => ({}),
      onChange: (listener) => {
        onChange = listener;
        return () => {
          onChange = null;
        };
      },
    };

    await import(pathToFileURL(path.join(scratchDir, 'app.js')).href);
    await vi.waitFor(() => {
      expect(document.querySelector('main h1')?.textContent).toBe('Your app');
      expect(onChange).toBeTypeOf('function');
      expect(document.querySelector<HTMLElement>('.surface')?.hidden).toBe(false);
    });

    response = { vaultDenied: { message: 'Grant revoked.' } };
    onChange!();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('#consentBanner')?.hidden).toBe(false);
      expect(document.querySelector('#consentBanner span')?.textContent).toBe('Grant revoked.');
    });

    response = {};
    onChange!();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('#consentBanner')?.hidden).toBe(true);
      expect(document.querySelector<HTMLElement>('.surface')?.hidden).toBe(false);
    });
    expect(errors).toEqual([]);
  });
});
