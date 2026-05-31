/*
 * Scheduler-on-publish reconcile (issue #141). A publish over HTTP must
 * resync the OS scheduler — `serve()` reconciles in onAppLive using the
 * injected `schedulerHostFactory`. Boots a real git-store gateway with a
 * stub host and asserts a publish triggers a reconcile carrying the
 * scanned automation rows.
 */

import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { AutomationHost, AutomationRow } from '@centraid/automation';
import { serve, type GatewayServeHandle } from './serve.ts';
import type { GatewayPaths } from './paths.ts';
import type { SecretsProvider } from './secrets.ts';

let dataDir: string;
let handle: GatewayServeHandle;
let reconcileCalls: Array<{ codeAppsDir: string; rows: readonly AutomationRow[] }>;

const noSecrets: SecretsProvider = {
  async getProviderApiKey() {
    return undefined;
  },
};

function pathsUnder(dir: string): GatewayPaths {
  return {
    appsDir: path.join(dir, 'apps'),
    identityDb: path.join(dir, 'identity.sqlite'),
    analyticsDb: path.join(dir, 'analytics.sqlite'),
    chatRunnerSessionDir: path.join(dir, 'chat-runner-sessions'),
    codexHomeBaseDir: path.join(dir, 'codex-home'),
  };
}

function stubHost(dirs: { codeAppsDir: string; dataAppsDir: string }): AutomationHost {
  return {
    async register() {},
    async unregister() {},
    async list() {
      return [];
    },
    async reconcile(desired) {
      reconcileCalls.push({ codeAppsDir: dirs.codeAppsDir, rows: desired });
      return { added: [], updated: [], removed: [] };
    },
  };
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${handle.token}` };
}

const APP_JSON = JSON.stringify({
  manifestVersion: 1,
  id: 'brief',
  name: 'Brief',
  version: '0.1.0',
  kind: 'automation',
  actions: [],
  queries: [],
});

const AUTOMATION_JSON = JSON.stringify({
  name: 'Brief',
  version: '0.1.0',
  enabled: true,
  prompt: 'do the thing',
  triggers: [{ kind: 'cron', expr: '0 9 * * *' }],
  requires: {},
  history: { keep: { count: 100 } },
  generated: { by: 'centraid-builder', at: '2026-01-01T00:00:00.000Z' },
});

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `gw-sched-${crypto.randomUUID()}-`));
  reconcileCalls = [];
  handle = await serve({
    paths: pathsUnder(dataDir),
    secrets: noSecrets,
    appsStoreRoot: path.join(dataDir, 'code'),
    schedulerHostFactory: stubHost,
  });
});

afterEach(async () => {
  await handle?.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('publishing an automation triggers a scheduler reconcile with the new rows', async () => {
  // Startup reconcile already ran (empty store). Record the baseline.
  await waitFor(() => reconcileCalls.length >= 1);
  const baseline = reconcileCalls.length;

  // Open a session, lay down an automation app, publish.
  await fetch(`${handle.url}/centraid/_apps/_sessions`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1' }),
  });
  for (const [rel, content] of [
    ['app.json', APP_JSON],
    ['automations/brief/automation.json', AUTOMATION_JSON],
    ['automations/brief/handler.js', 'export default async () => ({ summary: "ok" });\n'],
  ] as const) {
    const res = await fetch(`${handle.url}/centraid/_apps/brief/files/${rel}?sessionId=s1`, {
      method: 'PUT',
      headers: auth(),
      body: content,
    });
    assert.equal(res.status, 200, `put ${rel}: ${await res.text()}`);
  }
  const pub = await fetch(`${handle.url}/centraid/_apps/brief/publish`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', message: 'add brief' }),
  });
  assert.equal(pub.status, 201, await pub.text());

  // The publish's onAppLive reconciled the scheduler with the new row.
  await waitFor(() => reconcileCalls.length > baseline);
  const last = reconcileCalls.at(-1)!;
  assert.match(last.codeAppsDir, /active-main[/\\]apps$/);
  assert.deepEqual(
    last.rows.map((r) => r.ref),
    ['brief/brief'],
  );
});
