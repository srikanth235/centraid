import { beforeEach, describe, expect, test } from 'vitest';
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
    expect(
      gw.read(cred, { entity: 'schedule.calendar', purpose: 'dpv:ServiceProvision' }).rows,
    ).toHaveLength(1);
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
    expect(checks.filter((c) => c.phase === 'pre')).toHaveLength(3);
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
    expect(outcome.predicate).toContain('calendar_exists');
    const events = db.vault.prepare('SELECT count(*) AS n FROM core_event').get() as { n: number };
    expect(events.n).toBe(0);
    const inv = db.journal
      .prepare('SELECT status FROM agent_command_invocation WHERE invocation_id = ?')
      .get(outcome.invocationId) as { status: string };
    expect(inv.status).toBe('failed');
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
    if (outcome.status === 'failed') expect(outcome.predicate).toContain('no_busy_conflict');
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
    const replay = gw.invoke(owner, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
      invocationId,
    });
    expect(replay.status).toBe('replayed');
    const events = db.vault.prepare('SELECT count(*) AS n FROM core_event').get() as { n: number };
    expect(events.n).toBe(1);
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

  test('agent invoking a high-risk command parks; owner approval executes it', () => {
    // Raise the command's risk to high so it exceeds the agent's medium ceiling.
    db.vault
      .prepare(`UPDATE agent_command SET risk='high' WHERE name='schedule.propose_event'`)
      .run();
    const { cred } = grantedAgent();
    const parked = gw.invoke(cred, {
      command: 'schedule.propose_event',
      input: proposeInput(),
      purpose: 'dpv:ServiceProvision',
    });
    expect(parked.status).toBe('parked');
    if (parked.status !== 'parked') return;
    expect(gw.listParked()).toHaveLength(1);
    const outcome = gw.confirm(owner, parked.invocationId, true);
    expect(outcome.status).toBe('executed');
    if (outcome.status !== 'executed') return;
    const receipt = db.journal
      .prepare('SELECT detail_json FROM consent_receipt WHERE receipt_id = ?')
      .get(outcome.receiptId) as { detail_json: string };
    expect(JSON.parse(receipt.detail_json).confirmation.confirmedBy).toBe(boot.ownerPartyId);
  });

  test('owner denial of a parked invocation is receipted as deny', () => {
    db.vault
      .prepare(`UPDATE agent_command SET risk='high' WHERE name='schedule.propose_event'`)
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

  test('revocation cascade: agent goes dark instantly, receipts remain', () => {
    const { cred, grantId } = grantedAgent();
    expect(
      gw.read(cred, { entity: 'schedule.calendar', purpose: 'dpv:ServiceProvision' }).rows,
    ).toHaveLength(1);
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
    const result = gw.sweep(owner);
    expect(result.grantsExpired).toBe(1);
    expect(result.contentPurged).toBe(1);
    const gone = db.vault
      .prepare(`SELECT count(*) AS n FROM core_content_item WHERE content_id='c-old'`)
      .get() as {
      n: number;
    };
    expect(gone.n).toBe(0);
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
