/*
 * Automation CRUD over HTTP (issue #141, C7). The desktop no longer
 * mutates an automation in a local worktree — it reads the app's draft
 * over HTTP, applies the file-map transform (toggle / delete), writes the
 * changed/removed files back through the git-store session routes, and
 * publishes. The gateway reconciles the OS scheduler on publish, so the
 * desktop registers nothing itself. This boots a real gateway and drives
 * two of those wire paths end to end:
 *   1. toggle an app-owned automation's `enabled` flag and republish, and
 *   2. delete an app-owned automation's subdir (file DELETE + republish)
 *      while the owning UI app survives.
 */

import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { scaffoldAppFiles, type ScaffoldFile } from '@centraid/blueprints';
import * as automation from '@centraid/automation';
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

// A UI app (kind defaults to 'app') that owns one automation under
// `automations/digest/`. Built from the canonical scaffold so the app.json
// is realistic; the automation manifest is appended manually.
function uiAppWithAutomation(enabled: boolean): ScaffoldFile[] {
  const base = scaffoldAppFiles('notes', { name: 'Notes' }).filter(
    (f) => f.path !== 'automations/README.md',
  );
  return [
    ...base,
    {
      path: 'automations/digest/automation.json',
      content:
        JSON.stringify(
          {
            name: 'Digest',
            version: '0.1.0',
            enabled,
            prompt: 'summarize notes',
            triggers: [{ kind: 'cron', expr: '0 9 * * *' }],
            requires: {},
            history: { keep: { count: 100 } },
            generated: { by: 'tmpl', at: '2020-01-01T00:00:00.000Z' },
          },
          null,
          2,
        ) + '\n',
    },
    {
      path: 'automations/digest/handler.js',
      content: 'export default async () => ({ summary: "ok" });\n',
    },
  ];
}

async function openSession(sessionId: string): Promise<void> {
  await fetch(`${handle.url}/centraid/_apps/_sessions`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
}

async function putFiles(appId: string, sessionId: string, files: ScaffoldFile[]): Promise<void> {
  for (const f of files) {
    const res = await fetch(
      `${handle.url}/centraid/_apps/${appId}/files/${f.path
        .split('/')
        .map(encodeURIComponent)
        .join('/')}?sessionId=${sessionId}`,
      { method: 'PUT', headers: auth(), body: f.content },
    );
    expect(res.status).toBe(200);
  }
}

async function publish(appId: string, sessionId: string, message: string): Promise<void> {
  const res = await fetch(`${handle.url}/centraid/_apps/${appId}/publish`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
  });
  expect(res.status).toBe(201);
}

async function readDraft(appId: string, sessionId: string): Promise<ScaffoldFile[]> {
  const res = await fetch(`${handle.url}/centraid/_apps/${appId}/files?sessionId=${sessionId}`, {
    headers: auth(),
  });
  const out = (await res.json()) as { files: ScaffoldFile[] };
  return out.files ?? [];
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `gw-autocrud-${crypto.randomUUID()}-`));
  handle = await serve({
    paths: pathsUnder(dataDir),
  });
});

afterEach(async () => {
  await handle?.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('toggling an app-owned automation enabled flag over HTTP republishes the manifest', async () => {
  await openSession('s1');
  await putFiles('notes', 's1', uiAppWithAutomation(false));
  await publish('notes', 's1', 'scaffold');

  // Toggle enabled false → true, exactly as AUTOMATIONS_SET_ENABLED does.
  const current = await readDraft('notes', 's1');
  const changed = automation.setEnabledInFiles(current, 'digest', true);
  expect(changed.length).toBe(1);
  await putFiles('notes', 's1', changed);
  await publish('notes', 's1', 'toggle digest');

  const after = await readDraft('notes', 's1');
  const manifest = JSON.parse(
    after.find((f) => f.path === 'automations/digest/automation.json')!.content,
  ) as { enabled: boolean };
  expect(manifest.enabled).toBe(true);
});

test('automation create rejects data/condition trigger kinds instead of coercing them to cron', async () => {
  const res = await fetch(`${handle.url}/centraid/_automations`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'watcher',
      triggers: [{ kind: 'data', entities: ['core.content_derivative'] }],
    }),
  });
  expect(res.status).toBe(400);
  const out = (await res.json()) as { error: string; message: string };
  expect(out.error).toBe('bad_request');
  expect(out.message).toContain('data');

  // cron (explicit or default) and expr-only entries still scaffold fine.
  const ok = await fetch(`${handle.url}/centraid/_automations`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'minutely', triggers: [{ expr: '* * * * *' }] }),
  });
  expect(ok.status).toBe(201);
});

test('deleting an app-owned automation over HTTP removes the subdir but keeps the app', async () => {
  await openSession('s2');
  await putFiles('notes', 's2', uiAppWithAutomation(true));
  await publish('notes', 's2', 'scaffold');

  // Delete the automation subdir, exactly as AUTOMATIONS_DELETE's app-owned
  // branch does: file-map transform → DELETE each removed path → republish.
  const current = await readDraft('notes', 's2');
  const { removed } = automation.deleteFromFiles(current, 'digest');
  expect(removed.sort()).toEqual([
    'automations/digest/automation.json',
    'automations/digest/handler.js',
  ]);
  for (const rel of removed) {
    const res = await fetch(
      `${handle.url}/centraid/_apps/notes/files/${rel
        .split('/')
        .map(encodeURIComponent)
        .join('/')}?sessionId=s2`,
      { method: 'DELETE', headers: auth() },
    );
    expect(res.status).toBe(200);
  }
  await publish('notes', 's2', 'delete digest');

  // The app survives on `main`; the automation's files are gone.
  const listRes = await fetch(`${handle.url}/centraid/_apps`, { headers: auth() });
  const list = (await listRes.json()) as Array<{ id: string }>;
  expect(list.some((a) => a.id === 'notes')).toBeTruthy();
  const after = await readDraft('notes', 's2');
  expect(after.some((f) => f.path === 'app.json')).toBeTruthy();
  expect(!after.some((f) => f.path.startsWith('automations/digest/'))).toBeTruthy();
});
