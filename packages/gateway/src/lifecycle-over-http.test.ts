/*
 * Gateway-owned app lifecycle over HTTP (issue #141, Phase 2). The
 * deterministic builder — scaffold / clone / update-meta / automation
 * create+toggle+delete — moved off the desktop and into the gateway, so
 * the renderer states intent and the gateway does the work (scaffolders,
 * webhook minting, session writes, publish). This boots a real git-store
 * gateway and drives those endpoints end to end:
 *
 *   - create stages a draft (no `main` entry, registered + previewable),
 *     and `publish:true` lands it on `main`;
 *   - automation create mints a webhook secret (returned once) and the
 *     toggled/deleted automation flows through publish.
 */

import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
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

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${handle.token}`, ...extra };
}

async function listApps(): Promise<Array<{ id: string; name?: string; kind?: string }>> {
  const res = await fetch(`${handle.url}/centraid/_apps`, { headers: auth() });
  assert.equal(res.status, 200);
  return (await res.json()) as Array<{ id: string; name?: string; kind?: string }>;
}

async function listSessions(): Promise<string[]> {
  const res = await fetch(`${handle.url}/centraid/_apps/_sessions`, { headers: auth() });
  assert.equal(res.status, 200);
  return ((await res.json()) as { sessions: string[] }).sessions;
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `gw-lifecycle-${crypto.randomUUID()}-`));
  handle = await serve({
    paths: pathsUnder(dataDir),
    appsStoreRoot: path.join(dataDir, 'code'),
  });
});

afterEach(async () => {
  await handle?.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('POST /_apps stages a draft, and publish:true lands it on main', async () => {
  // Stage-only create: the app is registered (previewable) but NOT on `main`.
  const staged = await fetch(`${handle.url}/centraid/_apps`, {
    method: 'POST',
    headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: 'notes', name: 'Notes' }),
  });
  assert.equal(staged.status, 201);
  const stagedBody = (await staged.json()) as { sessionId: string; staged: boolean };
  assert.equal(stagedBody.staged, true);
  assert.ok(stagedBody.sessionId, 'a session id is returned for the draft');
  assert.ok(!(await listApps()).some((a) => a.id === 'notes'), 'staged app is not on main');

  // The staged draft serves through the runtime (issue #141 draft preview).
  const draft = await fetch(
    `${handle.url}/centraid/_draft/${stagedBody.sessionId}/notes/app.json`,
    { headers: auth() },
  );
  assert.equal(draft.status, 200, 'staged draft is previewable through the gateway');
  const manifest = (await draft.json()) as { id: string; name: string };
  assert.equal(manifest.id, 'notes');

  // Publishing a second create lands it on `main` and the home list shows it.
  const published = await fetch(`${handle.url}/centraid/_apps`, {
    method: 'POST',
    headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: 'tasks', name: 'Tasks', publish: true }),
  });
  assert.equal(published.status, 201);
  const pubBody = (await published.json()) as { staged: boolean };
  assert.equal(pubBody.staged, false);
  const apps = await listApps();
  const row = apps.find((a) => a.id === 'tasks');
  assert.ok(row, 'published app is on main');
  assert.equal(row?.name, 'Tasks');
});

test('POST /_apps rejects a collision with an app already on main', async () => {
  const first = await fetch(`${handle.url}/centraid/_apps`, {
    method: 'POST',
    headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: 'dup', name: 'Dup', publish: true }),
  });
  assert.equal(first.status, 201);
  const clash = await fetch(`${handle.url}/centraid/_apps`, {
    method: 'POST',
    headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: 'dup', name: 'Dup Again', publish: true }),
  });
  assert.equal(clash.status, 409);
  const err = (await clash.json()) as { error: string };
  assert.equal(err.error, 'already_exists');
});

test('POST /_apps/<id>/meta renames an app on main', async () => {
  await fetch(`${handle.url}/centraid/_apps`, {
    method: 'POST',
    headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: 'journal', name: 'Journal', publish: true }),
  });
  const res = await fetch(`${handle.url}/centraid/_apps/journal/meta`, {
    method: 'POST',
    headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name: 'Daily Journal', publish: true }),
  });
  assert.equal(res.status, 200);
  const row = (await listApps()).find((a) => a.id === 'journal');
  assert.equal(row?.name, 'Daily Journal');
});

test('POST /_automations mints a webhook secret and publishes the automation', async () => {
  const res = await fetch(`${handle.url}/centraid/_automations`, {
    method: 'POST',
    headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      id: 'inbound',
      name: 'Inbound',
      prompt: 'handle the hook',
      triggers: [{ kind: 'webhook' }],
      publish: true,
    }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    row: { ownerApp: string } | null;
    webhook?: { id: string; secret: string; url: string };
    staged: boolean;
  };
  assert.equal(body.staged, false);
  assert.ok(body.row, 'a row is read back from main after publish');
  assert.equal(body.row?.ownerApp, 'inbound');
  assert.ok(body.webhook, 'a webhook secret is minted and returned once');
  assert.ok(body.webhook!.secret.length > 0, 'plaintext secret present');
  assert.match(body.webhook!.url, /\/_centraid-hook\//);

  // The app is on `main`, marked as an automation app.
  const row = (await listApps()).find((a) => a.id === 'inbound');
  assert.equal(row?.kind, 'automation');
});

test('automation set-enabled then delete flows through publish', async () => {
  // Create disabled, then enable.
  await fetch(`${handle.url}/centraid/_automations`, {
    method: 'POST',
    headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      id: 'digest',
      name: 'Digest',
      prompt: 'summarize',
      triggers: [{ kind: 'cron', expr: '0 9 * * *' }],
      enabled: false,
      publish: true,
    }),
  });

  const enable = await fetch(
    `${handle.url}/centraid/_automations/set-enabled?ref=${encodeURIComponent('digest/digest')}`,
    {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ enabled: true, publish: true }),
    },
  );
  assert.equal(enable.status, 200);

  // Seed the app's data dir so the delete has real per-app data to tear
  // down (data.sqlite + run ledgers), not just the code on `main`.
  const dataAppDir = path.join(dataDir, 'apps', 'digest');
  await fs.mkdir(dataAppDir, { recursive: true });
  await fs.writeFile(path.join(dataAppDir, 'data.sqlite'), 'rows');

  // Delete the whole automation app — it disappears from `main`.
  const del = await fetch(
    `${handle.url}/centraid/_automations?ref=${encodeURIComponent('digest/digest')}&publish=true`,
    { method: 'DELETE', headers: auth() },
  );
  assert.equal(del.status, 200);
  const delBody = (await del.json()) as { deletedApp?: boolean };
  assert.equal(delBody.deletedApp, true);
  assert.ok(!(await listApps()).some((a) => a.id === 'digest'), 'deleted automation app is gone');

  // Finding A regression: the data dir is gone too — and NOT resurrected.
  // The old code called `ensureRegistered` after `deleteApp`, re-creating
  // the registry entry + data dir for the app just deleted; the fix
  // deregisters + cleans the data dir instead.
  await assert.rejects(
    fs.stat(dataAppDir),
    /ENOENT/,
    'data dir must be removed, not resurrected by a stray re-register',
  );
});

test('DELETE /_apps/<id> tears down the app data dir, not just the code', async () => {
  await fetch(`${handle.url}/centraid/_apps`, {
    method: 'POST',
    headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: 'shelf', name: 'Shelf', publish: true }),
  });
  // Seed the app's data dir (data.sqlite + ledgers live under appsDir).
  const dataAppDir = path.join(dataDir, 'apps', 'shelf');
  await fs.mkdir(dataAppDir, { recursive: true });
  await fs.writeFile(path.join(dataAppDir, 'data.sqlite'), 'rows');

  const del = await fetch(`${handle.url}/centraid/_apps/shelf`, {
    method: 'DELETE',
    headers: auth(),
  });
  assert.equal(del.status, 200);
  assert.ok(!(await listApps()).some((a) => a.id === 'shelf'), 'deleted app is off main');

  // Finding A regression: the wrapper dir under appsDir is removed, so a
  // recreated `shelf` cannot inherit stale rows/history.
  await assert.rejects(fs.stat(dataAppDir), /ENOENT/, 'app data dir must be cleaned on delete');
});

test('DELETE /_apps/<id> deletes a never-published draft without a no_changes error', async () => {
  // Stage-only create: the draft is registered + previewable but never
  // landed on `main`, so it has no code subtree there.
  const staged = await fetch(`${handle.url}/centraid/_apps`, {
    method: 'POST',
    headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: 'scratch', name: 'Scratch' }),
  });
  assert.equal(staged.status, 201);
  // Seed the draft's data dir the way ensureRegistered would.
  const dataAppDir = path.join(dataDir, 'apps', 'scratch');
  await fs.mkdir(dataAppDir, { recursive: true });
  await fs.writeFile(path.join(dataAppDir, 'data.sqlite'), 'rows');

  // Delete must succeed (idempotent) even though there's nothing on `main`.
  const del = await fetch(`${handle.url}/centraid/_apps/scratch`, {
    method: 'DELETE',
    headers: auth(),
  });
  assert.equal(del.status, 200, 'deleting a draft does not 400 with no_changes');
  const body = (await del.json()) as { deleted: boolean; codeRemoved: boolean };
  assert.equal(body.deleted, true);
  assert.equal(body.codeRemoved, false, 'a draft had no code on main to remove');
  // The teardown still ran: registry/data dir are cleaned.
  await assert.rejects(fs.stat(dataAppDir), /ENOENT/, 'draft data dir must be cleaned on delete');

  // A second DELETE of the same id is a clean no-op, not a failure.
  const again = await fetch(`${handle.url}/centraid/_apps/scratch`, {
    method: 'DELETE',
    headers: auth(),
  });
  assert.equal(again.status, 200, 're-deleting an already-gone app is idempotent');
});

test('a one-shot publish (no sessionId) closes its lifecycle session — no orphan worktree', async () => {
  // Scaffold + publish without supplying a sessionId: the gateway defaults to
  // `lifecycle-<id>`. That session is a one-shot — it must be closed once the
  // baseline lands, not left dangling (clone/create both ride this path).
  const res = await fetch(`${handle.url}/centraid/_apps`, {
    method: 'POST',
    headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: 'ledger', name: 'Ledger', publish: true }),
  });
  assert.equal(res.status, 201);
  assert.ok(
    (await listApps()).some((a) => a.id === 'ledger'),
    'app landed on main',
  );
  assert.ok(
    !(await listSessions()).includes('lifecycle-ledger'),
    'the one-shot lifecycle session must not linger after publish',
  );
});

test('an explicit (renderer) editing session is preserved across a publish', async () => {
  // The renderer passes its persistent `desktop-<id>` session; it must stay
  // open after publish so further edits keep staging into it.
  await fetch(`${handle.url}/centraid/_apps/_sessions`, {
    method: 'POST',
    headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ sessionId: 'desktop-board' }),
  });
  const res = await fetch(`${handle.url}/centraid/_apps`, {
    method: 'POST',
    headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: 'board', name: 'Board', sessionId: 'desktop-board', publish: true }),
  });
  assert.equal(res.status, 201);
  assert.ok(
    (await listSessions()).includes('desktop-board'),
    'an explicitly-supplied editing session must survive the publish',
  );
});

test('a one-shot publish opens fresh off main even when a stale lifecycle session orphan exists', async () => {
  // Simulate the pre-fix leak: a prior one-shot left `lifecycle-relics`
  // branched off an empty `main`, then `relics` got published + deleted, so
  // current `main` differs from that orphan's base.
  await fetch(`${handle.url}/centraid/_apps/_sessions`, {
    method: 'POST',
    headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ sessionId: 'lifecycle-relics' }),
  });
  assert.ok((await listSessions()).includes('lifecycle-relics'), 'orphan seeded');

  // Now create `relics` for real via the defaulting path. Pre-fix this hit
  // `session_exists` and reused the stale worktree; post-fix it opens fresh.
  const res = await fetch(`${handle.url}/centraid/_apps`, {
    method: 'POST',
    headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: 'relics', name: 'Relics', publish: true }),
  });
  assert.equal(res.status, 201, await res.text());
  assert.ok(
    (await listApps()).some((a) => a.id === 'relics'),
    'app published off a fresh session',
  );
  assert.ok(
    !(await listSessions()).includes('lifecycle-relics'),
    'the stale orphan is replaced and closed, not reused',
  );
});
