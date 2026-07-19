import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * Scheduler-on-publish reconcile (issue #149). A publish over HTTP must
 * resync the in-process cron scheduler — `serve()` reconciles in onAppLive
 * against the gateway's persistent scheduler instance. Boots a real
 * git-store gateway with an injected spy scheduler and asserts a publish
 * triggers a reconcile carrying the scanned automation rows.
 */

import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type * as automation from '@centraid/automation';
import { serve, type GatewayServeHandle } from './serve.ts';
import type { GatewayPaths } from '../paths.ts';

let dataDir: string;
let handle: GatewayServeHandle;
let reconcileCalls: Array<{ rows: readonly automation.Row[] }>;
let started: number;

function pathsUnder(dir: string): GatewayPaths {
  return {
    vaultDir: path.join(dir, 'vault'),
    prefsFile: path.join(dir, 'prefs.json'),
  };
}

// A spy `automation.LocalScheduler` — records the rows each reconcile receives and
// never arms a real timer, so the test stays deterministic.
function stubScheduler(): automation.LocalScheduler {
  return {
    async register() {},
    async unregister() {},
    async list() {
      return [];
    },
    async reconcile(desired) {
      reconcileCalls.push({ rows: desired });
      return { added: [], updated: [], removed: [] };
    },
    nudge() {},
    start() {
      started += 1;
    },
    async stop() {},
  };
}

function bootstrapRejectingScheduler(): automation.LocalScheduler {
  return {
    async register() {},
    async unregister() {},
    async list() {
      return [];
    },
    async reconcile(desired) {
      if (desired.length > 0) throw new Error('cursor bootstrap failed');
      return { added: [], updated: [], removed: [] };
    },
    nudge() {},
    start() {},
    async stop() {},
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

const DATA_AUTOMATION_JSON = JSON.stringify({
  name: 'Brief',
  version: '0.1.0',
  enabled: true,
  prompt: 'record that a party changed',
  triggers: [{ kind: 'data', entities: ['core.party'] }],
  requires: {},
  vault: {
    purpose: 'dpv:ServiceProvision',
    scopes: [{ schema: 'core', table: 'party', verbs: 'read' }],
  },
  history: { keep: { count: 100 } },
  generated: { by: 'centraid-builder', at: '2026-01-01T00:00:00.000Z' },
});

beforeEach(async () => {
  dataDir = await tempDir(`gw-sched-${crypto.randomUUID()}-`);
  reconcileCalls = [];
  started = 0;
  handle = await serve({
    paths: pathsUnder(dataDir),
    scheduler: stubScheduler(),
  });
});

afterEach(async () => {
  await handle?.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function publishBrief(manifest = AUTOMATION_JSON, expectedStatus = 201): Promise<Response> {
  await fetch(`${handle.url}/centraid/_apps/_sessions`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1' }),
  });
  for (const [rel, content] of [
    ['app.json', APP_JSON],
    ['automations/brief/automation.json', manifest],
    [
      'automations/brief/handler.js',
      'export default async () => ({ summary: "party change observed" });\n',
    ],
  ] as const) {
    const res = await fetch(`${handle.url}/centraid/_apps/brief/files/${rel}?sessionId=s1`, {
      method: 'PUT',
      headers: auth(),
      body: content,
    });
    expect(res.status).toBe(200);
  }
  const pub = await fetch(`${handle.url}/centraid/_apps/brief/publish`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', message: 'add brief' }),
  });
  expect(pub.status).toBe(expectedStatus);
  return pub;
}

test('publishing an automation triggers a scheduler reconcile with the new rows', async () => {
  // Startup reconcile already ran (empty store). Record the baseline.
  await waitFor(() => reconcileCalls.length >= 1);
  const baseline = reconcileCalls.length;

  // Open a session, lay down an automation app, publish.
  await publishBrief();

  // The publish's onAppLive reconciled the scheduler with the new row.
  await waitFor(() => reconcileCalls.length > baseline);
  const last = reconcileCalls.at(-1)!;
  expect(last.rows.map((r) => r.ref)).toEqual(['brief/brief']);
  // The gateway started its scheduler exactly once, on boot.
  expect(started).toBe(1);
});

test('publish does not report ready when a data cursor bootstrap fails', async () => {
  await handle.close();
  handle = await serve({
    paths: pathsUnder(dataDir),
    scheduler: bootstrapRejectingScheduler(),
  });

  const response = await publishBrief(DATA_AUTOMATION_JSON, 500);
  expect(await response.text()).toContain('cursor bootstrap failed');
});

test('a committed watched entity fires a data automation in well under a second', async () => {
  // Exercise the real scheduler behind a live HTTP gateway, not the spy used
  // by the reconcile test above.
  await handle.close();
  handle = await serve({ paths: pathsUnder(dataDir) });
  await publishBrief(DATA_AUTOMATION_JSON);

  // Publishing awaits reconciliation, including the fresh watcher's
  // no-history cursor bootstrap, before the app is considered live.
  const plane = handle.vaults.current();
  const cursor = plane.db.journal
    .prepare(
      `SELECT value_json FROM automation_state
        WHERE automation_id = 'brief/brief' AND key = '__trigger:0:cursor'`,
    )
    .get();
  expect(cursor).toBeTruthy();
  const startedAt = Date.now();
  const outcome = plane.gateway.invoke(plane.ownerCredential, {
    command: 'core.add_party',
    input: { display_name: 'Doorbell Test' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('executed');
  expect(
    plane.db.journal
      .prepare(`SELECT count(*) AS n FROM consent_provenance WHERE entity_type = 'core.party'`)
      .get(),
  ).toMatchObject({ n: 1 });

  let runs: Array<{ runId: string; endedAt?: number; ok: boolean }> = [];
  const refreshRuns = async (): Promise<boolean> => {
    const response = await fetch(
      `${handle.url}/centraid/_automations/runs?ref=${encodeURIComponent('brief/brief')}`,
      { headers: auth() },
    );
    expect(response.status).toBe(200);
    runs = (
      (await response.json()) as {
        runs: Array<{ runId: string; endedAt?: number; ok: boolean }>;
      }
    ).runs;
    return runs.length > 0;
  };
  await waitFor(async () => {
    return refreshRuns();
  }, 900);

  expect(runs).toHaveLength(1);
  expect(Date.now() - startedAt).toBeLessThan(1_000);
  await waitFor(async () => {
    await refreshRuns();
    return runs[0]?.endedAt !== undefined;
  });
  expect(runs[0]?.ok).toBe(true);

  // A real burst of committed writes through the live gateway shares one
  // fixed nudge window and therefore one cursor-evaluation/fire pass.
  for (let i = 0; i < 8; i++) {
    const burst = plane.gateway.invoke(plane.ownerCredential, {
      command: 'core.add_party',
      input: { display_name: `Doorbell Burst ${i}` },
      purpose: 'dpv:ServiceProvision',
    });
    expect(burst.status).toBe('executed');
  }
  await waitFor(async () => {
    await refreshRuns();
    return runs.length === 2 && runs.every((run) => run.endedAt !== undefined);
  });
  expect(runs).toHaveLength(2);

  // Simulate a kill in the only recoverable mid-write window: journal
  // provenance is durable, but the process dies before the best-effort ring.
  // The injected scheduler deliberately drops that ring, then a normal
  // gateway restart consumes the persisted cursor and emits one catch-up
  // fire. The scheduler unit suite separately pins the minute-tick fallback
  // for the same persisted-cursor state.
  await handle.close();
  handle = await serve({ paths: pathsUnder(dataDir), scheduler: stubScheduler() });
  const droppedPlane = handle.vaults.current();
  const missed = droppedPlane.gateway.invoke(droppedPlane.ownerCredential, {
    command: 'core.add_party',
    input: { display_name: 'Restart Backstop Test' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(missed.status).toBe('executed');
  const missedProv = droppedPlane.db.journal
    .prepare(
      `SELECT prov_id FROM consent_provenance
        WHERE entity_type = 'core.party' ORDER BY prov_id DESC LIMIT 1`,
    )
    .get() as { prov_id: string };
  await handle.close();

  handle = await serve({ paths: pathsUnder(dataDir) });
  await waitFor(async () => {
    await refreshRuns();
    return runs.length === 3 && runs.every((run) => run.endedAt !== undefined);
  });
  expect(runs).toHaveLength(3);
  const recoveredCursor = handle.vaults
    .current()
    .db.journal.prepare(
      `SELECT value_json FROM automation_state
        WHERE automation_id = 'brief/brief' AND key = '__trigger:0:cursor'`,
    )
    .get() as { value_json: string };
  expect(JSON.parse(recoveredCursor.value_json)).toBe(missedProv.prov_id);
});
