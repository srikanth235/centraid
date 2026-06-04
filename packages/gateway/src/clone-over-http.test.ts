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

import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { cloneTemplateFiles } from '@centraid/blueprints';
import { provisionPendingWebhooksInFiles } from '@centraid/conversation-engine';
import { serve, type GatewayServeHandle } from './serve.ts';
import type { GatewayPaths } from './paths.ts';

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
  assert.equal(appJson.id, 'inbound-2');
  assert.equal(appJson.name, 'Inbound 2');
  assert.equal(appJson.version, '0.1.0');
  assert.equal(appJson.kind, 'automation');

  // 2. Provision the pending webhook (secret minted here; only its hash is
  //    written into the manifest).
  const { files, minted } = provisionPendingWebhooksInFiles(cloned, 'inbound-2');
  assert.equal(minted.length, 1);
  assert.equal(minted[0]!.ownerApp, 'inbound-2');
  assert.equal(minted[0]!.automationId, 'inbound');
  assert.ok(minted[0]!.secret.length > 0);

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
    assert.equal(res.status, 200, `put ${f.path}: ${await res.text()}`);
  }
  const pub = await fetch(`${handle.url}/centraid/_apps/inbound-2/publish`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', message: 'clone inbound' }),
  });
  assert.equal(pub.status, 201, await pub.text());

  // 4. The cloned app is on `main` with its kind surfaced in the list.
  const listRes = await fetch(`${handle.url}/centraid/_apps`, { headers: auth() });
  const list = (await listRes.json()) as Array<{ id: string; kind?: string }>;
  const row = list.find((a) => a.id === 'inbound-2');
  assert.ok(row, 'cloned app missing from list');
  assert.equal(row!.kind, 'automation');

  // 5. The published manifest carries a provisioned webhook — hashed
  //    secret, no plaintext, no lingering `pending` flag.
  const filesRes = await fetch(`${handle.url}/centraid/_apps/inbound-2/files?sessionId=s1`, {
    headers: auth(),
  });
  const draft = (await filesRes.json()) as { files: { path: string; content: string }[] };
  const manifestFile = draft.files.find((f) => f.path === 'automations/inbound/automation.json');
  assert.ok(manifestFile, 'automation manifest missing');
  const manifest = JSON.parse(manifestFile!.content) as {
    triggers: { kind: string; id?: string; secretHash?: string; pending?: boolean }[];
  };
  const hook = manifest.triggers.find((t) => t.kind === 'webhook')!;
  assert.ok(hook.id && hook.secretHash, 'webhook not provisioned');
  assert.equal(hook.pending, undefined);
  assert.ok(!JSON.stringify(manifest).includes(minted[0]!.secret), 'plaintext secret leaked');
});
