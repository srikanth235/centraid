/*
 * Template clone over HTTP (issue #141). The desktop no longer writes a
 * cloned template into a local worktree — it reads the bundled catalog,
 * rewrites the file map in memory (`cloneTemplateFiles`), provisions any
 * pending webhook triggers (`provisionPendingWebhooksInFiles`), then
 * pushes the result into an editing session and publishes, all over the
 * same HTTP surface a remote gateway exposes. This boots a real git-store
 * gateway and drives that exact wire path end to end: the published app
 * lands on `main` with a plain-slug id, `kind: 'automation'`, and a
 * provisioned webhook (hashed secret, no plaintext, no `pending` flag).
 */

import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { cloneTemplateFiles } from '@centraid/blueprints';
import { provisionPendingWebhooksInFiles } from '@centraid/automation';
import { serve, type GatewayServeHandle } from '../serve/serve.ts';
import type { GatewayPaths } from '../paths.ts';

let dataDir: string;
let handle: GatewayServeHandle;

function pathsUnder(dir: string): GatewayPaths {
  return {
    appsDir: path.join(dir, 'apps'),
    identityDb: path.join(dir, 'identity.sqlite'),
    analyticsDb: path.join(dir, 'analytics.sqlite'),
    conversationRunnerSessionDir: path.join(dir, 'conversation-runner-sessions'),
  };
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${handle.token}` };
}

// A minimal automation template: an automation app whose manifest ships a
// pending webhook trigger the author can't pre-mint.
function templateFiles(): { path: string; content: string }[] {
  return [
    {
      path: 'app.json',
      content:
        JSON.stringify(
          {
            manifestVersion: 1,
            id: 'inbound',
            name: 'Inbound',
            version: '1.2.0',
            kind: 'automation',
            description: 'route inbound hooks',
            actions: [],
            queries: [],
          },
          null,
          2,
        ) + '\n',
    },
    {
      path: 'automations/inbound/automation.json',
      content:
        JSON.stringify(
          {
            name: 'Inbound',
            version: '1.2.0',
            enabled: true,
            prompt: 'handle the hook',
            triggers: [{ kind: 'webhook', pending: true }],
            requires: {},
            history: { keep: { count: 100 } },
            generated: { by: 'tmpl', at: '2020-01-01T00:00:00.000Z' },
          },
          null,
          2,
        ) + '\n',
    },
    {
      path: 'automations/inbound/handler.js',
      content: 'export default async () => ({ ok: true });\n',
    },
  ];
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `gw-clone-${crypto.randomUUID()}-`));
  handle = await serve({
    paths: pathsUnder(dataDir),
    appsStoreRoot: path.join(dataDir, 'code'),
  });
});

afterEach(async () => {
  await handle?.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('cloning a template over HTTP publishes a plain-slug automation app with a provisioned webhook', async () => {
  // 1. Rewrite the template's file map for a fresh id + name, exactly as
  //    the desktop's TEMPLATES_CLONE handler does.
  const cloned = cloneTemplateFiles({
    newAppId: 'inbound-2',
    templateFiles: templateFiles(),
    newName: 'Inbound 2',
  });
  // app.json carries the new id + name + version reset, kind preserved.
  const appJson = JSON.parse(cloned.find((f) => f.path === 'app.json')!.content) as {
    id: string;
    name: string;
    version: string;
    kind: string;
  };
  expect(appJson.id).toBe('inbound-2');
  expect(appJson.name).toBe('Inbound 2');
  expect(appJson.version).toBe('0.1.0');
  expect(appJson.kind).toBe('automation');

  // 2. Provision the pending webhook (secret minted here; only its hash is
  //    written into the manifest).
  const { files, minted } = provisionPendingWebhooksInFiles(cloned, 'inbound-2');
  expect(minted.length).toBe(1);
  expect(minted[0]!.ownerApp).toBe('inbound-2');
  expect(minted[0]!.automationId).toBe('inbound');
  expect(minted[0]!.secret.length > 0).toBeTruthy();

  // 3. Open a session, PUT every file, publish — the HTTP path that works
  //    against a remote gateway.
  await fetch(`${handle.url}/centraid/_apps/_sessions`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1' }),
  });
  for (const f of files) {
    const res = await fetch(
      `${handle.url}/centraid/_apps/inbound-2/files/${f.path
        .split('/')
        .map(encodeURIComponent)
        .join('/')}?sessionId=s1`,
      { method: 'PUT', headers: auth(), body: f.content },
    );
    expect(res.status).toBe(200);
  }
  const pub = await fetch(`${handle.url}/centraid/_apps/inbound-2/publish`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', message: 'clone inbound' }),
  });
  expect(pub.status).toBe(201);

  // 4. The cloned app is on `main` with its kind surfaced in the list.
  const listRes = await fetch(`${handle.url}/centraid/_apps`, { headers: auth() });
  const list = (await listRes.json()) as Array<{ id: string; kind?: string }>;
  const row = list.find((a) => a.id === 'inbound-2');
  expect(row).toBeTruthy();
  expect(row!.kind).toBe('automation');

  // 5. The published manifest carries a provisioned webhook — hashed
  //    secret, no plaintext, no lingering `pending` flag.
  const filesRes = await fetch(`${handle.url}/centraid/_apps/inbound-2/files?sessionId=s1`, {
    headers: auth(),
  });
  const draft = (await filesRes.json()) as { files: { path: string; content: string }[] };
  const manifestFile = draft.files.find((f) => f.path === 'automations/inbound/automation.json');
  expect(manifestFile).toBeTruthy();
  const manifest = JSON.parse(manifestFile!.content) as {
    triggers: { kind: string; id?: string; secretHash?: string; pending?: boolean }[];
  };
  const hook = manifest.triggers.find((t) => t.kind === 'webhook')!;
  expect(hook.id && hook.secretHash).toBeTruthy();
  expect(hook.pending).toBe(undefined);
  expect(!JSON.stringify(manifest).includes(minted[0]!.secret)).toBeTruthy();
});
