import { beforeEach, expect, test, vi } from 'vitest';
import { registerScheduleCommands } from '../commands/schedule.js';
import { bootstrapVault, createGrant, enrollApp, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { sha256Hex, uuidv7 } from '../ids.js';
import { createGateway, Gateway } from './gateway.js';
import { canonicalJson, importVaultExport } from './portability.js';
import type { Credential } from './types.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerScheduleCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

/** Populate the vault across several schemas so the round-trip is honest. */
function seedLife(): void {
  const calendarId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO schedule_calendar (calendar_id, owner_party_id, name, default_tz, visibility)
       VALUES (?, ?, 'Personal', 'Asia/Kolkata', 'private')`,
    )
    .run(calendarId, boot.ownerPartyId);
  const outcome = gw.invoke(owner, {
    command: 'schedule.propose_event',
    input: {
      summary: 'Workshop',
      dtstart: '2026-07-10T09:00:00Z',
      dtend: '2026-07-10T12:00:00Z',
      calendar_id: calendarId,
      attendee_party_ids: [boot.ownerPartyId],
    },
    purpose: 'dpv:ServiceProvision',
  });
  if (outcome.status !== 'executed') throw new Error(`seed failed: ${JSON.stringify(outcome)}`);
  gw.invoke(owner, {
    command: 'schedule.respond_rsvp',
    input: {
      event_id: (outcome.output as { event_id: string }).event_id,
      party_id: boot.ownerPartyId,
      partstat: 'accepted',
    },
    purpose: 'dpv:ServiceProvision',
  });
  const app = enrollApp(db, { name: 'calendar-app', riskCeiling: 'medium' });
  createGrant(db, {
    appId: app.appId,
    purposeConceptId: boot.concepts['dpv:ServiceProvision'] as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [{ schema: 'schedule', verbs: 'read' }],
  });
}

test('respond_rsvp drives the RFC 5545 state machine', () => {
  seedLife();
  const attendee = db.vault
    .prepare('SELECT partstat, responded_at FROM schedule_attendee')
    .get() as { partstat: string; responded_at: string | null };
  expect(attendee.partstat).toBe('accepted');
  expect(attendee.responded_at).not.toBeNull();
});

test('respond_rsvp denies a party that was never invited', () => {
  seedLife();
  const event = db.vault.prepare('SELECT event_id FROM core_event').get() as { event_id: string };
  const outcome = gw.invoke(owner, {
    command: 'schedule.respond_rsvp',
    input: { event_id: event.event_id, party_id: uuidv7(), partstat: 'declined' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('failed');
  if (outcome.status === 'failed') expect(outcome.predicate).toContain('attendee_invited');
});

test('export → reimport → re-export round-trips losslessly (§11 gate)', () => {
  seedLife();
  const first = gw.exportVault(owner);
  expect(first.artifact.verifyHash).toMatch(/^[0-9a-f]{64}$/);
  const jobs = db.vault
    .prepare('SELECT verify_hash, completed_at FROM consent_export_job WHERE export_id = ?')
    .get(first.exportId) as { verify_hash: string; completed_at: string | null };
  expect(jobs.verify_hash).toBe(first.artifact.verifyHash);
  expect(jobs.completed_at).not.toBeNull();

  // Rebuild a fresh vault from the artifact — identities intact.
  const restored = openVaultDb();
  const { imported } = importVaultExport(restored, first.artifact);
  expect(imported).toBeGreaterThan(20);
  const party = restored.vault
    .prepare('SELECT party_id, display_name FROM core_party WHERE party_id = ?')
    .get(boot.ownerPartyId) as { party_id: string; display_name: string };
  expect(party).toMatchObject({ party_id: boot.ownerPartyId, display_name: 'Priya' });

  // The restored vault serves the same owner credential through its own gateway.
  const gw2 = createGateway(restored);
  const events = gw2.read(owner, { entity: 'core.event', purpose: 'dpv:ServiceProvision' });
  expect(events.rows).toHaveLength(1);

  // Re-export: identical data hash — the export contains no self-reference,
  // and the reimport lost nothing. This is the losslessness proof.
  const second = gw2.exportVault(owner);
  expect(second.artifact.verifyHash).toBe(first.artifact.verifyHash);
  restored.close();
});

test('tampered artifact is rejected by hash verification', () => {
  seedLife();
  const { artifact } = gw.exportVault(owner);
  const tampered = structuredClone(artifact);
  const events = tampered.tables['core.event'];
  if (!events?.[0]) throw new Error('expected an event');
  events[0]['summary'] = 'Rewritten history';
  const fresh = openVaultDb();
  expect(() => importVaultExport(fresh, tampered)).toThrow(/hash mismatch/);
  fresh.close();
});

test('import refuses a non-fresh vault', () => {
  seedLife();
  const { artifact } = gw.exportVault(owner);
  expect(() => importVaultExport(db, artifact)).toThrow(/not a fresh vault/);
});

test('a poisoned row on one table is skipped, not fatal to the whole export (§4.3 hardening)', () => {
  seedLife();
  // Simulate node:sqlite's real failure mode reading back an out-of-range
  // INTEGER (verified: .get()/.all() throw "Value is too large to be
  // represented as a JavaScript number") by making exactly the `core_place`
  // read throw. Everything else — including the `PRAGMA table_info` call
  // that picks its primary key — passes through untouched.
  const originalPrepare = db.vault.prepare.bind(db.vault);
  const spy = vi
    .spyOn(db.vault, 'prepare')
    .mockImplementation((sql: string): ReturnType<typeof db.vault.prepare> => {
      if (sql.includes('FROM "core_place"')) {
        throw new Error('Value is too large to be represented as a JavaScript number');
      }
      return originalPrepare(sql);
    });

  const { artifact } = gw.exportVault(owner);
  spy.mockRestore();

  expect(artifact.skippedTables?.map((s) => s.entity)).toContain('core.place');
  expect(artifact.skippedTables?.find((s) => s.entity === 'core.place')?.error).toContain(
    'too large',
  );
  expect(artifact.tables['core.place']).toBeUndefined();
  // Everything else still made it into the artifact — including a table
  // that references `core_place` via an (unpopulated, so non-violating) FK.
  expect(artifact.tables['core.event']?.length).toBeGreaterThan(0);
  expect(artifact.tables['core.party']?.length).toBeGreaterThan(0);

  // verifyHash covers exactly the tables that actually made it in, so
  // round-trip verification stays sound against a partial artifact.
  expect(artifact.verifyHash).toBe(sha256Hex(canonicalJson(artifact.tables)));

  // A partial artifact still imports cleanly — it just doesn't carry the
  // skipped entity's rows.
  const restored = openVaultDb();
  expect(() => importVaultExport(restored, artifact)).not.toThrow();
  const places = restored.vault.prepare('SELECT count(*) AS n FROM core_place').get() as {
    n: number;
  };
  expect(places.n).toBe(0);
  restored.close();
});
