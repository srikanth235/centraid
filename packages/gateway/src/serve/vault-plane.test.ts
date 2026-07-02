import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { ensureAppEnrolled, uuidv7 } from '@centraid/vault';
import { Dispatcher, Registry } from '@centraid/app-engine';
import { openVaultPlane, type VaultPlane } from './vault-plane.js';
import { makeVaultRouteHandler } from '../routes/vault-routes.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `vault-plane-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function openPlane(dir: string): VaultPlane {
  const plane = openVaultPlane({ dir, logger: silentLogger, ownerName: 'Priya' });
  cleanups.push(() => plane.stop());
  return plane;
}

function seedCalendar(plane: VaultPlane): string {
  const id = uuidv7();
  plane.db.vault
    .prepare(
      `INSERT INTO schedule_calendar (calendar_id, owner_party_id, name, default_tz, visibility)
       VALUES (?, ?, 'Personal', 'Asia/Kolkata', 'private')`,
    )
    .run(id, plane.boot.ownerPartyId);
  return id;
}

test('deny-by-default → owner grant → allowed → uninstall goes dark', async () => {
  const dir = await tempDir();
  const plane = openPlane(dir);
  plane.enrollApp('planner');
  const bridge = plane.bridgeFor('planner');

  // Enrolled but ungranted: a receipted consent deny, not a hang or a leak.
  const denied = await bridge({
    op: 'read',
    payload: { entity: 'core.event', purpose: 'dpv:ServiceProvision' },
  });
  expect(denied.ok).toBe(false);
  expect(denied.code).toBe('VAULT_CONSENT');
  expect(denied.error).toContain('receipt');

  // The owner approves the manifest-declared scopes.
  plane.approveGrant('planner', {
    purpose: 'dpv:ServiceProvision',
    scopes: [
      { schema: 'schedule', verbs: 'read+act' },
      { schema: 'core', table: 'event', verbs: 'read' },
    ],
  });
  const allowed = await bridge({
    op: 'read',
    payload: { entity: 'core.event', purpose: 'dpv:ServiceProvision' },
  });
  expect(allowed.ok).toBe(true);
  expect(allowed.result).toMatchObject({ rows: [] });

  // Uninstall: grants revoked (cascade), identity retired, calls go dark.
  const revoked = plane.revokeApp('planner');
  expect(revoked.grantsRevoked).toBe(1);
  const dark = await bridge({
    op: 'read',
    payload: { entity: 'core.event', purpose: 'dpv:ServiceProvision' },
  });
  expect(dark.ok).toBe(false);
  expect(dark.code).toBe('VAULT_NOT_ENROLLED');
});

test('an app invoke above its risk ceiling parks; the owner confirm releases it into the canon', async () => {
  const dir = await tempDir();
  const plane = openPlane(dir);
  const calendarId = seedCalendar(plane);
  plane.enrollApp('planner');
  plane.approveGrant('planner', {
    purpose: 'dpv:ServiceProvision',
    scopes: [{ schema: 'schedule', verbs: 'read+act' }],
  });

  const bridge = plane.bridgeFor('planner');
  const outcome = await bridge({
    op: 'invoke',
    payload: {
      command: 'schedule.propose_event',
      input: {
        summary: 'Design review',
        dtstart: '2026-07-04T09:00:00Z',
        dtend: '2026-07-04T09:30:00Z',
        calendar_id: calendarId,
      },
      purpose: 'dpv:ServiceProvision',
    },
  });
  // propose_event is medium risk; app ceiling defaults to low → parked.
  expect(outcome.ok).toBe(true);
  const parked = outcome.result as { status: string; invocationId: string };
  expect(parked.status).toBe('parked');
  expect(plane.listParked()).toHaveLength(1);

  const released = plane.confirmParked(parked.invocationId, true);
  expect(released.status).toBe('executed');
  const events = plane.db.vault.prepare('SELECT summary, status FROM core_event').all();
  expect(events).toEqual([{ summary: 'Design review', status: 'tentative' }]);
});

test('the plane survives a restart: same identity, grants intact, ctx.vault still works', async () => {
  const dir = await tempDir();
  const first = openVaultPlane({ dir, logger: silentLogger, ownerName: 'Priya' });
  expect(first.boot.fresh).toBe(true);
  // Enroll with a medium ceiling so the reopened plane executes directly.
  ensureAppEnrolled(first.db, 'planner', { riskCeiling: 'medium' });
  first.approveGrant('planner', {
    purpose: 'dpv:ServiceProvision',
    scopes: [{ schema: 'schedule', verbs: 'read+act' }],
  });
  const calendarId = seedCalendar(first);
  const vaultId = first.boot.vaultId;
  first.stop();
  first.stop(); // idempotent

  const second = openPlane(dir);
  expect(second.boot.fresh).toBe(false);
  expect(second.boot.vaultId).toBe(vaultId);
  const apps = second.listApps();
  expect(apps).toHaveLength(1);
  expect(apps[0]).toMatchObject({ name: 'planner' });
  expect(apps[0]?.grants).toHaveLength(1);

  const outcome = await second.bridgeFor('planner')({
    op: 'invoke',
    payload: {
      command: 'schedule.propose_event',
      input: {
        summary: 'Retro',
        dtstart: '2026-07-05T09:00:00Z',
        dtend: '2026-07-05T09:30:00Z',
        calendar_id: calendarId,
      },
      purpose: 'dpv:ServiceProvision',
    },
  });
  expect(outcome.ok).toBe(true);
  expect((outcome.result as { status: string }).status).toBe('executed');
});

test('owner routes: status, apps, grant, parked confirm, revoke', async () => {
  const dir = await tempDir();
  const plane = openPlane(dir);
  const calendarId = seedCalendar(plane);
  plane.enrollApp('planner');
  const handler = makeVaultRouteHandler(plane);
  const server = http.createServer((req, res) => {
    void handler(req, res).then((owned) => {
      if (!owned) {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  const base = `http://127.0.0.1:${addr.port}/centraid/_vault`;

  const status = await (await fetch(`${base}/status`)).json();
  expect(status).toMatchObject({ active: true, vaultId: plane.boot.vaultId });

  // Approve the requested scopes over HTTP — the owner act.
  const grantRes = await fetch(`${base}/apps/planner/grants`, {
    method: 'POST',
    body: JSON.stringify({
      purpose: 'dpv:ServiceProvision',
      scopes: [{ schema: 'schedule', verbs: 'read+act' }],
    }),
  });
  expect(grantRes.status).toBe(200);
  const { grantId } = (await grantRes.json()) as { grantId: string };

  const apps = (await (await fetch(`${base}/apps`)).json()) as {
    apps: Array<{ name: string; grants: unknown[] }>;
  };
  expect(apps.apps[0]).toMatchObject({ name: 'planner' });
  expect(apps.apps[0]?.grants).toHaveLength(1);

  // Park an invocation through the bridge, confirm it over HTTP.
  const parked = await plane.bridgeFor('planner')({
    op: 'invoke',
    payload: {
      command: 'schedule.propose_event',
      input: {
        summary: 'Owner check-in',
        dtstart: '2026-07-06T09:00:00Z',
        dtend: '2026-07-06T09:30:00Z',
        calendar_id: calendarId,
      },
      purpose: 'dpv:ServiceProvision',
    },
  });
  const invocationId = (parked.result as { invocationId: string }).invocationId;
  const parkedList = (await (await fetch(`${base}/parked`)).json()) as { parked: unknown[] };
  expect(parkedList.parked).toHaveLength(1);
  const confirm = await fetch(`${base}/parked/${invocationId}`, {
    method: 'POST',
    body: JSON.stringify({ approve: true }),
  });
  expect(confirm.status).toBe(200);
  expect(((await confirm.json()) as { status: string }).status).toBe('executed');

  // Revoke over HTTP; the app goes dark.
  const revoke = await fetch(`${base}/grants/${grantId}`, { method: 'DELETE' });
  expect(revoke.status).toBe(200);
  const dark = await plane.bridgeFor('planner')({
    op: 'read',
    payload: { entity: 'core.event', purpose: 'dpv:ServiceProvision' },
  });
  expect(dark.ok).toBe(false);

  // Bad grant bodies are refused.
  const bad = await fetch(`${base}/apps/planner/grants`, {
    method: 'POST',
    body: JSON.stringify({
      purpose: 'dpv:ServiceProvision',
      scopes: [{ schema: 's', verbs: 'write' }],
    }),
  });
  expect(bad.status).toBe(400);
});

test('full stack: a real handler file reaches the canon through ctx.vault', async () => {
  const dir = await tempDir();
  const plane = openPlane(dir);
  const calendarId = seedCalendar(plane);
  ensureAppEnrolled(plane.db, 'planner', { riskCeiling: 'medium' });
  plane.approveGrant('planner', {
    purpose: 'dpv:ServiceProvision',
    scopes: [{ schema: 'schedule', verbs: 'read+act' }],
  });

  // App code on disk, dispatched exactly as the runtime would.
  const codeRoot = await tempDir();
  const dataRoot = await tempDir();
  const appDir = path.join(codeRoot, 'planner');
  await fs.mkdir(path.join(appDir, 'actions'), { recursive: true });
  await fs.writeFile(
    path.join(appDir, 'app.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: 'planner',
      name: 'Planner',
      version: '0.1.0',
      actions: [
        {
          name: 'propose',
          confirmation: 'none',
          input: { type: 'object', properties: { summary: { type: 'string' } } },
        },
      ],
      queries: [],
      vault: {
        purpose: 'dpv:ServiceProvision',
        scopes: [{ schema: 'schedule', verbs: 'read+act' }],
      },
    }),
    'utf8',
  );
  await fs.writeFile(
    path.join(appDir, 'actions', 'propose.js'),
    `export default async ({ body, ctx }) => {
       const outcome = await ctx.vault.invoke({
         command: 'schedule.propose_event',
         input: {
           summary: body?.summary,
           dtstart: '2026-07-07T09:00:00Z',
           dtend: '2026-07-07T09:30:00Z',
           calendar_id: ${JSON.stringify(calendarId)},
         },
         purpose: 'dpv:ServiceProvision',
       });
       return { status: 200, body: outcome };
     };\n`,
    'utf8',
  );
  const registry = new Registry(dataRoot);
  await registry.load();
  await registry.ensureUploaded('planner');
  const dispatcher = new Dispatcher({
    registry,
    codeDirOverride: async (appId) => path.join(codeRoot, appId),
    vaultFor: (appId) => plane.bridgeFor(appId),
  });

  const out = await dispatcher.write({
    app: 'planner',
    action: 'propose',
    input: { summary: 'Cross-plane standup' },
  });
  expect(out.isError).toBe(false);
  expect(out.structuredContent).toMatchObject({ status: 'executed' });
  const events = plane.db.vault.prepare('SELECT summary FROM core_event').all();
  expect(events).toEqual([{ summary: 'Cross-plane standup' }]);
  // The write is receipted and attributed to the app, not the owner.
  const receipts = plane.db.journal
    .prepare(
      `SELECT decision FROM consent_receipt WHERE action = 'act schedule.propose_event' AND decision = 'allow'`,
    )
    .all();
  expect(receipts.length).toBe(1);
});

test('sweep clock: expired grants lapse on the interval', async () => {
  const dir = await tempDir();
  const plane = openPlane(dir);
  plane.enrollApp('planner');
  plane.approveGrant('planner', {
    purpose: 'dpv:ServiceProvision',
    scopes: [{ schema: 'schedule', verbs: 'read' }],
    expiresAt: '2020-01-01T00:00:00Z',
  });
  expect(plane.listApps()[0]?.grants).toHaveLength(1);
  const result = plane.sweep();
  expect(result.grantsExpired).toBe(1);
  expect(plane.listApps()[0]?.grants).toHaveLength(0);
});
