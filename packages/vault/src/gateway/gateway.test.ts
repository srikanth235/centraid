// governance: allow-repo-hygiene file-size-limit one pipeline suite over a single bootstrapped vault fixture — identity/consent/contract/execution/evidence stages are asserted against shared state
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { registerScheduleCommands } from '../commands/schedule.js';
import {
  bootstrapVault,
  createGrant,
  enrollAgent,
  enrollApp,
  enrollDevice,
  type BootstrapResult,
} from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { uuidv7 } from '../ids.js';
import {
  deleteReplicaIntentOutcomesForDevice,
  readReplicaIntentOutcome,
  recordReplicaIntentOutcome,
} from '../replica/intents.js';
import { readDurableParkedPayload } from '../replica/parked.js';
import { createGateway, Gateway } from './gateway.js';
import type { Credential } from './types.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;
let calendarId: string;

function seedCalendar(): string {
  const id = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO schedule_calendar (calendar_id, owner_party_id, name, default_tz, visibility)
       VALUES (?, ?, 'Personal', 'Asia/Kolkata', 'private')`,
    )
    .run(id, boot.ownerPartyId);
  return id;
}

function proposeInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: 'Standup',
    dtstart: '2026-07-03T09:00:00Z',
    dtend: '2026-07-03T09:15:00Z',
    calendar_id: calendarId,
    ...overrides,
  };
}

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerScheduleCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
  calendarId = seedCalendar();
});

describe('S1 identity', () => {
  test('unknown caller is dropped with no receipt row', () => {
    expect(() =>
      gw.read(
        { kind: 'device', deviceId: 'nope', deviceKey: 'nope' },
        { entity: 'core.party', purpose: 'dpv:ServiceProvision' },
      ),
    ).toThrow(/unknown caller/);
    const receipts = db.journal.prepare('SELECT count(*) AS n FROM consent_receipt').get() as {
      n: number;
    };
    expect(receipts.n).toBe(0);
  });

  test('wrong device key is dropped', () => {
    expect(() =>
      gw.read(
        { kind: 'device', deviceId: boot.deviceId, deviceKey: 'wrong' },
        { entity: 'core.party', purpose: 'dpv:ServiceProvision' },
      ),
    ).toThrow(/unknown caller/);
  });
});

describe('S2 consent', () => {
  test('owner-direct read is allowed and receipted', () => {
    const result = gw.read(owner, { entity: 'core.party', purpose: 'dpv:ServiceProvision' });
    expect(result.rows.length).toBeGreaterThan(0);
    const receipt = db.journal
      .prepare(
        'SELECT decision, action, object_type, grant_id FROM consent_receipt WHERE receipt_id = ?',
      )
      .get(result.receiptId) as {
      decision: string;
      action: string;
      object_type: string;
      grant_id: string | null;
    };
    expect(receipt).toMatchObject({
      decision: 'allow',
      action: 'read',
      object_type: 'core.party',
      grant_id: null,
    });
  });

  test('app without a grant is denied with a deny receipt', () => {
    const app = enrollApp(db, { name: 'vitals-widget' });
    const cred: Credential = { kind: 'app', appId: app.appId, signingKey: app.signingKey };
    expect(() =>
      gw.read(cred, { entity: 'core.observation', purpose: 'dpv:HealthMonitoring' }),
    ).toThrow(/deny/);
    const deny = db.journal
      .prepare(`SELECT count(*) AS n FROM consent_receipt WHERE decision='deny'`)
      .get() as { n: number };
    expect(deny.n).toBe(1);
  });

  test('granted app reads only within scope; ungranted schema still denied', () => {
    const app = enrollApp(db, { name: 'calendar-app' });
    createGrant(db, {
      appId: app.appId,
      purposeConceptId: boot.concepts['dpv:ServiceProvision'] as string,
      grantedByPartyId: boot.ownerPartyId,
      scopes: [
        { schema: 'schedule', verbs: 'read' },
        { schema: 'core', table: 'event', verbs: 'read' },
      ],
    });
    const cred: Credential = { kind: 'app', appId: app.appId, signingKey: app.signingKey };
    // 2 = the bootstrap-minted default "Personal" calendar + seedCalendar()'s.
    expect(
      gw.read(cred, { entity: 'schedule.calendar', purpose: 'dpv:ServiceProvision' }).rows,
    ).toHaveLength(2);
    expect(() =>
      gw.read(cred, { entity: 'core.transaction', purpose: 'dpv:ServiceProvision' }),
    ).toThrow(/deny/);
    // Wrong purpose on a valid scope is also a deny (purpose limitation).
    expect(() => gw.read(cred, { entity: 'schedule.calendar', purpose: 'dpv:Billing' })).toThrow(
      /deny/,
    );
  });

  test('row filter and field mask clamp what a grant surfaces', () => {
    gw.invoke(owner, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
    });
    const app = enrollApp(db, { name: 'masked-app' });
    createGrant(db, {
      appId: app.appId,
      purposeConceptId: boot.concepts['dpv:ServiceProvision'] as string,
      grantedByPartyId: boot.ownerPartyId,
      scopes: [
        {
          schema: 'core',
          table: 'event',
          verbs: 'read',
          rowFilter: [{ column: 'status', op: 'eq', value: 'confirmed' }],
          fieldMask: ['event_id', 'summary'],
        },
      ],
    });
    const cred: Credential = { kind: 'app', appId: app.appId, signingKey: app.signingKey };
    // Tentative event filtered out by the grant's row filter.
    expect(
      gw.read(cred, { entity: 'core.event', purpose: 'dpv:ServiceProvision' }).rows,
    ).toHaveLength(0);
    db.vault.prepare(`UPDATE core_event SET status='confirmed'`).run();
    const rows = gw.read(cred, { entity: 'core.event', purpose: 'dpv:ServiceProvision' }).rows;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['event_id', 'summary']);
  });
});

describe('S3/S4 command execution', () => {
  test('group commit crosses exactly one vault + journal commit pair', () => {
    const vaultExec = vi.spyOn(db.vault, 'exec');
    const journalExec = vi.spyOn(db.journal, 'exec');
    const outcomes = gw.invokeBatch(
      Array.from(
        { length: 10 },
        (_, index) => () =>
          gw.invoke(owner, {
            command: 'schedule.propose_event',
            invocationId: `batch-invocation-${index}`,
            input: proposeInput({
              summary: `Batched event ${index}`,
              dtstart: `2026-07-${String(index + 3).padStart(2, '0')}T10:00:00Z`,
              dtend: `2026-07-${String(index + 3).padStart(2, '0')}T10:15:00Z`,
            }),
          }),
      ),
    );
    expect(outcomes.map((outcome) => outcome.status)).toEqual(
      Array.from({ length: 10 }, () => 'executed'),
    );
    expect(vaultExec.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(1);
    expect(journalExec.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(1);
    expect(
      db.journal
        .prepare(
          `SELECT count(*) AS n FROM agent_command_invocation
            WHERE invocation_id LIKE 'batch-invocation-%' AND status = 'executed'`,
        )
        .get(),
    ).toEqual({ n: 10 });
    expect(
      db.vault
        .prepare(
          `SELECT invocation_id, journal_finalized_at FROM replica_invocation_commit
            WHERE invocation_id LIKE 'batch-invocation-%' ORDER BY invocation_id`,
        )
        .all(),
    ).toHaveLength(10);

    gw.invokeBatch([
      () =>
        gw.invoke(owner, {
          command: 'schedule.propose_event',
          invocationId: 'next-batch-invocation',
          input: proposeInput({
            summary: 'Next batch reclaims proven predecessors',
            dtstart: '2026-07-03T11:00:00Z',
            dtend: '2026-07-03T11:15:00Z',
          }),
        }),
    ]);
    expect(
      (
        db.vault
          .prepare(
            `SELECT COUNT(*) AS n FROM replica_invocation_commit
              WHERE invocation_id LIKE 'batch-invocation-%'`,
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });

  test('an app invocation is bound to the durable intent owner device and app', () => {
    const app = enrollApp(db, { name: 'agenda' });
    createGrant(db, {
      appId: app.appId,
      purposeConceptId: boot.concepts['dpv:ServiceProvision'] as string,
      grantedByPartyId: boot.ownerPartyId,
      scopes: [{ schema: 'schedule', verbs: 'read+act' }],
    });
    const cred: Credential = { kind: 'app', appId: app.appId, signingKey: app.signingKey };
    recordReplicaIntentOutcome(db.vault, {
      intentId: 'owned-intent',
      deviceId: 'paired-device-a',
      appId: 'agenda',
      action: 'propose',
      payloadHash: 'sha256:owned-intent',
      status: 'sending',
    });

    expect(() =>
      gw.invoke(cred, {
        command: 'schedule.propose_event',
        input: proposeInput(),
        purpose: 'dpv:ServiceProvision',
        intentId: 'owned-intent',
        intentDeviceId: 'paired-device-b',
      }),
    ).toThrow(/not owned by this device and app/);
    expect(db.vault.prepare('SELECT count(*) AS n FROM core_event').get()).toEqual({ n: 0 });

    expect(
      gw.invoke(cred, {
        command: 'schedule.propose_event',
        input: proposeInput(),
        purpose: 'dpv:ServiceProvision',
        intentId: 'owned-intent',
        intentDeviceId: 'paired-device-a',
      }),
    ).toMatchObject({ status: 'executed' });
  });

  test('propose_event executes: rows, checks, provenance, receipt, explanation', () => {
    const outcome = gw.invoke(owner, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
    });
    expect(outcome.status).toBe('executed');
    if (outcome.status !== 'executed') return;
    const eventId = (outcome.output as { event_id: string }).event_id;
    const event = db.vault
      .prepare('SELECT status, sequence FROM core_event WHERE event_id = ?')
      .get(eventId);
    expect(event).toMatchObject({ status: 'tentative', sequence: 0 });
    const checks = db.journal
      .prepare('SELECT phase, passed FROM agent_invocation_check WHERE invocation_id = ?')
      .all(outcome.invocationId) as { phase: string; passed: number }[];
    expect(checks.filter((c) => c.phase === 'pre')).toHaveLength(4);
    expect(checks.filter((c) => c.phase === 'post')).toHaveLength(2);
    expect(checks.every((c) => c.passed === 1)).toBe(true);
    const prov = db.journal
      .prepare(
        `SELECT count(*) AS n FROM consent_provenance WHERE entity_type='core.event' AND entity_id=?`,
      )
      .get(eventId) as { n: number };
    expect(prov.n).toBe(1);
    const expl = db.journal
      .prepare('SELECT summary FROM agent_explanation WHERE invocation_id = ?')
      .get(outcome.invocationId) as { summary: string };
    expect(expl.summary).toContain('schedule.propose_event');
    const inv = db.journal
      .prepare('SELECT status, receipt_id FROM agent_command_invocation WHERE invocation_id = ?')
      .get(outcome.invocationId) as { status: string; receipt_id: string };
    expect(inv.status).toBe('executed');
    expect(inv.receipt_id).toBe(outcome.receiptId);
  });

  test('precondition failure records failed invocation + failing check, writes nothing', () => {
    const outcome = gw.invoke(owner, {
      command: 'schedule.propose_event',
      input: proposeInput({ calendar_id: 'missing-calendar' }),
      purpose: 'dpv:ServiceProvision',
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    // The app-facing outcome carries the precondition's owner-facing
    // message, not the raw `name: column op value` predicate string.
    expect(outcome.predicate).toBe("That calendar doesn't exist.");
    const events = db.vault.prepare('SELECT count(*) AS n FROM core_event').get() as { n: number };
    expect(events.n).toBe(0);
    const inv = db.journal
      .prepare('SELECT status FROM agent_command_invocation WHERE invocation_id = ?')
      .get(outcome.invocationId) as { status: string };
    expect(inv.status).toBe('failed');
    // The raw technical predicate is still recorded in the checks-table
    // audit trail, unaffected by the friendly outward message.
    const check = db.journal
      .prepare(
        `SELECT predicate FROM agent_invocation_check WHERE invocation_id = ? AND passed = 0`,
      )
      .get(outcome.invocationId) as { predicate: string };
    expect(check.predicate).toContain('calendar_exists');
  });

  test('busy conflict precondition blocks a second overlapping proposal', () => {
    gw.invoke(owner, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
    });
    const outcome = gw.invoke(owner, {
      command: 'schedule.propose_event',
      input: proposeInput({
        summary: 'Clash',
        dtstart: '2026-07-03T09:10:00Z',
        dtend: '2026-07-03T09:30:00Z',
      }),
      purpose: 'dpv:ServiceProvision',
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.predicate).toBe('This time conflicts with another event on your calendar.');
    }
  });

  test('input schema violation is a contract failure', () => {
    const outcome = gw.invoke(owner, {
      command: 'schedule.propose_event',
      input: { summary: 'No times', calendar_id: calendarId },
      purpose: 'dpv:ServiceProvision',
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toContain('schema');
  });

  test('reschedule_event bumps sequence on the same identity', () => {
    const proposed = gw.invoke(owner, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
    });
    if (proposed.status !== 'executed') throw new Error('propose failed');
    const eventId = (proposed.output as { event_id: string }).event_id;
    const outcome = gw.invoke(owner, {
      command: 'schedule.reschedule_event',
      input: { event_id: eventId, dtstart: '2026-07-03T10:00:00Z', dtend: '2026-07-03T10:15:00Z' },
      purpose: 'dpv:ServiceProvision',
    });
    expect(outcome.status).toBe('executed');
    const event = db.vault
      .prepare('SELECT sequence, dtstart FROM core_event WHERE event_id = ?')
      .get(eventId);
    expect(event).toMatchObject({ sequence: 1, dtstart: '2026-07-03T10:00:00Z' });
  });

  test('idempotent replay: same invocation id never double-writes', () => {
    const invocationId = uuidv7();
    const first = gw.invoke(owner, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
      invocationId,
    });
    expect(first.status).toBe('executed');
    if (first.status !== 'executed') return;
    const replay = gw.invoke(owner, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
      invocationId,
    });
    expect(replay).toMatchObject({ status: 'replayed', output: first.output });
    const events = db.vault.prepare('SELECT count(*) AS n FROM core_event').get() as { n: number };
    expect(events.n).toBe(1);
  });

  test('invocation ids are bound to command, caller, and grant before execution', () => {
    const invocationId = uuidv7();
    const failed = gw.invoke(owner, {
      command: 'schedule.propose_event',
      input: proposeInput({ calendar_id: 'missing-calendar' }),
      purpose: 'dpv:ServiceProvision',
      invocationId,
    });
    expect(failed).toMatchObject({ status: 'failed', invocationId });

    expect(() =>
      gw.invoke(owner, {
        command: 'schedule.reschedule_event',
        input: {
          event_id: 'would-have-mutated',
          dtstart: '2026-07-03T10:00:00Z',
          dtend: '2026-07-03T10:15:00Z',
        },
        purpose: 'dpv:ServiceProvision',
        invocationId,
      }),
    ).toThrow(/already bound/);
    expect(db.vault.prepare('SELECT count(*) AS n FROM core_event').get()).toEqual({ n: 0 });
    expect(
      db.vault
        .prepare('SELECT count(*) AS n FROM replica_invocation_commit WHERE invocation_id = ?')
        .get(invocationId),
    ).toEqual({ n: 0 });

    gw = createGateway(db);
    registerScheduleCommands(gw);
    expect(db.vault.prepare('SELECT count(*) AS n FROM core_event').get()).toEqual({ n: 0 });
  });

  test('ordinary failed invocation replay remains a failure, not an owner denial', () => {
    const invocationId = uuidv7();
    const request = {
      command: 'schedule.propose_event',
      input: proposeInput({ calendar_id: 'missing-calendar' }),
      purpose: 'dpv:ServiceProvision',
      invocationId,
    } as const;
    const first = gw.invoke(owner, request);
    expect(first).toMatchObject({ status: 'failed', invocationId });

    const replay = gw.invoke(owner, request);
    expect(replay).toMatchObject({
      status: 'failed',
      invocationId,
      reason: expect.stringContaining('calendar_exists'),
    });
    expect(replay).not.toMatchObject({ status: 'denied' });
  });

  test('replay atomically repairs a crash-left journal gap before returning', () => {
    const invocationId = uuidv7();
    const first = gw.invoke(owner, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
      invocationId,
      intentId: 'offline-intent-crash-gap',
    });
    expect(first.status).toBe('executed');
    if (first.status !== 'executed') return;

    expect(
      db.vault
        .prepare(
          `SELECT command_id, intent_id, audit_json, journal_finalized_at
             FROM replica_invocation_commit WHERE invocation_id = ?`,
        )
        .get(invocationId),
    ).toMatchObject({
      intent_id: 'offline-intent-crash-gap',
      journal_finalized_at: expect.any(String),
    });
    expect(
      db.vault
        .prepare(
          `SELECT count(*) AS n
             FROM pragma_table_info('replica_invocation_commit')
            WHERE name = 'output_json'`,
        )
        .get(),
    ).toEqual({ n: 0 });
    const replicaReceipt = db.journal
      .prepare('SELECT detail_json FROM consent_receipt WHERE invocation_id = ?')
      .get(invocationId) as { detail_json: string };
    expect(JSON.parse(replicaReceipt.detail_json)).not.toHaveProperty('output');

    // Rewind only the derived journal side to model a process dying after
    // vault.db COMMIT and before any post-check/S5 row committed. The marker
    // remains the canonical proof and carries redacted reconstruction data.
    db.journal
      .prepare(
        `UPDATE agent_command_invocation
            SET status = 'checked', executed_at = NULL, receipt_id = NULL
          WHERE invocation_id = ?`,
      )
      .run(invocationId);
    db.journal.prepare(`DELETE FROM agent_evidence WHERE invocation_id = ?`).run(invocationId);
    db.journal.prepare(`DELETE FROM agent_explanation WHERE invocation_id = ?`).run(invocationId);
    db.journal
      .prepare(`DELETE FROM agent_invocation_check WHERE invocation_id = ? AND phase = 'post'`)
      .run(invocationId);
    db.journal.prepare(`DELETE FROM consent_receipt WHERE invocation_id = ?`).run(invocationId);
    db.journal
      .prepare(
        `DELETE FROM consent_provenance
          WHERE json_extract(used_json, '$.invocation') = ?`,
      )
      .run(invocationId);
    db.vault
      .prepare(
        `UPDATE replica_invocation_commit
            SET journal_finalized_at = NULL
          WHERE invocation_id = ?`,
      )
      .run(invocationId);

    // Abort late in repair. Every earlier insert must roll back with it, the
    // proof stamp must remain NULL, and replay must not claim success.
    db.journal.exec(`
      CREATE TRIGGER fail_repair_evidence
      BEFORE INSERT ON agent_evidence
      BEGIN
        SELECT RAISE(ABORT, 'synthetic repair crash');
      END;
    `);
    expect(() =>
      gw.invoke(owner, {
        command: 'schedule.propose_event',
        input: proposeInput(),
        purpose: 'dpv:ServiceProvision',
        invocationId,
        intentId: 'offline-intent-crash-gap',
      }),
    ).toThrow(/synthetic repair crash/);
    db.journal.exec('DROP TRIGGER fail_repair_evidence');

    const count = (table: string, where = 'invocation_id = ?'): number =>
      (
        db.journal
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)
          .get(invocationId) as {
          n: number;
        }
      ).n;
    expect(count('agent_invocation_check', `invocation_id = ? AND phase = 'post'`)).toBe(0);
    expect(count('consent_provenance', `json_extract(used_json, '$.invocation') = ?`)).toBe(0);
    expect(count('consent_receipt')).toBe(0);
    expect(count('agent_evidence')).toBe(0);
    expect(count('agent_explanation')).toBe(0);
    expect(
      db.journal
        .prepare(
          `SELECT status, executed_at, receipt_id
             FROM agent_command_invocation WHERE invocation_id = ?`,
        )
        .get(invocationId),
    ).toEqual({ status: 'checked', executed_at: null, receipt_id: null });
    expect(
      db.vault
        .prepare(
          `SELECT journal_finalized_at FROM replica_invocation_commit WHERE invocation_id = ?`,
        )
        .get(invocationId),
    ).toEqual({ journal_finalized_at: null });

    const replay = gw.invoke(owner, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
      invocationId,
      intentId: 'offline-intent-crash-gap',
    });

    expect(replay).toMatchObject({
      status: 'replayed',
      invocationId,
      output: null,
    });
    expect(count('agent_invocation_check', `invocation_id = ? AND phase = 'post'`)).toBe(2);
    expect(count('consent_provenance', `json_extract(used_json, '$.invocation') = ?`)).toBe(2);
    expect(count('consent_receipt')).toBe(1);
    expect(count('agent_evidence')).toBe(1);
    expect(count('agent_explanation')).toBe(1);
    expect(
      db.journal
        .prepare(`SELECT status, receipt_id FROM agent_command_invocation WHERE invocation_id = ?`)
        .get(invocationId),
    ).toMatchObject({ status: 'executed', receipt_id: expect.any(String) });
    expect(
      db.vault
        .prepare(
          `SELECT journal_finalized_at FROM replica_invocation_commit WHERE invocation_id = ?`,
        )
        .get(invocationId),
    ).toMatchObject({ journal_finalized_at: expect.any(String) });
    const events = db.vault.prepare('SELECT count(*) AS n FROM core_event').get() as { n: number };
    expect(events.n).toBe(1);
  });

  test('post-canonical finalization failure retries the marker without a second write', () => {
    const invocationId = 'offline-intent-finalize-ambiguous';
    db.journal.exec(`CREATE TEMP TRIGGER fail_finalization_receipt
      BEFORE INSERT ON consent_receipt BEGIN
        SELECT RAISE(ABORT, 'synthetic post-canonical finalization failure');
      END`);

    expect(() =>
      gw.invoke(owner, {
        command: 'schedule.propose_event',
        input: proposeInput(),
        purpose: 'dpv:ServiceProvision',
        invocationId,
        intentId: invocationId,
      }),
    ).toThrow(/post-canonical finalization failure/);
    expect(db.vault.prepare('SELECT count(*) AS n FROM core_event').get()).toEqual({ n: 1 });
    expect(
      db.vault
        .prepare(
          `SELECT journal_finalized_at
             FROM replica_invocation_commit WHERE invocation_id = ?`,
        )
        .get(invocationId),
    ).toEqual({ journal_finalized_at: null });

    db.journal.exec('DROP TRIGGER fail_finalization_receipt');
    gw = createGateway(db);
    registerScheduleCommands(gw);
    const retry = gw.invoke(owner, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
      invocationId,
      intentId: invocationId,
    });

    expect(retry).toMatchObject({ status: 'replayed', invocationId, output: null });
    expect(db.vault.prepare('SELECT count(*) AS n FROM core_event').get()).toEqual({ n: 1 });
    expect(
      db.journal
        .prepare('SELECT status FROM agent_command_invocation WHERE invocation_id = ?')
        .get(invocationId),
    ).toEqual({ status: 'executed' });
  });

  test('ordinary post-canonical recovery preserves receipt replay output', () => {
    const invocationId = 'ordinary-finalize-ambiguous';
    db.journal.exec(`CREATE TEMP TRIGGER fail_ordinary_finalization_receipt
      BEFORE INSERT ON consent_receipt BEGIN
        SELECT RAISE(ABORT, 'synthetic ordinary finalization failure');
      END`);

    expect(() =>
      gw.invoke(owner, {
        command: 'schedule.propose_event',
        input: proposeInput(),
        purpose: 'dpv:ServiceProvision',
        invocationId,
      }),
    ).toThrow(/ordinary finalization failure/);
    const event = db.vault.prepare('SELECT event_id FROM core_event').get() as {
      event_id: string;
    };
    const marker = db.vault
      .prepare(
        `SELECT intent_id, audit_json, journal_finalized_at
           FROM replica_invocation_commit WHERE invocation_id = ?`,
      )
      .get(invocationId) as {
      intent_id: string | null;
      audit_json: string;
      journal_finalized_at: string | null;
    };
    expect(marker.intent_id).toBeNull();
    expect(marker.journal_finalized_at).toBeNull();
    expect(JSON.parse(marker.audit_json)).toMatchObject({
      receiptDetail: { output: { event_id: event.event_id } },
    });

    db.journal.exec('DROP TRIGGER fail_ordinary_finalization_receipt');
    gw = createGateway(db);
    registerScheduleCommands(gw);
    const retry = gw.invoke(owner, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
      invocationId,
    });

    expect(retry).toMatchObject({
      status: 'replayed',
      invocationId,
      output: { event_id: event.event_id },
    });
    expect(db.vault.prepare('SELECT count(*) AS n FROM core_event').get()).toEqual({ n: 1 });
    expect(
      db.vault
        .prepare(`SELECT 1 AS present FROM replica_invocation_commit WHERE invocation_id = ?`)
        .get(invocationId),
    ).toBeUndefined();
  });

  test('ordinary success deletes its marker without stamping journal_finalized_at (#456 S2)', () => {
    db.vault.exec(`CREATE TEMP TRIGGER reject_redundant_finalize_stamp
      BEFORE UPDATE OF journal_finalized_at ON replica_invocation_commit
      BEGIN
        SELECT RAISE(ABORT, 'ordinary path stamped the marker');
      END`);
    const invocationId = 'ordinary-direct-marker-delete';
    const outcome = gw.invoke(owner, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
      invocationId,
    });
    expect(outcome.status).toBe('executed');
    expect(
      db.vault
        .prepare('SELECT count(*) AS n FROM replica_invocation_commit WHERE invocation_id = ?')
        .get(invocationId),
    ).toEqual({ n: 0 });
  });

  test('judgment veto blocks an otherwise-valid call', () => {
    db.vault
      .prepare(
        `INSERT INTO agent_judgment (judgment_id, subject_scope, rule_json, confidence, active, learned_at)
         VALUES ('j1', 'schedule.propose_event', '{"veto_command":"schedule.propose_event"}', 1.0, 1, ?)`,
      )
      .run(new Date().toISOString());
    const outcome = gw.invoke(owner, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toContain('judgment');
  });
});

describe('confirmation routing + revocation + sweeps', () => {
  function grantedAgent(): { cred: Credential; grantId: string } {
    const agent = enrollAgent(db, { name: 'assistant', modelRef: 'model-x' });
    const device = enrollDevice(db, boot.ownerPartyId, 'agent-host');
    const grantId = createGrant(db, {
      granteePartyId: agent.partyId,
      purposeConceptId: boot.concepts['dpv:ServiceProvision'] as string,
      grantedByPartyId: boot.ownerPartyId,
      scopes: [{ schema: 'schedule', verbs: 'read+act' }],
    });
    return {
      cred: {
        kind: 'agent',
        agentId: agent.agentId,
        deviceId: device.deviceId,
        deviceKey: device.deviceKey,
      },
      grantId,
    };
  }

  test('agent invoking a confirm-gated command parks; owner approval executes it', () => {
    // Mark the command loud-on-purpose (issue #306): confirmation is a
    // property of the command's capability row, not of its risk.
    db.vault
      .prepare(
        `UPDATE agent_capability SET requires_confirmation=1
          WHERE command_id = (SELECT command_id FROM agent_command WHERE name='schedule.propose_event')`,
      )
      .run();
    const { cred } = grantedAgent();
    recordReplicaIntentOutcome(db.vault, {
      intentId: 'offline-intent-1',
      deviceId: 'remote-device-1',
      appId: 'agenda',
      action: 'propose',
      payloadHash: 'sha256:offline-intent-1',
      status: 'sending',
    });
    const parked = gw.invoke(cred, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
      intentId: 'offline-intent-1',
    });
    expect(parked.status).toBe('parked');
    if (parked.status !== 'parked') return;
    const listed = gw.listParked();
    expect(listed).toHaveLength(1);
    // The consent surface names WHO wants the act and WHAT it is, so the
    // owner reads what they're confirming, not just an opaque id.
    expect(listed[0]).toMatchObject({
      invocationId: parked.invocationId,
      command: 'schedule.propose_event',
      callerKind: 'agent',
      caller: 'assistant',
      input: proposeInput(),
    });
    // The approval payload is vault state, not process memory: a daemon
    // restart must leave the same review surface and resumable invocation.
    gw = createGateway(db);
    registerScheduleCommands(gw);
    expect(gw.listParked()).toMatchObject(listed);
    const outcome = gw.confirm(owner, parked.invocationId, true);
    expect(outcome.status).toBe('executed');
    if (outcome.status !== 'executed') return;
    const receipt = db.journal
      .prepare('SELECT detail_json FROM consent_receipt WHERE receipt_id = ?')
      .get(outcome.receiptId) as { detail_json: string };
    expect(JSON.parse(receipt.detail_json).confirmation.confirmedBy).toBe(boot.ownerPartyId);
    expect(readReplicaIntentOutcome(db.vault, 'offline-intent-1', 'remote-device-1')).toMatchObject(
      { status: 'executed', invocationId: parked.invocationId },
    );
  });

  test('confirmation retry recreates payload after the journal-only crash gap', () => {
    db.vault
      .prepare(
        `UPDATE agent_capability SET requires_confirmation=1
          WHERE command_id = (SELECT command_id FROM agent_command WHERE name='schedule.propose_event')`,
      )
      .run();
    const { cred } = grantedAgent();
    const request = {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
      invocationId: 'offline-intent-journal-gap',
      intentId: 'offline-intent-journal-gap',
    } as const;
    const first = gw.invoke(cred, request);
    expect(first.status).toBe('parked');
    db.vault
      .prepare('DELETE FROM replica_parked_payload WHERE invocation_id = ?')
      .run(request.invocationId);

    const retried = gw.invoke(cred, request);

    expect(retried).toMatchObject({
      status: 'parked',
      invocationId: request.invocationId,
    });
    expect(
      db.journal
        .prepare('SELECT count(*) AS n FROM agent_command_invocation WHERE invocation_id = ?')
        .get(request.invocationId),
    ).toEqual({ n: 1 });
    expect(readDurableParkedPayload(db, request.invocationId)).toBeDefined();
  });

  test('listParked resolves callerKind "assistant" for the vault assistant identity, distinct from an automation agent (issue: parked-invocation trust legibility)', () => {
    db.vault
      .prepare(
        `UPDATE agent_capability SET requires_confirmation=1
          WHERE command_id = (SELECT command_id FROM agent_command WHERE name='schedule.propose_event')`,
      )
      .run();

    // The vault assistant's own enrolled identity — `host_key = '_assistant'`
    // (VaultPlane.invokeAsAssistant) — rides the same `kind: 'agent'`
    // credential shape as an automation, but callerKind must tell them apart.
    const assistantAgent = enrollAgent(db, {
      name: '_assistant',
      modelRef: 'centraid-assistant',
      displayName: 'Assistant',
    });
    const assistantDevice = enrollDevice(db, boot.ownerPartyId, 'assistant-host');
    const assistantCred: Credential = {
      kind: 'agent',
      agentId: assistantAgent.agentId,
      deviceId: assistantDevice.deviceId,
      deviceKey: assistantDevice.deviceKey,
    };
    createGrant(db, {
      granteePartyId: assistantAgent.partyId,
      purposeConceptId: boot.concepts['dpv:ServiceProvision'] as string,
      grantedByPartyId: boot.ownerPartyId,
      scopes: [{ schema: 'schedule', verbs: 'read+act' }],
    });
    const assistantParked = gw.invoke(assistantCred, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
    });
    expect(assistantParked.status).toBe('parked');
    if (assistantParked.status !== 'parked') return;

    // An ordinary automation agent, for contrast.
    const { cred: automationCred } = grantedAgent();
    const automationParked = gw.invoke(automationCred, {
      command: 'schedule.propose_event',
      input: proposeInput({ summary: 'Automation event' }),
      purpose: 'dpv:ServiceProvision',
    });
    expect(automationParked.status).toBe('parked');
    if (automationParked.status !== 'parked') return;

    const listed = gw.listParked();
    expect(listed.find((p) => p.invocationId === assistantParked.invocationId)).toMatchObject({
      callerKind: 'assistant',
      caller: 'Assistant',
    });
    expect(listed.find((p) => p.invocationId === automationParked.invocationId)).toMatchObject({
      callerKind: 'agent',
    });
  });

  test('install-time scopes execute without parking; risk is journaled as salience (issue #306)', () => {
    // propose_event is medium risk; the agent has no ceiling anymore — the
    // granted command executes, and the receipt carries the risk marker.
    const { cred } = grantedAgent();
    const outcome = gw.invoke(cred, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
    });
    expect(outcome.status).toBe('executed');
    if (outcome.status !== 'executed') return;
    const receipt = db.journal
      .prepare('SELECT detail_json FROM consent_receipt WHERE receipt_id = ?')
      .get(outcome.receiptId) as { detail_json: string };
    expect(JSON.parse(receipt.detail_json).risk).toBe('medium');
  });

  test('an omitted purpose defaults and is journaled (issue #306)', () => {
    const { cred } = grantedAgent();
    const outcome = gw.invoke(cred, {
      command: 'schedule.propose_event',
      input: proposeInput(),
    });
    expect(outcome.status).toBe('executed');
    if (outcome.status !== 'executed') return;
    const receipt = db.journal
      .prepare('SELECT purpose_concept_id FROM consent_receipt WHERE receipt_id = ?')
      .get(outcome.receiptId) as { purpose_concept_id: string | null };
    expect(receipt.purpose_concept_id).toBe('dpv:ServiceProvision');
    // A purposeless read rides the same default and still receipts it.
    const read = gw.read(cred, { entity: 'schedule.calendar' });
    const readReceipt = db.journal
      .prepare('SELECT purpose_concept_id FROM consent_receipt WHERE receipt_id = ?')
      .get(read.receiptId) as { purpose_concept_id: string | null };
    expect(readReceipt.purpose_concept_id).toBe('dpv:ServiceProvision');
  });

  test('consent.policy purpose rules still evaluate when a purpose IS supplied (issue #306)', () => {
    db.vault
      .prepare(
        `INSERT INTO consent_policy (policy_id, kind, applies_schema, applies_table, rule_json, retention_days, residency_region, effective_from, priority)
         VALUES (?, 'purpose', 'schedule', NULL, '{"allowed_purposes":["dpv:ServiceProvision"]}', NULL, NULL, '2020-01-01T00:00:00Z', 1)`,
      )
      .run(uuidv7());
    const { cred } = grantedAgent();
    const denied = gw.invoke(cred, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:Billing',
    });
    expect(denied.status).toBe('denied');
    if (denied.status === 'denied') expect(denied.reason).toContain('policy forbids');
    // The defaulted purpose satisfies the same policy.
    const allowed = gw.invoke(cred, {
      command: 'schedule.propose_event',
      input: proposeInput(),
    });
    expect(allowed.status).toBe('executed');
  });

  test('owner denial of a parked invocation is receipted as deny', () => {
    db.vault
      .prepare(
        `UPDATE agent_capability SET requires_confirmation=1
          WHERE command_id = (SELECT command_id FROM agent_command WHERE name='schedule.propose_event')`,
      )
      .run();
    const { cred } = grantedAgent();
    const parked = gw.invoke(cred, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
    });
    if (parked.status !== 'parked') throw new Error('expected parked');
    const outcome = gw.confirm(owner, parked.invocationId, false);
    expect(outcome.status).toBe('denied');
    const events = db.vault.prepare('SELECT count(*) AS n FROM core_event').get() as { n: number };
    expect(events.n).toBe(0);
  });

  test('denial survives a journal-to-vault settlement crash and an approval retry', () => {
    db.vault
      .prepare(
        `UPDATE agent_capability SET requires_confirmation=1
          WHERE command_id = (SELECT command_id FROM agent_command WHERE name='schedule.propose_event')`,
      )
      .run();
    const { cred } = grantedAgent();
    const intentId = 'offline-intent-denial-crash';
    recordReplicaIntentOutcome(db.vault, {
      intentId,
      deviceId: 'remote-device-denial-crash',
      appId: 'agenda',
      action: 'propose',
      payloadHash: 'sha256:offline-intent-denial-crash',
      status: 'sending',
    });
    const parked = gw.invoke(cred, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
      invocationId: intentId,
      intentId,
    });
    if (parked.status !== 'parked') throw new Error('expected parked');
    db.vault.exec(`CREATE TEMP TRIGGER fail_denial_settlement
      BEFORE UPDATE ON replica_intent_outcome BEGIN
        SELECT RAISE(ABORT, 'synthetic denial settlement crash');
      END`);

    expect(() => gw.confirm(owner, parked.invocationId, false)).toThrow(/denial settlement crash/);
    expect(readDurableParkedPayload(db, parked.invocationId)).toBeDefined();
    expect(
      readReplicaIntentOutcome(db.vault, intentId, 'remote-device-denial-crash'),
    ).toMatchObject({ status: 'sending' });
    expect(
      db.journal
        .prepare(
          `SELECT count(*) AS n FROM consent_receipt
            WHERE invocation_id = ? AND decision = 'deny'`,
        )
        .get(parked.invocationId),
    ).toEqual({ n: 1 });

    db.vault.exec('DROP TRIGGER fail_denial_settlement');
    gw = createGateway(db);
    registerScheduleCommands(gw);
    const recovered = gw.confirm(owner, parked.invocationId, true);

    expect(recovered).toMatchObject({
      status: 'denied',
      invocationId: parked.invocationId,
      reason: 'owner denied confirmation',
    });
    expect(readDurableParkedPayload(db, parked.invocationId)).toBeUndefined();
    expect(
      readReplicaIntentOutcome(db.vault, intentId, 'remote-device-denial-crash'),
    ).toMatchObject({ status: 'denied', invocationId: parked.invocationId });
    expect(db.vault.prepare('SELECT count(*) AS n FROM core_event').get()).toEqual({ n: 0 });
    expect(
      db.journal
        .prepare('SELECT count(*) AS n FROM agent_explanation WHERE invocation_id = ?')
        .get(parked.invocationId),
    ).toEqual({ n: 1 });
  });

  test('revoking a replica device makes all of its parked payloads unapprovable', () => {
    db.vault
      .prepare(
        `UPDATE agent_capability SET requires_confirmation=1
          WHERE command_id = (SELECT command_id FROM agent_command WHERE name='schedule.propose_event')`,
      )
      .run();
    const { cred } = grantedAgent();
    const intentId = 'offline-intent-device-revoked';
    const deviceId = 'remote-device-unpaired';
    recordReplicaIntentOutcome(db.vault, {
      intentId,
      deviceId,
      appId: 'agenda',
      action: 'propose',
      payloadHash: 'sha256:offline-intent-device-revoked',
      status: 'sending',
    });
    const parked = gw.invoke(cred, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
      invocationId: intentId,
      intentId,
    });
    if (parked.status !== 'parked') throw new Error('expected parked');

    expect(deleteReplicaIntentOutcomesForDevice(db.vault, deviceId)).toBe(1);

    expect(gw.listParked()).toEqual([]);
    expect(readDurableParkedPayload(db, parked.invocationId)).toBeUndefined();
    expect(() => gw.confirm(owner, parked.invocationId, true)).toThrow(/no parked invocation/);
    expect(db.vault.prepare('SELECT count(*) AS n FROM core_event').get()).toEqual({ n: 0 });
  });

  test('a parked invocation cannot execute after its consent grant is revoked', () => {
    db.vault
      .prepare(
        `UPDATE agent_capability SET requires_confirmation=1
          WHERE command_id = (SELECT command_id FROM agent_command WHERE name='schedule.propose_event')`,
      )
      .run();
    const { cred, grantId } = grantedAgent();
    recordReplicaIntentOutcome(db.vault, {
      intentId: 'offline-intent-revoked-before-confirm',
      deviceId: 'remote-device-revoked',
      appId: 'agenda',
      action: 'propose',
      payloadHash: 'sha256:offline-intent-revoked-before-confirm',
      status: 'sending',
    });
    const parked = gw.invoke(cred, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
      intentId: 'offline-intent-revoked-before-confirm',
    });
    if (parked.status !== 'parked') throw new Error('expected parked');

    // Model a process crash after the grant row committed but before the
    // revocation cascade removed this durable parked payload.
    db.vault
      .prepare(
        `UPDATE consent_access_grant
            SET status = 'revoked', revoked_at = ?
          WHERE grant_id = ?`,
      )
      .run(new Date().toISOString(), grantId);

    const outcome = gw.confirm(owner, parked.invocationId, true);

    expect(outcome).toMatchObject({
      status: 'denied',
      reason: 'consent grant no longer active',
    });
    expect(db.vault.prepare('SELECT count(*) AS n FROM core_event').get()).toEqual({ n: 0 });
    expect(readDurableParkedPayload(db, parked.invocationId)).toBeUndefined();
    expect(
      readReplicaIntentOutcome(
        db.vault,
        'offline-intent-revoked-before-confirm',
        'remote-device-revoked',
      ),
    ).toMatchObject({ status: 'denied', reason: 'consent grant no longer active' });
  });

  test('revocation cascade: agent goes dark instantly, receipts remain', () => {
    const { cred, grantId } = grantedAgent();
    // 2 = the bootstrap-minted default "Personal" calendar + seedCalendar()'s.
    expect(
      gw.read(cred, { entity: 'schedule.calendar', purpose: 'dpv:ServiceProvision' }).rows,
    ).toHaveLength(2);
    const before = db.journal.prepare('SELECT count(*) AS n FROM consent_receipt').get() as {
      n: number;
    };
    const result = gw.revokeGrant(owner, grantId);
    expect(result.grantId).toBe(grantId);
    expect(() =>
      gw.read(cred, { entity: 'schedule.calendar', purpose: 'dpv:ServiceProvision' }),
    ).toThrow(/deny/);
    const after = db.journal.prepare('SELECT count(*) AS n FROM consent_receipt').get() as {
      n: number;
    };
    expect(after.n).toBeGreaterThan(before.n); // history kept, plus new receipts
  });

  test('sweep expires lapsed grants and purges scheduled content', () => {
    const app = enrollApp(db, { name: 'expiring-app' });
    createGrant(db, {
      appId: app.appId,
      purposeConceptId: boot.concepts['dpv:ServiceProvision'] as string,
      grantedByPartyId: boot.ownerPartyId,
      scopes: [{ schema: 'schedule', verbs: 'read' }],
      expiresAt: '2020-01-01T00:00:00Z',
    });
    db.vault
      .prepare(
        `INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, deleted_at, purge_at, created_at)
         VALUES ('c-old', 'text/plain', 'file:///x', 'h1', 1, '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z', '2019-12-31T00:00:00Z')`,
      )
      .run();
    // Tags on the doomed row (its folder filing, its star) purge with it —
    // classification on a gone row is noise, not history (issue #274).
    db.vault
      .prepare(
        `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_at)
         VALUES ('t-old', 'core.content_item', 'c-old', ?, '2020-01-01T00:00:00Z')`,
      )
      .run(boot.concepts['anomaly'] as string);
    const result = gw.sweep(owner);
    expect(result.grantsExpired).toBe(1);
    expect(result.contentPurged).toBe(1);
    const gone = db.vault
      .prepare(`SELECT count(*) AS n FROM core_content_item WHERE content_id='c-old'`)
      .get() as {
      n: number;
    };
    expect(gone.n).toBe(0);
    const tagGone = db.vault
      .prepare(`SELECT count(*) AS n FROM core_tag WHERE tag_id='t-old'`)
      .get() as { n: number };
    expect(tagGone.n).toBe(0);
  });

  test('sweep purges a lapsed trashed asset on its own clock while its rented bytes live on', () => {
    // Live content (an avatar also rents it) + an asset whose grace window
    // has passed: the asset row purges, the bytes stay (issue #274).
    db.vault
      .prepare(
        `INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, created_at)
         VALUES ('c-live', 'image/png', 'data:image/png;base64,xx', 'h2', 2, '2019-12-31T00:00:00Z')`,
      )
      .run();
    db.vault
      .prepare(
        `INSERT INTO media_media_asset (asset_id, content_id, kind, deleted_at, purge_at)
         VALUES ('a-lapsed', 'c-live', 'photo', '2020-01-01T00:00:00Z', '2020-01-31T00:00:00Z')`,
      )
      .run();
    const result = gw.sweep(owner);
    expect(result.assetsPurged).toBe(1);
    const assetGone = db.vault
      .prepare(`SELECT count(*) AS n FROM media_media_asset WHERE asset_id='a-lapsed'`)
      .get() as { n: number };
    expect(assetGone.n).toBe(0);
    const contentStays = db.vault
      .prepare(`SELECT count(*) AS n FROM core_content_item WHERE content_id='c-live'`)
      .get() as { n: number };
    expect(contentStays.n).toBe(1);
  });

  test('readonly device may read but never act', () => {
    const ro = enrollDevice(db, boot.ownerPartyId, 'readonly-tablet', 'readonly');
    const cred: Credential = { kind: 'device', deviceId: ro.deviceId, deviceKey: ro.deviceKey };
    expect(
      gw.read(cred, { entity: 'core.party', purpose: 'dpv:ServiceProvision' }).rows.length,
    ).toBeGreaterThan(0);
    const outcome = gw.invoke(cred, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
    });
    expect(outcome.status).toBe('denied');
  });
});

test('within-next-days filters to the forward horizon window (due soon, not overdue-forever)', () => {
  const cal = seedCalendar();
  const insert = db.vault.prepare(
    `INSERT INTO schedule_task (task_id, owner_party_id, title, status, priority, due_at)
     VALUES (?, ?, ?, 'needs-action', 0, ?)`,
  );
  const now = Date.now();
  const iso = (deltaDays: number): string => new Date(now + deltaDays * 86_400_000).toISOString();
  insert.run(uuidv7(), boot.ownerPartyId, 'due tomorrow', iso(1));
  insert.run(uuidv7(), boot.ownerPartyId, 'due next month', iso(30));
  insert.run(uuidv7(), boot.ownerPartyId, 'overdue last week', iso(-7));
  void cal;

  const result = gw.read(owner, {
    entity: 'schedule.task',
    where: [{ column: 'due_at', op: 'within-next-days', value: 3 }],
    purpose: 'dpv:ServiceProvision',
  });
  expect(result.rows.map((r) => r.title)).toEqual(['due tomorrow']);
});

describe('changes feed (data-trigger outbox)', () => {
  test('bootstrap watermark → writes appear once → cursor advances; denied entity fails closed', () => {
    const cal = seedCalendar();
    const agent = enrollAgent(db, { name: 'reconciler', modelRef: 'test' });
    const agentCred: Credential = {
      kind: 'agent',
      agentId: agent.agentId,
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
    createGrant(db, {
      granteePartyId: agent.partyId,
      purposeConceptId: boot.concepts['dpv:ServiceProvision'] as string,
      grantedByPartyId: boot.ownerPartyId,
      scopes: [
        { schema: 'schedule', verbs: 'read+act' },
        { schema: 'core', table: 'event', verbs: 'read' },
      ],
    });

    // Bootstrap: no rows, a watermark to persist.
    const boot1 = gw.changes(agentCred, {
      entities: ['core.event'],
      purpose: 'dpv:ServiceProvision',
      cursor: null,
    });
    expect(boot1.changes).toEqual([]);

    // A write lands (owner proposes an event) …
    const outcome = gw.invoke(owner, {
      command: 'schedule.propose_event',
      input: proposeInput({ calendar_id: cal }),
      purpose: 'dpv:ServiceProvision',
    });
    expect(outcome.status).toBe('executed');

    // … and the feed surfaces it exactly once.
    const pull = gw.changes(agentCred, {
      entities: ['core.event'],
      purpose: 'dpv:ServiceProvision',
      cursor: boot1.cursor,
    });
    expect(pull.changes.length).toBeGreaterThan(0);
    expect(pull.changes.every((c) => c.entity === 'core.event')).toBe(true);
    expect(pull.cursor > boot1.cursor).toBe(true);
    const again = gw.changes(agentCred, {
      entities: ['core.event'],
      purpose: 'dpv:ServiceProvision',
      cursor: pull.cursor,
    });
    expect(again.changes).toEqual([]);

    // An entity outside the grant denies the WHOLE pull, receipted.
    expect(() =>
      gw.changes(agentCred, {
        entities: ['core.event', 'core.transaction'],
        purpose: 'dpv:ServiceProvision',
        cursor: pull.cursor,
      }),
    ).toThrow(/deny/);
  });

  test('an agent reading the invocation ledger sees only ITS rows (confirmation-resume, structurally scoped)', () => {
    const cal = seedCalendar();
    const a = enrollAgent(db, { name: 'agent-a', modelRef: 'test' });
    const b = enrollAgent(db, { name: 'agent-b', modelRef: 'test' });
    const purposeId = boot.concepts['dpv:ServiceProvision'] as string;
    for (const agent of [a, b]) {
      createGrant(db, {
        granteePartyId: agent.partyId,
        purposeConceptId: purposeId,
        grantedByPartyId: boot.ownerPartyId,
        scopes: [
          { schema: 'schedule', verbs: 'read+act' },
          { schema: 'agent', table: 'command_invocation', verbs: 'read' },
        ],
      });
    }
    const credFor = (agent: { agentId: string }): Credential => ({
      kind: 'agent',
      agentId: agent.agentId,
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    });
    // Each agent invokes once (disjoint windows — no busy conflict).
    [a, b].forEach((agent, i) => {
      const outcome = gw.invoke(credFor(agent), {
        command: 'schedule.propose_event',
        input: proposeInput({
          calendar_id: cal,
          summary: `by ${agent.agentId}`,
          dtstart: `2026-08-0${i + 1}T09:00:00Z`,
          dtend: `2026-08-0${i + 1}T09:15:00Z`,
        }),
        purpose: 'dpv:ServiceProvision',
      });
      expect(outcome.status).toBe('executed');
    });
    const mine = gw.read(credFor(a), {
      entity: 'agent.command_invocation',
      purpose: 'dpv:ServiceProvision',
    });
    expect(mine.rows.length).toBeGreaterThan(0);
    expect(mine.rows.every((r) => r.agent_id === a.agentId)).toBe(true);
  });
});
