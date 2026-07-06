// governance: allow-repo-hygiene file-size-limit one end-to-end suite over a single served gateway+vault fixture — the scenarios intentionally share state to test the plane as one surface
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

test('a granted app invoke executes without parking; the risk marker rides the receipt (issue #306)', async () => {
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
  // propose_event is medium risk — installing granted the scope, so it
  // executes; risk is a salience marker in the journal, not a park trigger.
  expect(outcome.ok).toBe(true);
  const executed = outcome.result as { status: string; receiptId: string };
  expect(executed.status).toBe('executed');
  expect(plane.listParked()).toHaveLength(0);
  const receipt = plane.db.journal
    .prepare('SELECT detail_json FROM consent_receipt WHERE receipt_id = ?')
    .get(executed.receiptId) as { detail_json: string };
  expect(JSON.parse(receipt.detail_json).risk).toBe('medium');
  const events = plane.db.vault.prepare('SELECT summary, status FROM core_event').all();
  expect(events).toEqual([{ summary: 'Design review', status: 'tentative' }]);
});

test('install-time scopes: enrolling grants the declared block, idempotently (issue #306)', async () => {
  const dir = await tempDir();
  const plane = openPlane(dir);
  const calendarId = seedCalendar(plane);

  // Installing IS the consent: no owner grant ceremony precedes the invoke.
  plane.ensureAppInstallGrant('planner', {
    purpose: 'dpv:ServiceProvision',
    scopes: [{ schema: 'schedule', verbs: 'read+act' }],
  });
  const outcome = await plane.bridgeFor('planner')({
    op: 'invoke',
    payload: {
      command: 'schedule.propose_event',
      input: {
        summary: 'Kickoff',
        dtstart: '2026-07-08T09:00:00Z',
        dtend: '2026-07-08T09:30:00Z',
        calendar_id: calendarId,
      },
    },
  });
  expect(outcome.ok).toBe(true);
  expect((outcome.result as { status: string }).status).toBe('executed');

  // Idempotent: re-running with the same block mints no second grant.
  const before = plane.listApps().find((a) => a.name === 'planner')?.grants.length;
  plane.ensureAppInstallGrant('planner', {
    purpose: 'dpv:ServiceProvision',
    scopes: [{ schema: 'schedule', verbs: 'read+act' }],
  });
  const after = plane.listApps().find((a) => a.name === 'planner')?.grants.length;
  expect(after).toBe(before);
  // A widened declaration no longer auto-grants (issue #308 A3): agents
  // author their own manifests, so the ask parks as a blocking request.
  plane.ensureAppInstallGrant('planner', {
    scopes: [
      { schema: 'schedule', verbs: 'read+act' },
      { schema: 'knowledge', verbs: 'read' },
    ],
  });
  const widened = plane.listApps().find((a) => a.name === 'planner');
  expect(widened?.grants.flatMap((g) => g.scopes) ?? []).toHaveLength(1);
  const requests = plane.listScopeRequests();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    plane: 'app',
    appId: 'planner',
    scopes: [{ schema: 'knowledge', verbs: 'read' }],
  });
  expect(plane.blocking().scopeRequests).toHaveLength(1);

  // The owner's approval mints exactly the asked scopes and closes the ask.
  plane.decideScopeRequest(requests[0]!.requestId, true);
  const approved = plane.listApps().find((a) => a.name === 'planner');
  expect(approved?.grants.flatMap((g) => g.scopes) ?? []).toHaveLength(2);
  expect(plane.listScopeRequests()).toHaveLength(0);
  // With the grant landed, the same manifest asks for nothing more.
  plane.ensureAppInstallGrant('planner', {
    scopes: [
      { schema: 'schedule', verbs: 'read+act' },
      { schema: 'knowledge', verbs: 'read' },
    ],
  });
  expect(plane.listScopeRequests()).toHaveLength(0);

  // The agent-plane mirror covers automations.
  plane.ensureAgentInstallGrant('gmail-send', {
    scopes: [{ schema: 'outbox', verbs: 'act' }],
  });
  const agents = plane.listAgents();
  expect(agents.find((a) => a.name === 'gmail-send')?.grants).toHaveLength(1);

  // The consent surface renders what was granted, salience included.
  const surface = plane.scopeSurface('planner');
  expect(surface.scopes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ plane: 'app', schema: 'schedule', verbs: 'read+act' }),
    ]),
  );
  expect(surface.highlights.some((h) => h.schema === 'schedule')).toBe(true);
});

test('owner narrowing is durable: a revoked grant is not re-minted by the top-up (issue #308 A4)', async () => {
  const dir = await tempDir();
  const plane = openPlane(dir);
  const block = {
    purpose: 'dpv:ServiceProvision',
    scopes: [{ schema: 'schedule', verbs: 'read+act' as const }],
  };
  plane.ensureAppInstallGrant('planner', block);
  const granted = plane.listApps().find((a) => a.name === 'planner');
  expect(granted?.grants).toHaveLength(1);

  // The owner tightens: revoke the install grant.
  plane.revokeGrant(granted!.grants[0]!.grantId);
  expect(plane.listApps().find((a) => a.name === 'planner')?.grants).toHaveLength(0);

  // Mount/sync/publish re-run the top-up — the revocation survives all of
  // them: no re-mint, and no nagging scope request either (the owner said no).
  plane.ensureAppInstallGrant('planner', block);
  plane.ensureAppInstallGrant('planner', block);
  expect(plane.listApps().find((a) => a.name === 'planner')?.grants).toHaveLength(0);
  expect(plane.listScopeRequests()).toHaveLength(0);

  // Only an explicit owner approval brings the scope back…
  plane.approveGrant('planner', block);
  expect(plane.listApps().find((a) => a.name === 'planner')?.grants).toHaveLength(1);
  // …and from then on the top-up treats it as consented again.
  plane.ensureAppInstallGrant('planner', block);
  expect(plane.listApps().find((a) => a.name === 'planner')?.grants).toHaveLength(1);
});

test('a denied scope request stops re-asking; uninstall wipes the memory (issue #308 A3/A4)', async () => {
  const dir = await tempDir();
  const plane = openPlane(dir);
  plane.ensureAppInstallGrant('planner', {
    scopes: [{ schema: 'schedule', verbs: 'read+act' }],
  });
  const widenedBlock = {
    scopes: [
      { schema: 'schedule', verbs: 'read+act' as const },
      { schema: 'knowledge', verbs: 'read' as const },
    ],
  };
  plane.ensureAppInstallGrant('planner', widenedBlock);
  const request = plane.listScopeRequests()[0]!;
  plane.decideScopeRequest(request.requestId, false);
  expect(plane.listScopeRequests()).toHaveLength(0);
  // The same manifest on the next mount does not re-ask — denial tombstoned it.
  plane.ensureAppInstallGrant('planner', widenedBlock);
  expect(plane.listScopeRequests()).toHaveLength(0);
  expect(plane.listApps().find((a) => a.name === 'planner')?.grants).toHaveLength(1);

  // Uninstall wipes tombstones and open requests: reinstalling is a fresh
  // install-time consent for whatever the manifest then declares.
  plane.revokeApp('planner');
  plane.ensureAppInstallGrant('planner', widenedBlock);
  const reinstalled = plane.listApps().find((a) => a.name === 'planner');
  expect(reinstalled?.grants.flatMap((g) => g.scopes)).toHaveLength(2);
  expect(plane.listScopeRequests()).toHaveLength(0);
});

test('the agent plane mirrors the widening park (issue #308 A3)', async () => {
  const dir = await tempDir();
  const plane = openPlane(dir);
  plane.ensureAgentInstallGrant('gmail-send', {
    scopes: [{ schema: 'outbox', verbs: 'act' }],
  });
  expect(plane.listAgents().find((a) => a.name === 'gmail-send')?.grants).toHaveLength(1);
  plane.ensureAgentInstallGrant('gmail-send', {
    scopes: [
      { schema: 'outbox', verbs: 'act' },
      { schema: 'social', verbs: 'read+act' },
    ],
  });
  const requests = plane.listScopeRequests();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ plane: 'agent', appId: 'gmail-send' });
  plane.decideScopeRequest(requests[0]!.requestId, true);
  const scopes = plane.listAgents().find((a) => a.name === 'gmail-send')?.grants.flatMap((g) => g.scopes);
  expect(scopes).toHaveLength(2);
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
  const plane = registry.current();
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
  expect(status).toMatchObject({ vaultId: plane.boot.vaultId });

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

  // Park an invocation through the bridge, confirm it over HTTP. Parking
  // is confirm-gated (issue #306): mark the command loud-on-purpose first.
  plane.db.vault
    .prepare(
      `UPDATE agent_capability SET requires_confirmation=1
        WHERE command_id = (SELECT command_id FROM agent_command WHERE name='schedule.propose_event')`,
    )
    .run();
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

  // An app parks a confirm-gated booking request (issue #306: parking is a
  // property of the command, not of risk)…
  plane.enrollApp('bookings');
  plane.approveGrant('bookings', {
    purpose: 'dpv:ServiceProvision',
    scopes: [{ schema: 'schedule', verbs: 'read+act' }],
  });
  plane.db.vault
    .prepare(
      `UPDATE agent_capability SET requires_confirmation=1
        WHERE command_id = (SELECT command_id FROM agent_command WHERE name='schedule.propose_event')`,
    )
    .run();
  const appBridge = plane.bridgeFor('bookings');
  // …a write that, once confirmed, lands in the agent's feed.
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

test('cross-referencing (issue #272): shell pick → owner link → app resolves the far end without a scope', async () => {
  const dir = await tempDir();
  const plane = openPlane(dir);
  const owner = plane.ownerCredential;
  const purpose = 'dpv:ServiceProvision';
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

  // The owner's vault holds a note and a photo (two different domains).
  const note = plane.gateway.invoke(owner, {
    command: 'knowledge.create_note',
    input: { title: 'Trip plan', body_text: 'pack the camera' },
    purpose,
  });
  expect(note.status).toBe('executed');
  const noteId = (note as { output: { note_id: string } }).output.note_id;
  const photo = plane.gateway.invoke(owner, {
    command: 'media.add_asset',
    input: { data_uri: PNG, title: 'Beach sunset' },
    purpose,
  });
  expect(photo.status).toBe('executed');
  const assetId = (photo as { output: { asset_id: string } }).output.asset_id;

  // The shell picker finds both — term search rides FTS, browse rides pk order.
  const searched = plane.pickEntities({ term: 'trip' });
  expect(searched.cards.some((c) => c.type === 'knowledge.note' && c.id === noteId)).toBe(true);
  const browsed = plane.pickEntities({ kinds: ['media.media_asset'] });
  expect(browsed.cards).toHaveLength(1);
  expect(browsed.cards[0]).toMatchObject({
    type: 'media.media_asset',
    id: assetId,
    status: 'live',
  });

  // The pick is the consent: the shell asserts the link as the owner.
  const linked = plane.linkAsOwner({
    from_type: 'knowledge.note',
    from_id: noteId,
    to_type: 'media.media_asset',
    to_id: assetId,
  });
  expect(linked.status).toBe('executed');
  const linkId = (linked as { output: { link_id: string } }).output.link_id;

  // A notes-shaped app (knowledge + core.link read, NO media scope) renders
  // the photo's card through its own bridge via resolvable-if-linked.
  plane.enrollApp('notes');
  plane.approveGrant('notes', {
    purpose,
    scopes: [
      { schema: 'knowledge', verbs: 'read' },
      { schema: 'core', table: 'link', verbs: 'read' },
    ],
  });
  const bridge = plane.bridgeFor('notes');
  const resolved = await bridge({
    op: 'resolve',
    payload: { refs: [{ type: 'media.media_asset', id: assetId }], purpose },
  });
  expect(resolved.ok).toBe(true);
  const cards = (resolved.result as { cards: Array<Record<string, unknown>> }).cards;
  expect(cards[0]).toMatchObject({ status: 'live', title: 'Beach sunset' });

  // The issue's acceptance test, revoke half: pull the app's grant and its
  // projections go dark — while the note, the photo and the link all remain
  // the owner's, untouched.
  const grants = plane.listApps().find((a) => a.name === 'notes')?.grants ?? [];
  expect(grants).toHaveLength(1);
  plane.revokeGrant(grants[0]!.grantId);
  const revoked = await bridge({
    op: 'resolve',
    payload: { refs: [{ type: 'media.media_asset', id: assetId }], purpose },
  });
  expect(revoked.ok).toBe(true);
  expect((revoked.result as { cards: Array<{ status: string }> }).cards[0]!.status).toBe('denied');
  const darkRead = await bridge({
    op: 'read',
    payload: { entity: 'knowledge.note', purpose },
  });
  expect(darkRead.ok).toBe(false);
  expect(darkRead.code).toBe('VAULT_CONSENT');
  const survivors = plane.db.vault
    .prepare(
      `SELECT (SELECT count(*) FROM knowledge_note WHERE note_id = ?)
            + (SELECT count(*) FROM media_media_asset WHERE asset_id = ?)
            + (SELECT count(*) FROM core_link WHERE link_id = ? AND valid_to IS NULL) AS n`,
    )
    .get(noteId, assetId, linkId) as { n: number };
  expect(survivors.n).toBe(3);

  // Re-grant, then end the link: unlink ends the authorization too.
  plane.approveGrant('notes', {
    purpose,
    scopes: [
      { schema: 'knowledge', verbs: 'read' },
      { schema: 'core', table: 'link', verbs: 'read' },
    ],
  });
  const unlinked = plane.unlinkAsOwner(linkId);
  expect(unlinked.status).toBe('executed');
  const dark = await bridge({
    op: 'resolve',
    payload: { refs: [{ type: 'media.media_asset', id: assetId }], purpose },
  });
  expect(dark.ok).toBe(true);
  expect((dark.result as { cards: Array<{ status: string }> }).cards[0]!.status).toBe('denied');
});

test('owner routes (issue #272): picker searches, POST links asserts, DELETE ends', async () => {
  const dir = await tempDir();
  const registry = openVaultRegistry({ rootDir: dir, logger: silentLogger, ownerName: 'Priya' });
  cleanups.push(() => registry.stop());
  const plane = registry.current();
  const purpose = 'dpv:ServiceProvision';
  const note = plane.gateway.invoke(plane.ownerCredential, {
    command: 'knowledge.create_note',
    input: { title: 'Camera shopping', body_text: 'compare mirrorless bodies' },
    purpose,
  });
  const noteId = (note as { output: { note_id: string } }).output.note_id;
  const task = plane.gateway.invoke(plane.ownerCredential, {
    command: 'schedule.add_task',
    input: { title: 'Visit the camera store' },
    purpose,
  });
  const taskId = (task as { output: { task_id: string } }).output.task_id;

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

  // Term search hits both kinds through their FTS indexes.
  const picked = (await (await fetch(`${base}/picker?term=camera`)).json()) as {
    cards: Array<{ type: string; id: string; title: string }>;
  };
  expect(picked.cards.some((c) => c.type === 'knowledge.note' && c.id === noteId)).toBe(true);
  expect(picked.cards.some((c) => c.type === 'schedule.task' && c.id === taskId)).toBe(true);

  // POST /links asserts the picked relationship as the owner.
  const linkRes = await fetch(`${base}/links`, {
    method: 'POST',
    body: JSON.stringify({
      from_type: 'knowledge.note',
      from_id: noteId,
      to_type: 'schedule.task',
      to_id: taskId,
    }),
  });
  expect(linkRes.status).toBe(200);
  const linked = (await linkRes.json()) as { status: string; output: { link_id: string } };
  expect(linked.status).toBe('executed');
  const row = plane.db.vault
    .prepare('SELECT asserted_by, valid_to FROM core_link WHERE link_id = ?')
    .get(linked.output.link_id) as { asserted_by: string; valid_to: string | null };
  expect(row).toMatchObject({ asserted_by: 'owner', valid_to: null });

  // A malformed body is a 400, not a crash.
  const bad = await fetch(`${base}/links`, { method: 'POST', body: JSON.stringify({}) });
  expect(bad.status).toBe(400);

  // DELETE /links/<id> end-dates — temporal, the row survives.
  const unlinkRes = await fetch(`${base}/links/${linked.output.link_id}`, { method: 'DELETE' });
  expect(unlinkRes.status).toBe(200);
  expect(((await unlinkRes.json()) as { status: string }).status).toBe('executed');
  const ended = plane.db.vault
    .prepare('SELECT valid_to FROM core_link WHERE link_id = ?')
    .get(linked.output.link_id) as { valid_to: string | null };
  expect(ended.valid_to).not.toBeNull();
});

test('invokeAsAssistant: low-risk executes under a standing grant, high-risk parks (#286 phase 2)', async () => {
  const dir = await tempDir();
  const plane = openPlane(dir);

  // First use mints the `_assistant` agent + its standing act grant.
  const created = plane.invokeAsAssistant({
    command: 'knowledge.create_note',
    input: { title: 'From the assistant', body_text: 'hello' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(created.status).toBe('executed');

  // Second call reuses the enrollment — no duplicate agent/grant rows.
  const again = plane.invokeAsAssistant({
    command: 'knowledge.create_note',
    input: { title: 'Second', body_text: 'again' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(again.status).toBe('executed');
  const agents = plane.db.vault.prepare(`SELECT count(*) AS n FROM agent_agent`).get() as {
    n: number;
  };
  expect(agents.n).toBe(1);

  // High risk exceeds the agent's structural medium ceiling → parks for
  // the owner in the existing approval surface.
  const risky = plane.invokeAsAssistant({
    command: 'social.send_message',
    input: { message_id: 'not-yet-real' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(risky.status).toBe('parked');
  expect(plane.listParked().some((p) => p.command === 'social.send_message')).toBe(true);
});
