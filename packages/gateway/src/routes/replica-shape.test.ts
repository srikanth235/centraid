// governance: allow-repo-hygiene file-size-limit (#406) one end-to-end consent-shape suite shares the real vault-plane fixture across field, row, temporal, identity, projection, and retention invariants
import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openVaultPlane, type VaultPlane } from '../serve/vault-plane.js';
import { buildReplicaShapes, replicaShapesWire, shapeReplicaRow } from './replica-shape.js';
import { appendReplicaChange, currentReplicaLogState, readReplicaRow } from '@centraid/vault';
import { projectReplicaPage } from './replica-projection.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function plane(): Promise<VaultPlane> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `replica-shape-${crypto.randomUUID()}-`));
  const opened = openVaultPlane({ dir, logger, enableWalShipper: false });
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  cleanups.push(() => opened.stop());
  return opened;
}

function appCredential(
  vault: VaultPlane,
  name: string,
): {
  kind: 'app';
  appId: string;
  signingKey: string;
} {
  const app = vault.db.vault
    .prepare(`SELECT app_id, signing_key FROM consent_app WHERE name = ?`)
    .get(name) as { app_id: string; signing_key: string };
  return { kind: 'app', appId: app.app_id, signingKey: app.signing_key };
}

test('sealed names remain sticky metadata while values never enter a replica row', async () => {
  const vault = await plane();
  vault.approveGrant('passwords', {
    purpose: 'dpv:ServiceProvision',
    scopes: [{ schema: 'locker', table: 'item', verbs: 'read' }],
  });
  vault.db.vault
    .prepare(
      `INSERT INTO locker_item
         (item_id, type, title, username, password, compromised, created_at, updated_at)
       VALUES ('login-1', 'login', 'Example', 'alex', 'sealed-value', 0, ?, ?)`,
    )
    .run(new Date().toISOString(), new Date().toISOString());

  const [shape] = buildReplicaShapes(vault.db.vault, {
    trust: 'full',
    rememberDevice: true,
    appId: 'passwords',
  });
  const entity = replicaShapesWire([shape!])[0]!.entities.find(
    (candidate) => candidate.entity === 'locker.item',
  );
  expect(entity?.hasUnavailableFields).toBe(true);
  expect(entity?.columns).not.toContain('password');
  expect(JSON.stringify(replicaShapesWire([shape!]))).not.toContain('"password"');

  const row = readReplicaRow(vault.db.vault, 'locker.item', 'login-1')!;
  const shaped = shapeReplicaRow(shape!, 'locker.item', row)!;
  expect(shaped.values).toMatchObject({ title: 'Example', username: 'alex' });
  expect(shaped.values).not.toHaveProperty('password');
});

test('consent-masked columns remain sticky unavailable for local handler fallback', async () => {
  const vault = await plane();
  vault.approveGrant('tasks', {
    purpose: 'dpv:ServiceProvision',
    scopes: [
      {
        schema: 'schedule',
        table: 'task',
        verbs: 'read',
        fieldMask: ['task_id', 'title'],
      },
    ],
  });

  const shape = buildReplicaShapes(vault.db.vault, {
    trust: 'full',
    rememberDevice: true,
    appId: 'tasks',
  })[0]!;
  const task = replicaShapesWire([shape])[0]!.entities.find(
    (candidate) => candidate.entity === 'schedule.task',
  );

  expect(task).toMatchObject({
    columns: ['task_id', 'title'],
    hasUnavailableFields: true,
  });
  expect(JSON.stringify(task)).not.toContain('description');
});

test('unmasked shapes hide protocol credential names and values', async () => {
  const vault = await plane();
  vault.approveGrant('credential-auditor', {
    purpose: 'dpv:ServiceProvision',
    scopes: [
      { schema: 'consent', table: 'app', verbs: 'read' },
      { schema: 'agent', table: 'agent', verbs: 'read' },
      { schema: 'consent', table: 'device', verbs: 'read' },
    ],
  });
  vault.db.vault
    .prepare(
      `INSERT INTO consent_device
         (device_id, owner_party_id, name, public_key, trust, enrolled_at)
       VALUES ('credential-device', ?, 'Credential device', 'public-never-replicate',
               'full', '2026-07-15T00:00:00.000Z')`,
    )
    .run(vault.boot.ownerPartyId);
  vault.db.vault
    .prepare(
      `INSERT INTO core_party
         (party_id, kind, display_name, created_at, updated_at, ontology_version)
       VALUES ('credential-agent-party', 'agent', 'Credential agent',
               '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', '1.3')`,
    )
    .run();
  vault.db.vault
    .prepare(
      `INSERT INTO agent_agent
         (agent_id, party_id, host_key, model_ref, version, enrolled_at, status)
       VALUES ('credential-agent', 'credential-agent-party', 'host-never-replicate',
               'tier:fast', '1', '2026-07-15T00:00:00.000Z', 'active')`,
    )
    .run();

  const shape = buildReplicaShapes(vault.db.vault, {
    trust: 'full',
    rememberDevice: true,
    appId: 'credential-auditor',
  })[0]!;
  const wire = replicaShapesWire([shape])[0]!;
  for (const [entityName, credential] of [
    ['consent.app', 'signing_key'],
    ['agent.agent', 'host_key'],
    ['consent.device', 'public_key'],
  ] as const) {
    const entity = wire.entities.find((candidate) => candidate.entity === entityName);
    expect(entity?.hasUnavailableFields, entityName).toBe(true);
    expect(entity?.columns, entityName).not.toContain(credential);
  }
  expect(JSON.stringify(wire)).not.toMatch(/signing_key|host_key|public_key/);

  const app = vault.db.vault
    .prepare(`SELECT app_id FROM consent_app WHERE name = 'credential-auditor'`)
    .get() as { app_id: string };
  for (const [entity, rowId, credential] of [
    ['consent.app', app.app_id, 'signing_key'],
    ['agent.agent', 'credential-agent', 'host_key'],
    ['consent.device', 'credential-device', 'public_key'],
  ] as const) {
    const row = readReplicaRow(vault.db.vault, entity, rowId)!;
    expect(row.values, entity).not.toHaveProperty(credential);
    const shaped = shapeReplicaRow(shape, entity, row)!;
    expect(shaped.values, entity).not.toHaveProperty(credential);
  }
  expect(JSON.stringify(shape)).not.toMatch(/public-never-replicate/);
});

test('credential predicates and credential-only masks fail closed', async () => {
  const vault = await plane();
  vault.approveGrant('credential-filter', {
    purpose: 'dpv:ServiceProvision',
    scopes: [
      {
        schema: 'consent',
        table: 'app',
        verbs: 'read',
        rowFilter: [{ column: 'signing_key', op: 'eq', value: 'must-not-evaluate' }],
      },
    ],
  });
  vault.approveGrant('credential-mask', {
    purpose: 'dpv:ServiceProvision',
    scopes: [
      {
        schema: 'consent',
        table: 'app',
        verbs: 'read',
        fieldMask: ['signing_key'],
      },
    ],
  });

  for (const appId of ['credential-filter', 'credential-mask']) {
    const shape = buildReplicaShapes(vault.db.vault, {
      trust: 'full',
      rememberDevice: true,
      appId,
    })[0]!;
    expect(shape.entityMap.has('consent.app'), appId).toBe(false);
    expect(JSON.stringify(replicaShapesWire([shape])), appId).not.toContain('signing_key');
  }
});

test("keeps one app's purpose grants in independent row and column shapes", async () => {
  const vault = await plane();
  vault.approveGrant('planner', {
    purpose: 'dpv:ServiceProvision',
    scopes: [
      {
        schema: 'schedule',
        table: 'task',
        verbs: 'read',
        rowFilter: [{ column: 'status', op: 'eq', value: 'needs-action' }],
        fieldMask: ['task_id', 'title'],
      },
    ],
  });
  vault.approveGrant('planner', {
    purpose: 'dpv:Billing',
    scopes: [
      {
        schema: 'schedule',
        table: 'task',
        verbs: 'read',
        rowFilter: [{ column: 'priority', op: 'eq', value: 7 }],
        fieldMask: ['task_id', 'priority'],
      },
    ],
  });
  const insert = vault.db.vault.prepare(
    `INSERT INTO schedule_task
       (task_id, owner_party_id, title, status, priority)
     VALUES (?, ?, ?, ?, ?)`,
  );
  insert.run('service-task', vault.boot.ownerPartyId, 'Plan', 'needs-action', 0);
  insert.run('billing-task', vault.boot.ownerPartyId, 'Invoice', 'completed', 7);

  const shapes = buildReplicaShapes(vault.db.vault, {
    trust: 'full',
    rememberDevice: true,
    appId: 'planner',
  });
  const service = shapes.find((shape) => shape.purpose === 'dpv:ServiceProvision')!;
  const billing = shapes.find((shape) => shape.purpose === 'dpv:Billing')!;
  expect(
    replicaShapesWire(shapes)
      .map((shape) => shape.purpose)
      .sort(),
  ).toEqual(['dpv:Billing', 'dpv:ServiceProvision']);
  expect(service.entityMap.get('schedule.task')?.columns).toEqual(['task_id', 'title']);
  expect(billing.entityMap.get('schedule.task')?.columns).toEqual(['task_id', 'priority']);

  const serviceTask = readReplicaRow(vault.db.vault, 'schedule.task', 'service-task')!;
  const billingTask = readReplicaRow(vault.db.vault, 'schedule.task', 'billing-task')!;
  expect(shapeReplicaRow(service, 'schedule.task', serviceTask)?.values).toEqual({
    task_id: 'service-task',
    title: 'Plan',
  });
  expect(shapeReplicaRow(service, 'schedule.task', billingTask)).toBeUndefined();
  expect(shapeReplicaRow(billing, 'schedule.task', billingTask)?.values).toEqual({
    task_id: 'billing-task',
    priority: 7,
  });
  expect(shapeReplicaRow(billing, 'schedule.task', serviceTask)).toBeUndefined();
});

test('uses the exact first grant/scope selected by canonical online consent', async () => {
  const vault = await plane();
  vault.approveGrant('planner', {
    purpose: 'dpv:ServiceProvision',
    scopes: [
      {
        schema: 'schedule',
        table: 'task',
        verbs: 'read',
        rowFilter: [{ column: 'status', op: 'eq', value: 'needs-action' }],
        fieldMask: ['task_id', 'title'],
      },
    ],
  });
  vault.approveGrant('planner', {
    purpose: 'dpv:ServiceProvision',
    scopes: [
      {
        schema: 'schedule',
        table: 'task',
        verbs: 'read',
        rowFilter: [{ column: 'priority', op: 'eq', value: 7 }],
        fieldMask: ['task_id', 'priority'],
      },
    ],
  });
  vault.db.vault
    .prepare(
      `INSERT INTO schedule_task
         (task_id, owner_party_id, title, status, priority)
       VALUES ('both-grants', ?, 'Canonical first', 'needs-action', 7)`,
    )
    .run(vault.boot.ownerPartyId);

  const online = vault.gateway.read(appCredential(vault, 'planner'), {
    entity: 'schedule.task',
    purpose: 'dpv:ServiceProvision',
  });
  expect(online.rows).toEqual([{ task_id: 'both-grants', title: 'Canonical first' }]);

  const shape = buildReplicaShapes(vault.db.vault, {
    trust: 'full',
    rememberDevice: true,
    appId: 'planner',
  })[0]!;
  expect(shape.entityMap.get('schedule.task')?.columns).toEqual(['task_id', 'title']);
  const row = readReplicaRow(vault.db.vault, 'schedule.task', 'both-grants')!;
  expect(shapeReplicaRow(shape, 'schedule.task', row)?.values).toEqual(online.rows[0]);
});

test.each([
  {
    name: 'INTEGER 0 ne false',
    filter: { column: 'priority', op: 'ne' as const, value: false },
  },
  {
    name: "TEXT '1' ne numeric 1",
    filter: { column: 'title', op: 'ne' as const, value: 1 },
  },
])('matches canonical SQLite affinity for $name', async ({ filter }) => {
  const vault = await plane();
  vault.approveGrant('planner', {
    purpose: 'dpv:ServiceProvision',
    scopes: [
      {
        schema: 'schedule',
        table: 'task',
        verbs: 'read',
        rowFilter: [filter],
        fieldMask: ['task_id', 'title', 'priority'],
      },
    ],
  });
  vault.db.vault
    .prepare(
      `INSERT INTO schedule_task
         (task_id, owner_party_id, title, status, priority)
       VALUES ('affinity-row', ?, '1', 'needs-action', 0)`,
    )
    .run(vault.boot.ownerPartyId);
  const online = vault.gateway.read(appCredential(vault, 'planner'), {
    entity: 'schedule.task',
  });
  const shape = buildReplicaShapes(vault.db.vault, {
    trust: 'full',
    rememberDevice: true,
    appId: 'planner',
  })[0]!;
  const row = readReplicaRow(vault.db.vault, 'schedule.task', 'affinity-row')!;
  const replica = shapeReplicaRow(shape, 'schedule.task', row);
  expect(replica ? [replica.values] : []).toEqual(online.rows);
});

test('changes temporal shape identity exactly when a row enters and leaves its window', async () => {
  const vault = await plane();
  vault.approveGrant('planner', {
    purpose: 'dpv:ServiceProvision',
    scopes: [
      {
        schema: 'schedule',
        table: 'task',
        verbs: 'read',
        rowFilter: [{ column: 'due_at', op: 'within-next-days', value: 1 }],
      },
    ],
  });
  vault.db.vault
    .prepare(
      `INSERT INTO schedule_task
         (task_id, owner_party_id, title, status, priority, due_at)
       VALUES ('timed-task', ?, 'Due soon', 'needs-action', 0, '2026-07-10T00:00:00.000Z')`,
    )
    .run(vault.boot.ownerPartyId);
  const access = { trust: 'full' as const, rememberDevice: true, appId: 'planner' };
  const before = buildReplicaShapes(vault.db.vault, access, '2026-07-08T23:59:59.999Z')[0]!;
  const entered = buildReplicaShapes(vault.db.vault, access, '2026-07-09T00:00:00.000Z')[0]!;
  const leaving = buildReplicaShapes(vault.db.vault, access, '2026-07-10T00:00:00.000Z')[0]!;
  const left = buildReplicaShapes(vault.db.vault, access, '2026-07-10T00:00:00.001Z')[0]!;

  expect(entered.shapeId).not.toBe(before.shapeId);
  expect(left.shapeId).not.toBe(entered.shapeId);
  expect(left.shapeId).toBe(before.shapeId);
  expect(leaving.shapeId).toBe(entered.shapeId);
  const row = readReplicaRow(vault.db.vault, 'schedule.task', 'timed-task')!;
  expect(
    shapeReplicaRow(before, 'schedule.task', row, Date.parse('2026-07-08T23:59:59.999Z')),
  ).toBeUndefined();
  expect(
    shapeReplicaRow(entered, 'schedule.task', row, Date.parse('2026-07-09T00:00:00.000Z')),
  ).toBeDefined();
  expect(
    shapeReplicaRow(left, 'schedule.task', row, Date.parse('2026-07-10T00:00:00.001Z')),
  ).toBeUndefined();
});

test('expires within-days membership without requiring a database write', async () => {
  const vault = await plane();
  vault.approveGrant('planner', {
    purpose: 'dpv:ServiceProvision',
    scopes: [
      {
        schema: 'schedule',
        table: 'task',
        verbs: 'read',
        rowFilter: [{ column: 'completed_at', op: 'within-days', value: 1 }],
      },
    ],
  });
  vault.db.vault
    .prepare(
      `INSERT INTO schedule_task
         (task_id, owner_party_id, title, status, priority, completed_at)
       VALUES ('recent-task', ?, 'Just done', 'completed', 0, '2026-07-09T00:00:00.000Z')`,
    )
    .run(vault.boot.ownerPartyId);
  const access = { trust: 'full' as const, rememberDevice: true, appId: 'planner' };
  const watermark = currentReplicaLogState(vault.db.vault).watermark;
  const atBoundary = buildReplicaShapes(vault.db.vault, access, '2026-07-10T00:00:00.000Z')[0]!;
  const expired = buildReplicaShapes(vault.db.vault, access, '2026-07-10T00:00:00.001Z')[0]!;

  expect(expired.shapeId).not.toBe(atBoundary.shapeId);
  expect(currentReplicaLogState(vault.db.vault).watermark).toEqual(watermark);
  const row = readReplicaRow(vault.db.vault, 'schedule.task', 'recent-task')!;
  expect(
    shapeReplicaRow(atBoundary, 'schedule.task', row, Date.parse('2026-07-10T00:00:00.000Z')),
  ).toBeDefined();
  expect(
    shapeReplicaRow(expired, 'schedule.task', row, Date.parse('2026-07-10T00:00:00.001Z')),
  ).toBeUndefined();
});

test('omits an unrelated filtered delete without rebootstrap or row-id disclosure', async () => {
  const vault = await plane();
  vault.approveGrant('planner', {
    purpose: 'dpv:ServiceProvision',
    scopes: [
      {
        schema: 'schedule',
        table: 'task',
        verbs: 'read',
        rowFilter: [{ column: 'status', op: 'eq', value: 'completed' }],
      },
    ],
  });
  vault.db.vault
    .prepare(
      `INSERT INTO schedule_task
         (task_id, owner_party_id, title, status, priority)
       VALUES ('private-task-id', ?, 'Visible once', 'needs-action', 0)`,
    )
    .run(vault.boot.ownerPartyId);
  const since = currentReplicaLogState(vault.db.vault).watermark;
  vault.db.vault.prepare(`DELETE FROM schedule_task WHERE task_id = 'private-task-id'`).run();

  const projected = projectReplicaPage(
    vault.db.vault,
    { trust: 'full', rememberDevice: true, appId: 'planner' },
    since,
  );
  expect(projected.rebootstrapReason).toBeUndefined();
  expect(projected.batch.changes).toEqual([]);
  expect(projected.doorbell).toEqual([]);
  expect(JSON.stringify(projected)).not.toContain('private-task-id');
});

test('uses one stable opaque id through snapshot, update-out and delete', async () => {
  const vault = await plane();
  vault.approveGrant('planner', {
    purpose: 'dpv:ServiceProvision',
    scopes: [
      {
        schema: 'schedule',
        table: 'task',
        verbs: 'read',
        rowFilter: [{ column: 'status', op: 'eq', value: 'needs-action' }],
        fieldMask: ['title', 'description'],
      },
    ],
  });
  vault.db.vault
    .prepare(
      `INSERT INTO schedule_task
         (task_id, owner_party_id, title, description, status, priority)
       VALUES ('canonical-secret-id', ?, 'Visible', ?, 'needs-action', 0)`,
    )
    .run(vault.boot.ownerPartyId, 'x'.repeat(70_000));
  const access = { trust: 'full' as const, rememberDevice: true, appId: 'planner' };
  const shape = buildReplicaShapes(vault.db.vault, access)[0]!;
  const row = readReplicaRow(vault.db.vault, 'schedule.task', 'canonical-secret-id')!;
  const snapshot = shapeReplicaRow(shape, 'schedule.task', row)!;
  expect(snapshot.rowId).toMatch(/^r_[A-Za-z0-9_-]+$/);
  expect(snapshot.values.__centraid_row_id).toBe(snapshot.rowId);
  expect(JSON.stringify(snapshot)).not.toContain('canonical-secret-id');

  const since = currentReplicaLogState(vault.db.vault).watermark;
  vault.db.vault
    .prepare(`UPDATE schedule_task SET title = 'Updated' WHERE task_id = 'canonical-secret-id'`)
    .run();
  vault.db.vault
    .prepare(
      `UPDATE schedule_task SET title = 'Updated again' WHERE task_id = 'canonical-secret-id'`,
    )
    .run();
  const updated = projectReplicaPage(vault.db.vault, access, since);
  expect(updated.rebootstrapReason).toBeUndefined();
  expect(updated.batch.changes).toEqual([
    expect.objectContaining({ op: 'upsert', rowId: snapshot.rowId }),
  ]);
  expect(updated.doorbell).toHaveLength(1);
  expect(JSON.stringify(updated)).not.toContain('canonical-secret-id');

  vault.db.vault
    .prepare(`UPDATE schedule_task SET status = 'completed' WHERE task_id = 'canonical-secret-id'`)
    .run();
  const left = projectReplicaPage(vault.db.vault, access, updated.batch.to);
  expect(left.rebootstrapReason).toBeUndefined();
  expect(left.batch.changes).toEqual([
    expect.objectContaining({ op: 'delete', rowId: snapshot.rowId }),
  ]);
  expect(JSON.stringify(left)).not.toContain('canonical-secret-id');

  const afterExit = left.batch.to;
  vault.db.vault.prepare(`DELETE FROM schedule_task WHERE task_id = 'canonical-secret-id'`).run();
  const hiddenDelete = projectReplicaPage(vault.db.vault, access, afterExit);
  expect(hiddenDelete.rebootstrapReason).toBeUndefined();
  expect(hiddenDelete.batch.changes).toEqual([]);
  expect(JSON.stringify(hiddenDelete)).not.toContain('canonical-secret-id');
});

test('never serializes either component of a masked composite primary key', async () => {
  const vault = await plane();
  vault.approveGrant('tally', {
    purpose: 'dpv:ServiceProvision',
    scopes: [
      {
        schema: 'tally',
        table: 'expense_split',
        verbs: 'read',
        fieldMask: ['share_minor'],
      },
    ],
  });
  const now = new Date().toISOString();
  vault.db.vault
    .prepare(
      `INSERT INTO social_circle (circle_id, owner_party_id, name, kind)
       VALUES ('circle-secret', ?, 'Trip', 'friends')`,
    )
    .run(vault.boot.ownerPartyId);
  vault.db.vault
    .prepare(
      `INSERT INTO tally_group (group_id, circle_id, icon, color, created_at)
       VALUES ('group-secret', 'circle-secret', 'trip', 'blue', ?)`,
    )
    .run(now);
  vault.db.vault
    .prepare(
      `INSERT INTO tally_expense
         (expense_id, group_id, description, amount_minor, paid_by, spent_on, category, created_at)
       VALUES ('expense-secret', 'group-secret', 'Dinner', 100, ?, '2026-07-15', 'food', ?)`,
    )
    .run(vault.boot.ownerPartyId, now);
  vault.db.vault
    .prepare(
      `INSERT INTO tally_expense_split (expense_id, party_id, share_minor)
       VALUES ('expense-secret', ?, 100)`,
    )
    .run(vault.boot.ownerPartyId);

  const shape = buildReplicaShapes(vault.db.vault, {
    trust: 'full',
    rememberDevice: true,
    appId: 'tally',
  })[0]!;
  const canonical = JSON.stringify(['expense-secret', vault.boot.ownerPartyId]);
  const row = readReplicaRow(vault.db.vault, 'tally.expense_split', canonical)!;
  const shaped = shapeReplicaRow(shape, 'tally.expense_split', row)!;
  expect(shaped.rowId).toMatch(/^r_/);
  expect(shaped.values).toEqual({ __centraid_row_id: shaped.rowId, share_minor: 100 });
  expect(JSON.stringify(shaped)).not.toContain('expense-secret');
  expect(JSON.stringify(shaped)).not.toContain(vault.boot.ownerPartyId);
});

test('ordinary concepts tail incrementally instead of invalidating every shape', async () => {
  const vault = await plane();
  vault.approveGrant('planner', {
    purpose: 'dpv:ServiceProvision',
    scopes: [{ schema: 'schedule', table: 'task', verbs: 'read' }],
  });
  const since = currentReplicaLogState(vault.db.vault).watermark;
  vault.db.vault
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, version)
       VALUES ('ordinary-scheme', 'urn:ordinary', 'Ordinary', '1')`,
    )
    .run();
  vault.db.vault
    .prepare(
      `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label)
       VALUES ('ordinary-concept', 'ordinary-scheme', 'ordinary:Label', 'Ordinary')`,
    )
    .run();
  const projected = projectReplicaPage(
    vault.db.vault,
    { trust: 'full', rememberDevice: true, appId: 'planner' },
    since,
  );
  expect(projected.rebootstrapReason).toBeUndefined();
});

test('doorbells name only the shapes that received the projected row', async () => {
  const vault = await plane();
  vault.approveGrant('planner', {
    purpose: 'dpv:ServiceProvision',
    scopes: [{ schema: 'schedule', table: 'task', verbs: 'read' }],
  });
  vault.approveGrant('planner', {
    purpose: 'dpv:Billing',
    scopes: [
      {
        schema: 'schedule',
        table: 'task',
        verbs: 'read',
        rowFilter: [{ column: 'priority', op: 'eq', value: 7 }],
      },
    ],
  });
  const since = currentReplicaLogState(vault.db.vault).watermark;
  vault.db.vault
    .prepare(
      `INSERT INTO schedule_task
         (task_id, owner_party_id, title, status, priority)
       VALUES ('new-task', ?, 'Visible', 'needs-action', 0)`,
    )
    .run(vault.boot.ownerPartyId);

  const projected = projectReplicaPage(
    vault.db.vault,
    { trust: 'full', rememberDevice: true, appId: 'planner' },
    since,
  );
  const visibleShape = projected.shapes.find((shape) => shape.purpose === 'dpv:ServiceProvision')!;
  expect(projected.doorbell).toEqual([
    expect.objectContaining({
      rowId: 'new-task',
      shapeIds: [visibleShape.shapeId],
    }),
  ]);
});

test('the vault standing sweep enforces replica retention at startup', async () => {
  const vault = await plane();
  const old = appendReplicaChange(vault.db.vault, {
    entity: 'schedule.task',
    rowId: 'expired-row',
    op: 'update',
    changedAt: '2000-01-01T00:00:00.000Z',
  });

  vault.start();

  expect(currentReplicaLogState(vault.db.vault).floor.seq).toBeGreaterThanOrEqual(old.seq);
});

test('the photos grant yields a self-contained shape a native client can render from', async () => {
  const vault = await plane();
  // The photos app's read surface (issue #419): a native client renders the
  // whole library — assets, their bytes' metadata, derivatives, albums, faces,
  // places, tags — entirely from the replica, no online round trip.
  vault.approveGrant('photos', {
    purpose: 'dpv:ServiceProvision',
    scopes: [
      { schema: 'media', verbs: 'read' },
      { schema: 'core', table: 'content_item', verbs: 'read' },
      { schema: 'core', table: 'content_derivative', verbs: 'read' },
      { schema: 'core', table: 'collection', verbs: 'read' },
      { schema: 'core', table: 'collection_entry', verbs: 'read' },
      { schema: 'core', table: 'tag', verbs: 'read' },
      { schema: 'core', table: 'place', verbs: 'read' },
    ],
  });

  const shape = buildReplicaShapes(vault.db.vault, {
    trust: 'full',
    rememberDevice: true,
    appId: 'photos',
  })[0]!;
  const wire = replicaShapesWire([shape])[0]!;
  const byEntity = new Map(wire.entities.map((entity) => [entity.entity, entity]));

  // Every entity a native Photos client needs is present in the one shape.
  for (const entity of [
    'media.media_asset',
    'core.content_item',
    'core.content_derivative',
    'core.collection',
    'core.collection_entry',
    'media.face_region',
    'core.place',
    'core.tag',
  ]) {
    expect(byEntity.has(entity), `shape is missing ${entity}`).toBe(true);
  }

  // First-class asset state (issue #419) rides on media.media_asset itself.
  const asset = byEntity.get('media.media_asset')!;
  expect(asset.columns).toEqual(
    expect.arrayContaining(['favorite', 'archived_at', 'tz_offset_min', 'captured_at']),
  );
  // The bytes' identity/metadata rides on core.content_item.
  const content = byEntity.get('core.content_item')!;
  expect(content.columns).toEqual(
    expect.arrayContaining(['sha256', 'media_type', 'byte_size', 'title']),
  );
  // Derivatives (thumb/preview/poster + inline phash/thumbhash) carry the
  // variant and its inline text or CAS sha.
  const derivative = byEntity.get('core.content_derivative')!;
  expect(derivative.columns).toEqual(expect.arrayContaining(['variant', 'text_content', 'sha256']));
});

test('docs and agenda grants multiplex as additive self-contained native shapes', async () => {
  const vault = await plane();
  vault.approveGrant('docs', {
    purpose: 'dpv:ServiceProvision',
    scopes: [
      { schema: 'core', table: 'document', verbs: 'read' },
      { schema: 'core', table: 'content_item', verbs: 'read' },
      { schema: 'core', table: 'tag', verbs: 'read' },
      { schema: 'core', table: 'concept', verbs: 'read' },
      { schema: 'core', table: 'concept_scheme', verbs: 'read' },
      { schema: 'blob', table: 'custody_state', verbs: 'read' },
    ],
  });
  vault.approveGrant('agenda', {
    purpose: 'dpv:ServiceProvision',
    scopes: [
      { schema: 'schedule', verbs: 'read+act' },
      { schema: 'core', table: 'event', verbs: 'read' },
      { schema: 'core', table: 'party', verbs: 'read' },
    ],
  });

  const shapes = replicaShapesWire(
    buildReplicaShapes(vault.db.vault, { trust: 'full', rememberDevice: true }),
  );
  const docs = shapes.find((shape) => shape.appId === 'docs')!;
  const agenda = shapes.find((shape) => shape.appId === 'agenda')!;
  expect(docs.entities.map((entity) => entity.entity)).toEqual(
    expect.arrayContaining([
      'core.document',
      'core.content_item',
      'core.tag',
      'core.concept',
      'core.concept_scheme',
      'blob.custody_state',
    ]),
  );
  expect(agenda.entities.map((entity) => entity.entity)).toEqual(
    expect.arrayContaining([
      'core.event',
      'schedule.attendee',
      'schedule.calendar',
      'schedule.event_ext',
      'core.party',
    ]),
  );
  expect(new Set(shapes.map((shape) => shape.shapeId)).size).toBe(shapes.length);
});
