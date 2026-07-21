import { tempDir } from '@centraid/test-kit/temp-dir';
// Publish-time `automation.json` validation gap: `validateManifestAt` parsed
// `app.json` and linted `handler.js` for replay safety, but never ran
// `@centraid/automation`'s `parseManifest` over `automations/<id>/automation.json`
// itself. Consequence: the dedicated POST /centraid/_automations create route
// validates trigger/vault shapes on the way in, but the generic draft
// file-write route (PUT /centraid/_apps/<id>/files/<path> — how the builder's
// trigger editor applies changes) did not, so a malformed edit rode straight
// through publish and only failed later at fire/schedule time. This file
// covers the new walk directly; `lifecycle/automation-lifecycle-over-http.test.ts`
// covers the end-to-end publish-time 400.

import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validateManifestAt } from './validate-manifest.ts';

let dir: string;

beforeEach(async () => {
  dir = await tempDir('centraid-validate-manifest-');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeAutomationApp(automationJson: unknown): Promise<void> {
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
  await fs.writeFile(path.join(autoDir, 'automation.json'), JSON.stringify(automationJson));
  await fs.writeFile(
    path.join(autoDir, 'handler.js'),
    'export default async () => ({ summary: "ok" });\n',
  );
}

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Digest',
    version: '0.1.0',
    enabled: true,
    prompt: 'summarize notes',
    triggers: [{ kind: 'cron', expr: '0 9 * * *' }],
    requires: {},
    history: { keep: { count: 100 } },
    generated: { by: 'tmpl', at: '2020-01-01T00:00:00.000Z' },
    ...overrides,
  };
}

test('passes a well-formed automation.json', async () => {
  await writeAutomationApp(baseManifest());
  expect(await validateManifestAt(dir)).toBe(undefined);
});

test('rejects a data trigger with non-array entities', async () => {
  await writeAutomationApp(
    baseManifest({
      triggers: [{ kind: 'data', entities: 'not-an-array' }],
      vault: {
        purpose: 'dpv:ServiceProvision',
        scopes: [{ schema: 'core', verbs: 'read' }],
      },
    }),
  );
  const err = await validateManifestAt(dir);
  expect(err).toBeTruthy();
  expect(err!).toMatch(/automations\/main\/automation\.json/);
  expect(err!).toMatch(/entities/);
});

test('rejects a cron trigger with a malformed expression', async () => {
  await writeAutomationApp(baseManifest({ triggers: [{ kind: 'cron', expr: 'not a cron' }] }));
  const err = await validateManifestAt(dir);
  expect(err).toBeTruthy();
  expect(err!).toMatch(/automations\/main\/automation\.json/);
  expect(err!).toMatch(/cron/);
});

test('rejects a second webhook trigger', async () => {
  await writeAutomationApp(
    baseManifest({
      triggers: [
        { kind: 'webhook', id: 'hook-a', secretHash: 'a'.repeat(64) },
        { kind: 'webhook', id: 'hook-b', secretHash: 'b'.repeat(64) },
      ],
    }),
  );
  const err = await validateManifestAt(dir);
  expect(err).toBeTruthy();
  expect(err!).toMatch(/at most one webhook/);
});

test('rejects a condition trigger missing its required vault block', async () => {
  await writeAutomationApp(
    baseManifest({ triggers: [{ kind: 'condition', entity: 'core.invoice' }] }),
  );
  const err = await validateManifestAt(dir);
  expect(err).toBeTruthy();
  expect(err!).toMatch(/vault/);
});

test('rejects malformed JSON in automation.json', async () => {
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
  await fs.writeFile(path.join(autoDir, 'automation.json'), '{ not valid json');
  await fs.writeFile(
    path.join(autoDir, 'handler.js'),
    'export default async () => ({ summary: "ok" });\n',
  );
  const err = await validateManifestAt(dir);
  expect(err).toBeTruthy();
  expect(err!).toMatch(/automations\/main\/automation\.json/);
  expect(err!).toMatch(/not valid JSON/);
});

test('automation.json validation runs before handler linting, surfacing the manifest error first', async () => {
  await writeAutomationApp(baseManifest({ triggers: [{ kind: 'cron', expr: 'bogus' }] }));
  // Overwrite the handler with a replay-unsafe one too — the manifest error
  // must win so authors fix structural problems first.
  await fs.writeFile(
    path.join(dir, 'automations', 'main', 'handler.js'),
    'export default async () => ({ summary: String(Date.now()) });\n',
  );
  const err = await validateManifestAt(dir);
  expect(err).toBeTruthy();
  expect(err!).toMatch(/automation\.json/);
  expect(err!).not.toMatch(/no-date-now/);
});

test('does not validate automation.json of a non-automation app', async () => {
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
  // A structurally invalid automation.json that would fail parseManifest —
  // ignored because this app's kind is not 'automation'.
  await fs.writeFile(path.join(autoDir, 'automation.json'), '{ not valid json');
  expect(await validateManifestAt(dir)).toBe(undefined);
});

test("missing automation.json is not this validator's concern", async () => {
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
  await fs.writeFile(
    path.join(autoDir, 'handler.js'),
    'export default async () => ({ summary: "ok" });\n',
  );
  expect(await validateManifestAt(dir)).toBe(undefined);
});
