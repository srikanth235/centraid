import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, createGrant, enrollApp, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { uuidv7 } from '../ids.js';
import { registerHealthCommands } from './health.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerHealthCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

function logVital(value: number, observedAt?: string): void {
  const outcome = gw.invoke(owner, {
    command: 'health.log_vital',
    input: {
      vital_type: 'heart_rate',
      value_num: value,
      ...(observedAt ? { observed_at: observedAt } : {}),
    },
    purpose: 'dpv:HealthMonitoring',
  });
  if (outcome.status !== 'executed')
    throw new Error(`log_vital failed: ${JSON.stringify(outcome)}`);
}

test('log_vital: the reading IS an observation, plus clinical columns (R02)', () => {
  const outcome = gw.invoke(owner, {
    command: 'health.log_vital',
    input: { vital_type: 'body_weight', value_num: 62.4, context: 'rest', modality: 'sensed' },
    purpose: 'dpv:HealthMonitoring',
  });
  expect(outcome.status).toBe('executed');
  if (outcome.status !== 'executed') return;
  const { observation_id, vital_id } = outcome.output as {
    observation_id: string;
    vital_id: string;
  };
  const observation = db.vault
    .prepare(
      'SELECT code, unit, modality, status, subject_party_id FROM core_observation WHERE observation_id = ?',
    )
    .get(observation_id);
  expect(observation).toMatchObject({
    code: 'omh:body-weight',
    unit: 'kg',
    modality: 'sensed',
    status: 'final',
    subject_party_id: boot.ownerPartyId,
  });
  const vital = db.vault
    .prepare('SELECT vital_type, loinc_code, context FROM health_vital WHERE vital_id = ?')
    .get(vital_id);
  expect(vital).toMatchObject({
    vital_type: 'body_weight',
    loinc_code: '29463-7',
    context: 'rest',
  });
});

test('log_vital refuses non-positive values at the contract', () => {
  const outcome = gw.invoke(owner, {
    command: 'health.log_vital',
    input: { vital_type: 'heart_rate', value_num: -3 },
    purpose: 'dpv:HealthMonitoring',
  });
  expect(outcome.status).toBe('failed');
  if (outcome.status === 'failed') expect(outcome.predicate).toContain('value_is_positive');
});

test('import_workout: one span, two lenses — activity in core, load in health', () => {
  const outcome = gw.invoke(owner, {
    command: 'health.import_workout',
    input: {
      sport_concept_id: boot.concepts['run'] as string,
      started_at: '2026-07-02T06:00:00Z',
      ended_at: '2026-07-02T06:42:00Z',
      distance_m: 8000,
      energy_kcal: 512,
      avg_hr: 152,
    },
    purpose: 'dpv:HealthMonitoring',
  });
  expect(outcome.status).toBe('executed');
  if (outcome.status !== 'executed') return;
  const { activity_id, workout_id } = outcome.output as { activity_id: string; workout_id: string };
  const activity = db.vault
    .prepare('SELECT actor_party_id, kind_concept_id FROM core_activity WHERE activity_id = ?')
    .get(activity_id);
  expect(activity).toMatchObject({
    actor_party_id: boot.ownerPartyId,
    kind_concept_id: boot.concepts['run'],
  });
  const workout = db.vault
    .prepare('SELECT activity_id, distance_m, avg_hr FROM health_workout WHERE workout_id = ?')
    .get(workout_id);
  expect(workout).toMatchObject({ activity_id, distance_m: 8000, avg_hr: 152 });
});

function seedCourse(): string {
  const courseId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO health_medication_course (course_id, subject_party_id, name, dose_text, schedule_rrule, started_at)
       VALUES (?, ?, 'Metoprolol', '25 mg twice daily', 'FREQ=DAILY;COUNT=2', '2026-06-01T00:00:00Z')`,
    )
    .run(courseId, boot.ownerPartyId);
  return courseId;
}

test('adjust_course: dose change keeps the course active and flags reminders stale', () => {
  const courseId = seedCourse();
  const outcome = gw.invoke(owner, {
    command: 'health.adjust_course',
    input: { course_id: courseId, action: 'adjust', dose_text: '50 mg twice daily' },
    purpose: 'dpv:HealthMonitoring',
  });
  expect(outcome.status).toBe('executed');
  if (outcome.status !== 'executed') return;
  expect(outcome.output).toMatchObject({ state: 'active', reminders_stale: true });
  const course = db.vault
    .prepare('SELECT dose_text, ended_at FROM health_medication_course WHERE course_id = ?')
    .get(courseId);
  expect(course).toMatchObject({ dose_text: '50 mg twice daily', ended_at: null });
  // Boundary held: the health command wrote no events.
  const events = db.vault.prepare('SELECT count(*) AS n FROM core_event').get() as { n: number };
  expect(events.n).toBe(0);
});

test('adjust_course: stop ends the course; a stopped course never transitions again', () => {
  const courseId = seedCourse();
  const stop = gw.invoke(owner, {
    command: 'health.adjust_course',
    input: { course_id: courseId, action: 'stop' },
    purpose: 'dpv:HealthMonitoring',
  });
  expect(stop.status).toBe('executed');
  const again = gw.invoke(owner, {
    command: 'health.adjust_course',
    input: { course_id: courseId, action: 'adjust', dose_text: '10 mg' },
    purpose: 'dpv:HealthMonitoring',
  });
  expect(again.status).toBe('failed');
  if (again.status === 'failed') expect(again.predicate).toContain('course_active');
});

test('summarize_trends: the 90-day picture becomes an owned content item with cited stats', () => {
  logVital(58, '2026-06-20T07:00:00Z');
  logVital(62, '2026-06-25T07:00:00Z');
  logVital(66, '2026-07-01T07:00:00Z');
  const outcome = gw.invoke(owner, {
    command: 'health.summarize_trends',
    input: { vital_type: 'heart_rate', days: 90 },
    purpose: 'dpv:HealthMonitoring',
  });
  expect(outcome.status).toBe('executed');
  if (outcome.status !== 'executed') return;
  const output = outcome.output as {
    content_id: string;
    count: number;
    min: number;
    max: number;
    avg: number;
  };
  expect(output).toMatchObject({ count: 3, min: 58, max: 66, avg: 62 });
  const content = db.vault
    .prepare('SELECT media_type, title FROM core_content_item WHERE content_id = ?')
    .get(output.content_id);
  expect(content).toMatchObject({ media_type: 'application/json', title: 'heart_rate trend, 90d' });
  const evidence = db.journal
    .prepare('SELECT claim FROM agent_evidence WHERE invocation_id = ?')
    .get(outcome.invocationId) as { claim: string };
  expect(evidence.claim).toContain('3 heart_rate reading(s)');
});

test('summarize_trends refuses an empty window — a trend over nothing is noise', () => {
  const outcome = gw.invoke(owner, {
    command: 'health.summarize_trends',
    input: { vital_type: 'glucose', days: 30 },
    purpose: 'dpv:HealthMonitoring',
  });
  expect(outcome.status).toBe('failed');
  if (outcome.status === 'failed') expect(outcome.predicate).toContain('readings_exist_in_window');
});

test('condition rows are excluded from default scopes: schema-wide grant denies, explicit scope allows', () => {
  db.vault
    .prepare(
      `INSERT INTO health_condition (condition_id, subject_party_id, label, status)
       VALUES ('cond1', ?, 'Hypertension', 'active')`,
    )
    .run(boot.ownerPartyId);
  const app = enrollApp(db, { name: 'vitals-dashboard' });
  createGrant(db, {
    appId: app.appId,
    purposeConceptId: boot.concepts['dpv:HealthMonitoring'] as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [{ schema: 'health', verbs: 'read' }], // whole schema — the default
  });
  const cred: Credential = { kind: 'app', appId: app.appId, signingKey: app.signingKey };
  // Vitals ride the schema-wide scope…
  expect(gw.read(cred, { entity: 'health.vital', purpose: 'dpv:HealthMonitoring' }).rows).toEqual(
    [],
  );
  // …conditions do not (§03: highest-sensitivity table).
  expect(() =>
    gw.read(cred, { entity: 'health.condition', purpose: 'dpv:HealthMonitoring' }),
  ).toThrow(/deny/);
  // The owner explicitly scoping the table is what unlocks it.
  createGrant(db, {
    appId: app.appId,
    purposeConceptId: boot.concepts['dpv:HealthMonitoring'] as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [{ schema: 'health', table: 'condition', verbs: 'read' }],
  });
  const rows = gw.read(cred, { entity: 'health.condition', purpose: 'dpv:HealthMonitoring' }).rows;
  expect(rows).toHaveLength(1);
  // The owner reads their own conditions regardless — minimization clamps grants, not ownership.
  expect(
    gw.read(owner, { entity: 'health.condition', purpose: 'dpv:HealthMonitoring' }).rows,
  ).toHaveLength(1);
});
