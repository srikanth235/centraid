/*
 * `POST /centraid/_automations/update?ref=` — the instructions-first
 * editor's save path (automations UI revamp). Boots a real gateway and
 * drives the wire path end to end, mirroring
 * `../lifecycle/automation-lifecycle-over-http.test.ts`'s style for the
 * sibling create/set-enabled/rotate-webhook/delete routes.
 */

import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { serve, type GatewayServeHandle } from '../serve/serve.ts';
import type { GatewayPaths } from '../paths.ts';

let dataDir: string;
let handle: GatewayServeHandle;

function pathsUnder(dir: string): GatewayPaths {
  return {
    vaultDir: path.join(dir, 'vault'),
    prefsFile: path.join(dir, 'prefs.json'),
  };
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${handle.token}` };
}

interface CreatedAutomation {
  row: { ref: string; manifest: { name: string; prompt: string; triggers: unknown[] } };
  webhook?: { id: string; secret: string; url: string };
}

/** Scaffold + publish a fresh automation app via the real create route. */
async function createAutomation(
  id: string,
  body: Record<string, unknown> = {},
): Promise<CreatedAutomation> {
  const res = await fetch(`${handle.url}/centraid/_automations`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      name: id,
      prompt: 'do the thing',
      triggers: [{ kind: 'cron', expr: '0 9 * * *' }],
      publish: true,
      ...body,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreatedAutomation;
}

async function update(
  ref: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(
    `${handle.url}/centraid/_automations/update?ref=${encodeURIComponent(ref)}`,
    {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ publish: true, ...body }),
    },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `gw-autoupdate-${crypto.randomUUID()}-`));
  handle = await serve({ paths: pathsUnder(dataDir) });
});

afterEach(async () => {
  await handle?.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('update patches only the name, leaving prompt/triggers untouched', async () => {
  const created = await createAutomation('renamer');
  const { status, json } = await update(created.row.ref, { name: 'Renamed Automation' });
  expect(status).toBe(200);
  const row = json.row as { manifest: { name: string; prompt: string; triggers: unknown[] } };
  expect(row.manifest.name).toBe('Renamed Automation');
  expect(row.manifest.prompt).toBe('do the thing');
  expect(row.manifest.triggers).toEqual([{ kind: 'cron', expr: '0 9 * * *' }]);
});

test('update patches only the prompt, leaving name/triggers untouched', async () => {
  const created = await createAutomation('reprompter');
  const { status, json } = await update(created.row.ref, { prompt: 'do a different thing now' });
  expect(status).toBe(200);
  const row = json.row as { manifest: { name: string; prompt: string; triggers: unknown[] } };
  expect(row.manifest.prompt).toBe('do a different thing now');
  expect(row.manifest.name).toBe('reprompter');
  expect(row.manifest.triggers).toEqual([{ kind: 'cron', expr: '0 9 * * *' }]);
});

test('update replaces a cron trigger with a different cron expression', async () => {
  const created = await createAutomation('rescheduler');
  const { status, json } = await update(created.row.ref, {
    triggers: [{ kind: 'cron', expr: '0 * * * *' }],
  });
  expect(status).toBe(200);
  const row = json.row as { manifest: { triggers: unknown[] } };
  expect(row.manifest.triggers).toEqual([{ kind: 'cron', expr: '0 * * * *' }]);
});

test('update mints a fresh webhook when the automation had none before', async () => {
  const created = await createAutomation('gains-a-hook', {
    triggers: [{ kind: 'cron', expr: '0 9 * * *' }],
  });
  const { status, json } = await update(created.row.ref, {
    triggers: [{ kind: 'webhook' }],
  });
  expect(status).toBe(200);
  expect(json.webhook).toBeTruthy();
  const webhook = json.webhook as { id: string; secret: string; url: string };
  expect(webhook.id).toBeTruthy();
  expect(webhook.secret).toBeTruthy();
  expect(webhook.url).toMatch(/\/_centraid-hook\//);
  const row = json.row as { manifest: { triggers: Array<{ kind: string; id?: string }> } };
  expect(row.manifest.triggers).toEqual([
    { kind: 'webhook', id: webhook.id, secretHash: expect.any(String) },
  ]);
});

test('update keeps an existing webhook trigger secret untouched when re-declared', async () => {
  const created = await createAutomation('keeps-its-hook', {
    triggers: [{ kind: 'webhook' }],
  });
  expect(created.webhook).toBeTruthy();
  const originalSecretHash = (
    created.row.manifest.triggers[0] as { kind: string; id: string; secretHash: string }
  ).secretHash;

  // Rename in the same edit that re-declares the webhook trigger — the
  // webhook entry must be a no-op (no fresh mint, no `webhook` in the
  // response) since it already existed.
  const { status, json } = await update(created.row.ref, {
    name: 'Keeps Its Hook (renamed)',
    triggers: [{ kind: 'webhook' }],
  });
  expect(status).toBe(200);
  expect(json.webhook).toBeUndefined();
  const row = json.row as {
    manifest: { name: string; triggers: Array<{ kind: string; id: string; secretHash: string }> };
  };
  expect(row.manifest.name).toBe('Keeps Its Hook (renamed)');
  expect(row.manifest.triggers).toEqual([
    { kind: 'webhook', id: created.webhook!.id, secretHash: originalSecretHash },
  ]);
});

test('update drops a webhook trigger when triggers omits it', async () => {
  const created = await createAutomation('loses-its-hook', {
    triggers: [{ kind: 'webhook' }],
  });
  const { status, json } = await update(created.row.ref, {
    triggers: [{ kind: 'cron', expr: '0 9 * * *' }],
  });
  expect(status).toBe(200);
  const row = json.row as { manifest: { triggers: unknown[] } };
  expect(row.manifest.triggers).toEqual([{ kind: 'cron', expr: '0 9 * * *' }]);
});

test('update on an unknown ref is a 404', async () => {
  const { status, json } = await update('nope/nope', { name: 'ghost' });
  expect(status).toBe(404);
  expect(json.error).toBe('not_found');
});

test('update rejects an unsupported trigger kind with a 400', async () => {
  const created = await createAutomation('bad-trigger-kind');
  const { status, json } = await update(created.row.ref, {
    triggers: [{ kind: 'carrier-pigeon' }],
  });
  expect(status).toBe(400);
  expect(json.error).toBe('bad_request');
  expect(json.message).toContain('carrier-pigeon');
});

test('update rejects a malformed condition trigger with the validator field-scoped message', async () => {
  const created = await createAutomation('bad-condition-trigger');
  const { status, json } = await update(created.row.ref, {
    triggers: [{ kind: 'condition', entity: 'core.invoice', where: 'not-an-array' }],
  });
  expect(status).toBe(400);
  expect(json.error).toBe('bad_request');
  expect(json.message).toContain('where');
});

test('update with no recognized fields is a 400', async () => {
  const created = await createAutomation('empty-patch');
  const { status, json } = await update(created.row.ref, {});
  expect(status).toBe(400);
  expect(json.error).toBe('bad_request');
});
