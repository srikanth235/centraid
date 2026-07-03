import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { ensureAppEnrolled, uuidv7 } from '@centraid/vault';
import { Dispatcher, Registry } from '@centraid/app-engine';
import { openVaultPlane, type VaultPlane } from './vault-plane.js';
import { openVaultRegistry } from './vault-registry.js';
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

test('search op rides both bridges: FTS match vault-side, consent still one door', async () => {
  const dir = await tempDir();
  const plane = openPlane(dir);
  plane.db.vault
    .prepare(
      `INSERT INTO schedule_task (task_id, owner_party_id, title, description, status, priority)
       VALUES (?, ?, 'Chase the budget approval', 'ping finance about the Q3 budget', 'needs-action', 5)`,
    )
    .run(uuidv7(), plane.boot.ownerPartyId);

  plane.enrollApp('tasks');
  const appBridge = plane.bridgeFor('tasks');
  const deniedApp = await appBridge({
    op: 'search',
    payload: { entity: 'schedule.task', query: 'budget', purpose: 'dpv:ServiceProvision' },
  });
  expect(deniedApp.ok).toBe(false);
  expect(deniedApp.code).toBe('VAULT_CONSENT');
  plane.approveGrant('tasks', {
    purpose: 'dpv:ServiceProvision',
    scopes: [{ schema: 'schedule', verbs: 'read' }],
  });
  const appHit = await appBridge({
    op: 'search',
    payload: { entity: 'schedule.task', query: 'budg', purpose: 'dpv:ServiceProvision' },
  });
  expect(appHit.ok).toBe(true);
  const appRows = (appHit.result as { rows: Record<string, unknown>[] }).rows;
  expect(appRows).toHaveLength(1);
  expect(String(appRows[0]?._snippet)).toContain('⟦budget⟧');

  plane.enrollAutomationAgent('chaser');
  plane.approveAgentGrant('chaser', {
    purpose: 'dpv:ServiceProvision',
    scopes: [{ schema: 'schedule', verbs: 'read' }],
  });
  const agentHit = await plane.agentBridgeFor('chaser')({
    op: 'search',
    payload: { entity: 'schedule.task', query: 'finance budget', purpose: 'dpv:ServiceProvision' },
  });
  expect(agentHit.ok).toBe(true);
  expect((agentHit.result as { rows: unknown[] }).rows).toHaveLength(1);
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
  // The route handler speaks to the registry; the acts land on its active plane.
  const registry = openVaultRegistry({ rootDir: dir, logger: silentLogger, ownerName: 'Priya' });
  cleanups.push(() => registry.stop());
  const plane = registry.active();
  const calendarId = seedCalendar(plane);
  plane.enrollApp('planner');
  const handler = makeVaultRouteHandler(registry);
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
  // The wire carries WHO and WHAT so the desktop confirmation UI can
  // render "planner wants schedule.propose_event: …" (issue: consent UX).
  expect(parkedList.parked[0]).toMatchObject({
    invocationId,
    command: 'schedule.propose_event',
    callerKind: 'app',
    caller: 'planner',
    input: { summary: 'Owner check-in' },
  });
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

test('agent plane: deny-by-default → agent grant → allowed; high risk parks; uninstall goes dark', async () => {
  const dir = await tempDir();
  const plane = openPlane(dir);
  plane.enrollAutomationAgent('briefing');
  // Idempotent — the reconcile loop calls this on every settle.
  plane.enrollAutomationAgent('briefing');
  expect(plane.listAgents().filter((a) => a.name === 'briefing')).toHaveLength(1);

  const bridge = plane.agentBridgeFor('briefing');

  // Enrolled but ungranted: a receipted consent deny.
  const denied = await bridge({
    op: 'read',
    payload: { entity: 'schedule.task', purpose: 'dpv:ServiceProvision' },
  });
  expect(denied.ok).toBe(false);
  expect(denied.code).toBe('VAULT_CONSENT');

  plane.approveAgentGrant('briefing', {
    purpose: 'dpv:ServiceProvision',
    scopes: [
      { schema: 'schedule', verbs: 'read+act' },
      { schema: 'social', verbs: 'read+act' },
      { schema: 'core', table: 'party', verbs: 'read' },
    ],
  });
  expect(plane.listAgents().find((a) => a.name === 'briefing')?.grants).toHaveLength(1);

  const read = await bridge({
    op: 'read',
    payload: { entity: 'schedule.task', purpose: 'dpv:ServiceProvision' },
  });
  expect(read.ok).toBe(true);

  // A typed command executes under the agent identity (risk low).
  const invoked = await bridge({
    op: 'invoke',
    payload: {
      command: 'schedule.add_task',
      input: { title: 'follow up with the plumber' },
      purpose: 'dpv:ServiceProvision',
      invocationId: 'run-1:v0',
    },
  });
  expect(invoked.ok).toBe(true);
  expect(invoked.result).toMatchObject({ status: 'executed', invocationId: 'run-1:v0' });

  // Replay: the same invocationId returns the recorded outcome, no double write.
  const replayed = await bridge({
    op: 'invoke',
    payload: {
      command: 'schedule.add_task',
      input: { title: 'follow up with the plumber' },
      purpose: 'dpv:ServiceProvision',
      invocationId: 'run-1:v0',
    },
  });
  expect(replayed.ok).toBe(true);
  expect(replayed.result).toMatchObject({ status: 'replayed' });

  // Risk high > agent ceiling (medium): parks for the owner; the agent's own
  // parked surface lists it.
  const ownerParty = plane.boot.ownerPartyId;
  const draft = await bridge({
    op: 'invoke',
    payload: {
      command: 'social.draft_message',
      input: { recipient_party_id: ownerParty, body_text: 'your day, summarized' },
      purpose: 'dpv:ServiceProvision',
    },
  });
  expect(draft.ok).toBe(true);
  const messageId = (draft.result as { output: { message_id: string } }).output.message_id;
  const send = await bridge({
    op: 'invoke',
    payload: {
      command: 'social.send_message',
      input: { message_id: messageId },
      purpose: 'dpv:ServiceProvision',
    },
  });
  expect(send.ok).toBe(true);
  expect(send.result).toMatchObject({ status: 'parked' });
  const parked = await bridge({ op: 'parked', payload: {} });
  expect(parked.ok).toBe(true);
  expect(parked.result).toMatchObject([{ command: 'social.send_message', caller: 'briefing' }]);

  // Uninstall cascade covers the agent plane too.
  const revoked = plane.revokeApp('briefing');
  expect(revoked.grantsRevoked).toBeGreaterThan(0);
  const dark = await bridge({
    op: 'read',
    payload: { entity: 'schedule.task', purpose: 'dpv:ServiceProvision' },
  });
  expect(dark.ok).toBe(false);
  expect(dark.code).toBe('VAULT_NOT_ENROLLED');
});

test('agent changes feed + app parked surface ride the bridges', async () => {
  const dir = await tempDir();
  const plane = openPlane(dir);
  const calendarId = seedCalendar(plane);

  // Agent side: watch core.event through the consented change feed.
  plane.enrollAutomationAgent('reconciler');
  plane.approveAgentGrant('reconciler', {
    purpose: 'dpv:ServiceProvision',
    scopes: [
      { schema: 'schedule', verbs: 'read+act' },
      { schema: 'core', table: 'event', verbs: 'read' },
    ],
  });
  const agentBridge = plane.agentBridgeFor('reconciler');
  const bootstrap = await agentBridge({
    op: 'changes',
    payload: { entities: ['core.event'], purpose: 'dpv:ServiceProvision', cursor: null },
  });
  expect(bootstrap.ok).toBe(true);
  const cursor = (bootstrap.result as { cursor: string }).cursor;

  // An app parks a high-risk booking request…
  plane.enrollApp('bookings');
  plane.approveGrant('bookings', {
    purpose: 'dpv:ServiceProvision',
    scopes: [{ schema: 'schedule', verbs: 'read+act' }],
  });
  const appBridge = plane.bridgeFor('bookings');
  // …after a low-risk write that lands in the agent's feed.
  const proposed = await appBridge({
    op: 'invoke',
    payload: {
      command: 'schedule.propose_event',
      input: {
        summary: 'Client call',
        dtstart: '2026-09-01T10:00:00Z',
        dtend: '2026-09-01T10:30:00Z',
        calendar_id: calendarId,
      },
      purpose: 'dpv:ServiceProvision',
    },
  });
  expect(proposed.ok).toBe(true);
  expect((proposed.result as { status: string }).status).toBe('parked');

  // The parked op shows the app ITS pending approval (issue #260 seam).
  const parked = await appBridge({ op: 'parked', payload: {} });
  expect(parked.ok).toBe(true);
  expect(parked.result).toMatchObject([{ command: 'schedule.propose_event', caller: 'bookings' }]);

  // Owner confirms → the write lands → the agent's next pull sees it.
  const invocationId = (parked.result as Array<{ invocationId: string }>)[0]!.invocationId;
  const confirmed = plane.confirmParked(invocationId, true);
  expect(confirmed.status).toBe('executed');
  const pull = await agentBridge({
    op: 'changes',
    payload: { entities: ['core.event'], purpose: 'dpv:ServiceProvision', cursor },
  });
  expect(pull.ok).toBe(true);
  const changes = (pull.result as { changes: Array<{ entity: string }> }).changes;
  expect(changes.some((c) => c.entity === 'core.event')).toBe(true);
});
