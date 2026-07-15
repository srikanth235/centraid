import { afterEach, expect, test } from 'vitest';
import { openVaultDb, type VaultDb } from '../db.js';
import { applyExtBand } from '../gateway/ext.js';
import type { ExtTableSpec } from '../schema/ext.js';
import { listVaultEntities, resolveEntity } from '../schema/tables.js';
import {
  appendReplicaChange,
  bumpReplicaEpoch,
  currentReplicaLogState,
  initializeReplicaProtocol,
  pruneReplicaChanges,
  readReplicaChanges,
  ReplicaRebootstrapRequiredError,
} from './change-log.js';
import { formatReplicaCursor, parseReplicaCursor } from './cursor.js';

let db: VaultDb | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

function open(): VaultDb {
  db = openVaultDb();
  return db;
}

function insertScheme(vault: VaultDb['vault'], id: string, title = id): void {
  vault
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, version)
       VALUES (?, ?, ?, '1')`,
    )
    .run(id, `urn:${id}`, title);
}

test('canonical inserts, updates and deletes append ordered durable operations', () => {
  const { vault } = open();
  insertScheme(vault, 'scheme-1', 'Before');
  vault
    .prepare(`UPDATE core_concept_scheme SET title = ? WHERE scheme_id = ?`)
    .run('After', 'scheme-1');
  vault.prepare(`DELETE FROM core_concept_scheme WHERE scheme_id = ?`).run('scheme-1');

  const page = readReplicaChanges(vault);
  expect(page.changes.map(({ seq, entity, rowId, op }) => ({ seq, entity, rowId, op }))).toEqual([
    { seq: 1, entity: 'core.concept_scheme', rowId: 'scheme-1', op: 'insert' },
    { seq: 2, entity: 'core.concept_scheme', rowId: 'scheme-1', op: 'update' },
    { seq: 3, entity: 'core.concept_scheme', rowId: 'scheme-1', op: 'delete' },
  ]);
  expect(page.changes[0]?.oldValuesJson).toBeNull();
  expect(JSON.parse(page.changes[1]!.oldValuesJson!)).toMatchObject({
    scheme_id: 'scheme-1',
    title: 'Before',
  });
  expect(JSON.parse(page.changes[2]!.oldValuesJson!)).toMatchObject({
    scheme_id: 'scheme-1',
    title: 'After',
  });
  expect(page.next).toEqual(page.watermark);
  expect(page.hasMore).toBe(false);
});

test('OLD snapshots structurally exclude sealed values', () => {
  const { vault } = open();
  const now = new Date().toISOString();
  vault
    .prepare(
      `INSERT INTO locker_item
         (item_id, type, title, username, password, compromised, created_at, updated_at)
       VALUES ('secret-item', 'login', 'Before', 'alex', 'never-log-me', 0, ?, ?)`,
    )
    .run(now, now);
  const since = currentReplicaLogState(vault).watermark;
  vault.prepare(`UPDATE locker_item SET title = 'After' WHERE item_id = 'secret-item'`).run();
  const [change] = readReplicaChanges(vault, { since }).changes;
  expect(change?.oldValuesJson).not.toContain('never-log-me');
  expect(JSON.parse(change!.oldValuesJson!)).toMatchObject({
    item_id: 'secret-item',
    title: 'Before',
  });
  expect(JSON.parse(change!.oldValuesJson!)).not.toHaveProperty('password');
});

test('OLD snapshots structurally exclude every protocol credential', () => {
  const { vault } = open();
  const now = new Date().toISOString();
  vault
    .prepare(
      `INSERT INTO core_party
         (party_id, kind, display_name, created_at, updated_at, ontology_version)
       VALUES ('credential-party', 'agent', 'Credential agent', ?, ?, '1.3')`,
    )
    .run(now, now);
  vault
    .prepare(
      `INSERT INTO consent_app
         (app_id, name, display_name, signing_key, status, origin, risk_ceiling, installed_at)
       VALUES ('credential-app', 'credential-app', 'Before app', 'signing-never-log',
               'active', 'installed', 'low', ?)`,
    )
    .run(now);
  vault
    .prepare(
      `INSERT INTO agent_agent
         (agent_id, party_id, host_key, model_ref, version, enrolled_at, status)
       VALUES ('credential-agent', 'credential-party', 'host-never-log',
               'tier:fast', '1', ?, 'active')`,
    )
    .run(now);
  vault
    .prepare(
      `INSERT INTO consent_device
         (device_id, owner_party_id, name, public_key, trust, enrolled_at)
       VALUES ('credential-device', 'credential-party', 'Before device',
               'public-never-log', 'full', ?)`,
    )
    .run(now);
  const since = currentReplicaLogState(vault).watermark;

  vault
    .prepare(`UPDATE consent_app SET display_name = 'After app' WHERE app_id = 'credential-app'`)
    .run();
  vault
    .prepare(`UPDATE agent_agent SET model_ref = 'tier:smart' WHERE agent_id = 'credential-agent'`)
    .run();
  vault
    .prepare(
      `UPDATE consent_device SET name = 'After device' WHERE device_id = 'credential-device'`,
    )
    .run();

  const changes = readReplicaChanges(vault, { since }).changes;
  const old = new Map(
    changes.map((change) => [change.entity, JSON.parse(change.oldValuesJson ?? '{}') as object]),
  );
  expect(old.get('consent.app')).toMatchObject({ display_name: 'Before app' });
  expect(old.get('consent.app')).not.toHaveProperty('signing_key');
  expect(old.get('agent.agent')).toMatchObject({ model_ref: 'tier:fast' });
  expect(old.get('agent.agent')).not.toHaveProperty('host_key');
  expect(old.get('consent.device')).toMatchObject({ name: 'Before device' });
  expect(old.get('consent.device')).not.toHaveProperty('public_key');
  expect(JSON.stringify(changes)).not.toMatch(/signing-never-log|host-never-log|public-never-log/);
});

test('rolled-back base writes leave no log entry and committed sequence stays monotonic', () => {
  const { vault } = open();
  vault.exec('BEGIN');
  insertScheme(vault, 'rolled-back');
  vault.exec('ROLLBACK');
  expect(readReplicaChanges(vault).changes).toEqual([]);

  insertScheme(vault, 'committed');
  const page = readReplicaChanges(vault);
  expect(page.changes).toHaveLength(1);
  expect(page.changes[0]).toMatchObject({
    seq: 1,
    entity: 'core.concept_scheme',
    rowId: 'committed',
    op: 'insert',
  });
});

test('every registered canonical table receives the three transaction-level triggers', () => {
  const { vault } = open();
  for (const entity of listVaultEntities(vault)) {
    const ref = resolveEntity(entity, vault);
    expect(ref, entity).toBeDefined();
    for (const suffix of ['ai', 'au', 'ad']) {
      const trigger = vault
        .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'trigger' AND name = ?`)
        .get(`trg_replica_${ref?.physical}_${suffix}`) as { present: number } | undefined;
      expect(trigger?.present, `${entity} ${suffix}`).toBe(1);
    }
  }
});

test('live ext rows join the log while draft rows remain scratch-only', () => {
  const extSpec: ExtTableSpec = {
    name: 'workout',
    columns: [
      { name: 'workout_id', type: 'text', primaryKey: true },
      { name: 'notes', type: 'text' },
    ],
  };
  const opened = open();
  applyExtBand(opened, 'gym-log', [extSpec], 'live');
  const afterDdl = currentReplicaLogState(opened.vault).watermark;
  opened.vault
    .prepare(`INSERT INTO ext_gym_log_workout (workout_id, notes) VALUES ('w1', 'run')`)
    .run();
  const live = readReplicaChanges(opened.vault, { since: afterDdl });
  expect(live.changes).toEqual([
    expect.objectContaining({ entity: 'ext.gym-log.workout', rowId: 'w1', op: 'insert' }),
  ]);

  applyExtBand(opened, 'gym-log', [extSpec], 'draft');
  const beforeDraftRow = currentReplicaLogState(opened.vault).watermark;
  opened.vault
    .prepare(`INSERT INTO extdraft_gym_log_workout (workout_id, notes) VALUES ('d1', 'scratch')`)
    .run();
  expect(readReplicaChanges(opened.vault, { since: beforeDraftRow }).changes).toEqual([]);
});

test('cursor pages resume exactly and malformed cursors are refused', () => {
  const { vault } = open();
  insertScheme(vault, 'a');
  insertScheme(vault, 'b');
  insertScheme(vault, 'c');
  const first = readReplicaChanges(vault, { limit: 2 });
  expect(first.changes.map((entry) => entry.rowId)).toEqual(['a', 'b']);
  expect(first.hasMore).toBe(true);
  const wire = formatReplicaCursor(first.next);
  expect(parseReplicaCursor(wire)).toEqual(first.next);
  const second = readReplicaChanges(vault, { since: wire, limit: 2 });
  expect(second.changes.map((entry) => entry.rowId)).toEqual(['c']);
  expect(second.hasMore).toBe(false);
  expect(second.next).toEqual(first.watermark);
  expect(() => parseReplicaCursor('not-a-cursor')).toThrow(/form/);
});

test('retention applies age then count while advancing through a deleted prefix', () => {
  const { vault } = open();
  const epoch = currentReplicaLogState(vault).epoch;
  appendReplicaChange(vault, {
    entity: 'core.party',
    rowId: 'expired',
    op: 'insert',
    changedAt: '2026-05-01T00:00:00.000Z',
  });
  const cursorBeforeRetention = { epoch, seq: 1 };
  for (const [rowId, op] of [
    ['repeat', 'insert'],
    ['repeat', 'update'],
    ['kept-b', 'insert'],
    ['kept-c', 'insert'],
  ] as const) {
    appendReplicaChange(vault, {
      entity: 'core.party',
      rowId,
      op,
      changedAt: '2026-07-14T00:00:00.000Z',
    });
  }

  const result = pruneReplicaChanges(vault, {
    now: new Date('2026-07-15T00:00:00.000Z'),
    maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
    maxEntries: 2,
  });
  expect(result).toMatchObject({ expired: 1, compacted: 1, overflow: 1, retained: 2 });
  expect(result.floor.seq).toBe(3);
  expect(
    readReplicaChanges(vault, { since: result.floor }).changes.map((entry) => entry.rowId),
  ).toEqual(['kept-b', 'kept-c']);
  expect(() => readReplicaChanges(vault, { since: cursorBeforeRetention })).toThrowError(
    ReplicaRebootstrapRequiredError,
  );
});

test('the age window expires low-volume rows before the count cap', () => {
  const { vault } = open();
  for (const rowId of ['old-a', 'old-b']) {
    appendReplicaChange(vault, {
      entity: 'core.party',
      rowId,
      op: 'insert',
      changedAt: '2020-01-01T00:00:00.000Z',
    });
  }
  const result = pruneReplicaChanges(vault, {
    now: new Date('2026-07-15T00:00:00.000Z'),
    maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
    maxEntries: 10,
  });
  expect(result).toMatchObject({ expired: 2, compacted: 0, overflow: 0, retained: 0 });
  expect(result.floor.seq).toBe(2);
});

test('the count cap removes overflow even while rows are inside 30 days', () => {
  const { vault } = open();
  for (const rowId of ['recent-a', 'recent-b', 'recent-c', 'recent-d']) {
    appendReplicaChange(vault, {
      entity: 'core.party',
      rowId,
      op: 'insert',
      changedAt: '2026-07-14T00:00:00.000Z',
    });
  }
  const result = pruneReplicaChanges(vault, {
    now: new Date('2026-07-15T00:00:00.000Z'),
    maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
    maxEntries: 2,
  });
  expect(result).toMatchObject({ expired: 0, compacted: 0, overflow: 2, retained: 2 });
  expect(result.floor.seq).toBe(2);
});

test('count pressure compacts the full window to the latest entry per row', () => {
  const { vault } = open();
  const epoch = currentReplicaLogState(vault).epoch;
  for (let index = 0; index < 1_001; index += 1) {
    appendReplicaChange(vault, {
      entity: 'core.party',
      rowId: 'hot-row',
      op: index === 0 ? 'insert' : 'update',
      changedAt: '2026-07-14T00:00:00.000Z',
    });
  }
  const alreadyCurrent = { epoch, seq: 1_001 };

  const result = pruneReplicaChanges(vault, {
    now: new Date('2026-07-15T00:00:00.000Z'),
    maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
    maxEntries: 1_000,
  });

  expect(result).toMatchObject({ compacted: 1_000, overflow: 0, retained: 1 });
  expect(result.floor).toEqual({ epoch, seq: 1_000 });
  expect(readReplicaChanges(vault, { since: result.floor }).changes).toEqual([
    expect.objectContaining({ seq: 1_001, rowId: 'hot-row', op: 'update' }),
  ]);
  expect(readReplicaChanges(vault, { since: alreadyCurrent }).changes).toEqual([]);
  expect(() => readReplicaChanges(vault, { since: { epoch, seq: 999 } })).toThrowError(
    ReplicaRebootstrapRequiredError,
  );
});

test('epoch bump invalidates old cursors and new changes continue above the prior watermark', () => {
  const { vault } = open();
  insertScheme(vault, 'before');
  const before = currentReplicaLogState(vault);
  const after = bumpReplicaEpoch(vault, {
    reason: 'backup-restore',
    epoch: '11111111-2222-3333-4444-555555555555',
    now: new Date('2026-07-15T00:00:00.000Z'),
  });
  expect(after.epoch).not.toBe(before.epoch);
  expect(after.floor.seq).toBe(before.watermark.seq);
  expect(() => readReplicaChanges(vault, { since: before.watermark })).toThrowError(
    ReplicaRebootstrapRequiredError,
  );

  insertScheme(vault, 'after');
  const page = readReplicaChanges(vault, { since: after.floor });
  expect(page.changes).toEqual([
    expect.objectContaining({
      epoch: after.epoch,
      rowId: 'after',
      seq: before.watermark.seq + 1,
    }),
  ]);
});

test('schema epoch skew rotates epoch during protocol initialization', () => {
  const { vault } = open();
  const before = currentReplicaLogState(vault);
  vault.prepare(`UPDATE replica_meta SET schema_epoch = 99 WHERE singleton = 1`).run();
  const after = initializeReplicaProtocol(vault);
  expect(after.epoch).not.toBe(before.epoch);
  expect(after.schemaEpoch).toBe(1);
  expect(after.epochReason).toBe('schema-change');
});

test('warm initialization skips a stable trigger catalog and repairs schema drift', () => {
  const { vault } = open();
  const schemaVersion = () =>
    (vault.prepare('PRAGMA schema_version').get() as { schema_version: number }).schema_version;
  const recordedVersion = () =>
    (
      vault
        .prepare(`SELECT trigger_schema_version FROM replica_meta WHERE singleton = 1`)
        .get() as { trigger_schema_version: number }
    ).trigger_schema_version;

  const stable = schemaVersion();
  expect(recordedVersion()).toBe(stable);
  initializeReplicaProtocol(vault);
  expect(schemaVersion()).toBe(stable);
  expect(recordedVersion()).toBe(stable);

  vault.exec('DROP TRIGGER "trg_replica_core_concept_scheme_ai"');
  expect(schemaVersion()).toBeGreaterThan(stable);
  initializeReplicaProtocol(vault);
  expect(
    vault
      .prepare(
        `SELECT 1 AS present FROM sqlite_master
          WHERE type = 'trigger' AND name = 'trg_replica_core_concept_scheme_ai'`,
      )
      .get(),
  ).toEqual({ present: 1 });
  expect(recordedVersion()).toBe(schemaVersion());
});
