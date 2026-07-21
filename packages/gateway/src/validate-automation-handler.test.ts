import { tempDir } from '@centraid/test-kit/temp-dir';
// Issue #167: the gateway publish gate (`validateManifestAt`) lints an
// automation app's handler.js for replay-unsafe patterns, so a
// nondeterministic handler is rejected at publish time rather than silently
// mis-resumed under the #166 journal/replay runtime.

import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validateManifestAt } from './validate-manifest.ts';

let dir: string;

beforeEach(async () => {
  dir = await tempDir('centraid-validate-handler-');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeAutomationApp(handler: string): Promise<void> {
  await fs.writeFile(
    path.join(dir, 'app.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: 'auto-app',
      name: 'Auto App',
      kind: 'automation',
      version: '0.1.0',
      actions: [],
      queries: [],
    }),
  );
  const autoDir = path.join(dir, 'automations', 'main');
  await fs.mkdir(autoDir, { recursive: true });
  await fs.writeFile(path.join(autoDir, 'handler.js'), handler);
}

test('passes a replay-safe automation handler', async () => {
  await writeAutomationApp(
    `export default async ({ ctx }) => {
       const found = await ctx.vault.search({ entity: 'core.thread', text: '' });
       const rows = Array.isArray(found?.rows) ? found.rows : [];
       return { summary: 'ok', output: { n: rows.length } };
     };`,
  );
  expect(await validateManifestAt(dir)).toBe(undefined);
});

test('rejects a handler that reads the wall clock', async () => {
  await writeAutomationApp(
    `export default async ({ ctx }) => {
       const now = Date.now();
       return { summary: String(now) };
     };`,
  );
  const err = await validateManifestAt(dir);
  expect(err).toBeTruthy();
  expect(err!).toMatch(/automations\/main\/handler\.js/);
  expect(err!).toMatch(/no-date-now/);
});

test('rejects a handler that uses Math.random / raw fetch', async () => {
  await writeAutomationApp(
    `export default async () => {
       const r = await fetch('https://x?seed=' + Math.random());
       return { summary: 'x' };
     };`,
  );
  const err = await validateManifestAt(dir);
  expect(err).toBeTruthy();
  expect(err!).toMatch(/no-raw-fetch|no-math-random/);
});

test('does not lint handlers of a non-automation app', async () => {
  // A regular app whose actions/queries are empty: no handler lint runs even if
  // an automations/ dir with an unsafe handler happens to exist.
  await fs.writeFile(
    path.join(dir, 'app.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: 'ui-app',
      name: 'UI App',
      kind: 'app',
      version: '0.1.0',
      actions: [],
      queries: [],
    }),
  );
  const autoDir = path.join(dir, 'automations', 'main');
  await fs.mkdir(autoDir, { recursive: true });
  await fs.writeFile(path.join(autoDir, 'handler.js'), 'export default async () => Date.now();');
  expect(await validateManifestAt(dir)).toBe(undefined);
});
