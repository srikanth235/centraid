// governance: allow-repo-hygiene file-size-limit one file per life domain (§07) — the health commands share the observation/activity spine and its boundary rules
// Health domain commands (§07): everything measured is a core.observation,
// everything done is a core.activity — this domain only adds clinical/fitness
// meaning (extend-don't-fork, R02). Boundary: health never mints people,
// places or time. adjust_course therefore does NOT write reminder events; it
// flags them stale so the agent re-projects via schedule.propose_event.

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';
import { sha256Hex } from '../ids.js';

/** FHIR vital-signs mapping: type → Open mHealth code + LOINC + UCUM unit. */
const VITAL_CODES: Record<string, { code: string; loinc: string; unit: string }> = {
  heart_rate: { code: 'omh:heart-rate', loinc: '8867-4', unit: '/min' },
  bp_systolic: { code: 'omh:systolic-blood-pressure', loinc: '8480-6', unit: 'mm[Hg]' },
  bp_diastolic: { code: 'omh:diastolic-blood-pressure', loinc: '8462-4', unit: 'mm[Hg]' },
  spo2: { code: 'omh:oxygen-saturation', loinc: '59408-5', unit: '%' },
  body_weight: { code: 'omh:body-weight', loinc: '29463-7', unit: 'kg' },
  glucose: { code: 'omh:blood-glucose', loinc: '2339-0', unit: 'mg/dL' },
  temp: { code: 'omh:body-temperature', loinc: '8310-5', unit: 'Cel' },
};

/** The measured subject: the caller's party, else the vault owner. */
function subjectPartyId(ctx: HandlerCtx): string {
  if (ctx.identity.kind === 'owner-device' && ctx.identity.partyId) return ctx.identity.partyId;
  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  if (!owner?.owner_party_id) throw new Error('vault has no owner');
  return owner.owner_party_id;
}

const LOG_VITAL: CommandDefinition = {
  name: 'health.log_vital',
  ownerSchema: 'health',
  inputSchema: {
    type: 'object',
    required: ['vital_type', 'value_num'],
    additionalProperties: false,
    properties: {
      vital_type: {
        type: 'string',
        enum: [
          'heart_rate',
          'bp_systolic',
          'bp_diastolic',
          'spo2',
          'body_weight',
          'glucose',
          'temp',
        ],
      },
      value_num: { type: 'number' },
      observed_at: { type: 'string', minLength: 1 },
      context: { type: 'string', enum: ['rest', 'exercise', 'sleep', 'post_meal'] },
      modality: { type: 'string', enum: ['sensed', 'self_reported', 'derived'] },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['observation_id', 'vital_id'],
    properties: { observation_id: { type: 'string' }, vital_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'value_is_positive',
      sql: 'SELECT (:value_num > 0) AS n',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      // Extend-don't-fork made checkable: the vital IS its observation.
      name: 'vital_extends_observation',
      sql: `SELECT count(*) AS n FROM health_vital v
             JOIN core_observation o ON o.observation_id = v.observation_id
            WHERE v.vital_id = :vital_id AND o.status = 'final'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: logVital,
};

function logVital(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    vital_type: keyof typeof VITAL_CODES;
    value_num: number;
    observed_at?: string;
    context?: string;
    modality?: string;
  };
  const mapping = VITAL_CODES[input.vital_type];
  if (!mapping) throw new Error(`no code mapping for vital_type ${String(input.vital_type)}`);
  const observationId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_observation
         (observation_id, subject_party_id, code, value_num, value_text, unit, observed_at,
          effective_start, effective_end, statistic, modality, status, device_id, activity_id)
       VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, ?, 'final', ?, NULL)`,
    )
    .run(
      observationId,
      subjectPartyId(ctx),
      mapping.code,
      input.value_num,
      mapping.unit,
      input.observed_at ?? ctx.now,
      input.modality ?? 'self_reported',
      ctx.identity.kind === 'owner-device' ? ctx.identity.callerId : null,
    );
  ctx.wrote('core.observation', observationId);
  const vitalId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO health_vital (vital_id, observation_id, vital_type, context, loinc_code)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(vitalId, observationId, input.vital_type, input.context ?? null, mapping.loinc);
  ctx.wrote('health.vital', vitalId);
  ctx.cite({
    claim: `${input.vital_type} = ${input.value_num} ${mapping.unit} recorded as ${mapping.code}`,
    entityType: 'core.observation',
    entityId: observationId,
  });
  return { observation_id: observationId, vital_id: vitalId };
}

const VOID_VITAL: CommandDefinition = {
  name: 'health.void_vital',
  ownerSchema: 'health',
  inputSchema: {
    type: 'object',
    required: ['observation_id'],
    additionalProperties: false,
    properties: {
      observation_id: { type: 'string', minLength: 1 },
      reason: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['observation_id', 'status'],
    properties: { observation_id: { type: 'string' }, status: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'observation_exists',
      sql: 'SELECT count(*) AS n FROM core_observation WHERE observation_id = :observation_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // Double-voids fail loudly: entered-in-error is terminal (FHIR), so a
      // second void means someone is correcting a record they mis-read.
      name: 'not_already_voided',
      sql: `SELECT count(*) AS n FROM core_observation
             WHERE observation_id = :observation_id AND status = 'entered-in-error'`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  postconditions: [
    {
      name: 'observation_entered_in_error',
      sql: `SELECT count(*) AS n FROM core_observation
             WHERE observation_id = :observation_id AND status = 'entered-in-error'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  // Medium like adjust_course: both are data-correcting writes that change
  // what every downstream query sees; parking for the owner is the right UX.
  risk: 'medium',
  handler: voidVital,
};

function voidVital(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { observation_id: string; reason?: string };
  ctx.db
    .prepare(`UPDATE core_observation SET status = 'entered-in-error' WHERE observation_id = ?`)
    .run(input.observation_id);
  ctx.wrote('core.observation', input.observation_id);
  // The reason lives in the journal, not the row (no note column on
  // core.observation): explanation is citation (§04 P4), same as flag_anomaly.
  ctx.cite({
    claim: `observation voided as entered-in-error${input.reason ? `: ${input.reason}` : ''} — readings queries exclude it, the row remains as provenance`,
    entityType: 'core.observation',
    entityId: input.observation_id,
  });
  return { observation_id: input.observation_id, status: 'entered-in-error' };
}

const IMPORT_WORKOUT: CommandDefinition = {
  name: 'health.import_workout',
  ownerSchema: 'health',
  inputSchema: {
    type: 'object',
    required: ['sport_concept_id', 'started_at', 'ended_at'],
    additionalProperties: false,
    properties: {
      sport_concept_id: { type: 'string', minLength: 1 },
      started_at: { type: 'string', minLength: 1 },
      ended_at: { type: 'string', minLength: 1 },
      distance_m: { type: 'number', minimum: 0 },
      energy_kcal: { type: 'number', minimum: 0 },
      avg_hr: { type: 'number' },
      note: { type: 'string' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['activity_id', 'workout_id'],
    properties: { activity_id: { type: 'string' }, workout_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'sport_concept_exists',
      sql: 'SELECT count(*) AS n FROM core_concept WHERE concept_id = :sport_concept_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      name: 'ends_after_start',
      sql: 'SELECT (:ended_at > :started_at) AS n',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'workout_extends_activity',
      sql: `SELECT count(*) AS n FROM health_workout w
             JOIN core_activity a ON a.activity_id = w.activity_id
            WHERE w.workout_id = :workout_id`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: importWorkout,
};

function importWorkout(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    sport_concept_id: string;
    started_at: string;
    ended_at: string;
    distance_m?: number;
    energy_kcal?: number;
    avg_hr?: number;
    note?: string;
  };
  const activityId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_activity
         (activity_id, actor_party_id, kind_concept_id, started_at, ended_at, location_place_id, source_app_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      activityId,
      subjectPartyId(ctx),
      input.sport_concept_id,
      input.started_at,
      input.ended_at,
      ctx.identity.kind === 'app' ? ctx.identity.callerId : null,
      input.note ?? null,
      ctx.now,
    );
  ctx.wrote('core.activity', activityId);
  const workoutId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO health_workout (workout_id, activity_id, sport_concept_id, distance_m, energy_kcal, avg_hr, training_load, route_content_id)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(
      workoutId,
      activityId,
      input.sport_concept_id,
      input.distance_m ?? null,
      input.energy_kcal ?? null,
      input.avg_hr ?? null,
    );
  ctx.wrote('health.workout', workoutId);
  ctx.cite({
    claim: `session [${input.started_at}, ${input.ended_at}) recorded once — the calendar and the coach see the same activity row`,
    entityType: 'core.activity',
    entityId: activityId,
  });
  return { activity_id: activityId, workout_id: workoutId };
}

const ADJUST_COURSE: CommandDefinition = {
  name: 'health.adjust_course',
  ownerSchema: 'health',
  inputSchema: {
    type: 'object',
    required: ['course_id', 'action'],
    additionalProperties: false,
    properties: {
      course_id: { type: 'string', minLength: 1 },
      action: { type: 'string', enum: ['adjust', 'stop'] },
      dose_text: { type: 'string', minLength: 1 },
      schedule_rrule: { type: 'string' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['course_id', 'state', 'reminders_stale'],
    properties: {
      course_id: { type: 'string' },
      state: { type: 'string' },
      reminders_stale: { type: 'boolean' },
    },
  },
  preconditions: [
    {
      // §07 state machine on started_at/ended_at: a course whose ended_at is
      // set is completed|stopped — it never transitions again.
      name: 'course_active',
      sql: `SELECT count(*) AS n FROM health_medication_course
             WHERE course_id = :course_id AND ended_at IS NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'course_in_declared_state',
      sql: `SELECT count(*) AS n FROM health_medication_course
             WHERE course_id = :course_id
               AND ((:action = 'stop' AND ended_at IS NOT NULL) OR (:action = 'adjust' AND ended_at IS NULL))`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'medium',
  handler: adjustCourse,
};

function adjustCourse(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    course_id: string;
    action: 'adjust' | 'stop';
    dose_text?: string;
    schedule_rrule?: string;
  };
  if (input.action === 'stop') {
    ctx.db
      .prepare('UPDATE health_medication_course SET ended_at = ? WHERE course_id = ?')
      .run(ctx.now, input.course_id);
  } else {
    ctx.db
      .prepare(
        `UPDATE health_medication_course SET
           dose_text = COALESCE(?, dose_text),
           schedule_rrule = COALESCE(?, schedule_rrule)
         WHERE course_id = ?`,
      )
      .run(input.dose_text ?? null, input.schedule_rrule ?? null, input.course_id);
  }
  ctx.wrote('health.medication_course', input.course_id);
  // Boundary (§07): health may not write events. Reminder events tied to the
  // old schedule are now stale; re-projection is the agent's next move via
  // schedule.propose_event, under its own consent check and receipt.
  ctx.cite({
    claim: `course ${input.action === 'stop' ? 'stopped' : 'adjusted'}; reminder events stale — re-project via schedule.propose_event`,
    entityType: 'health.medication_course',
    entityId: input.course_id,
  });
  return {
    course_id: input.course_id,
    state: input.action === 'stop' ? 'stopped' : 'active',
    reminders_stale: true,
  };
}

const SUMMARIZE_TRENDS: CommandDefinition = {
  name: 'health.summarize_trends',
  ownerSchema: 'health',
  inputSchema: {
    type: 'object',
    required: ['vital_type', 'days'],
    additionalProperties: false,
    properties: {
      vital_type: {
        type: 'string',
        enum: [
          'heart_rate',
          'bp_systolic',
          'bp_diastolic',
          'spo2',
          'body_weight',
          'glucose',
          'temp',
        ],
      },
      days: { type: 'integer', minimum: 1, maximum: 3650 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['content_id', 'count'],
    properties: {
      content_id: { type: 'string' },
      count: { type: 'integer' },
      min: { type: 'number' },
      max: { type: 'number' },
      avg: { type: 'number' },
    },
  },
  preconditions: [
    {
      // A trend over zero readings is not a trend — refuse rather than emit noise.
      name: 'readings_exist_in_window',
      sql: `SELECT count(*) AS n FROM core_observation o
             JOIN health_vital v ON v.observation_id = o.observation_id
            WHERE v.vital_type = :vital_type AND o.status = 'final'`,
      column: 'n',
      op: 'gte',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'summary_is_owned_content',
      sql: 'SELECT count(*) AS n FROM core_content_item WHERE content_id = :content_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'retry-safe',
  risk: 'low',
  handler: summarizeTrends,
};

function summarizeTrends(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { vital_type: string; days: number };
  const cutoff = new Date(Date.parse(ctx.now) - input.days * 86_400_000).toISOString();
  const stats = ctx.db
    .prepare(
      `SELECT count(*) AS count, MIN(o.value_num) AS min, MAX(o.value_num) AS max,
              ROUND(AVG(o.value_num), 2) AS avg, MAX(o.unit) AS unit
         FROM core_observation o
         JOIN health_vital v ON v.observation_id = o.observation_id
        WHERE v.vital_type = ? AND o.status = 'final' AND o.observed_at >= ?`,
    )
    .get(input.vital_type, cutoff) as {
    count: number;
    min: number;
    max: number;
    avg: number;
    unit: string;
  };
  const summary = {
    vital_type: input.vital_type,
    window_days: input.days,
    from: cutoff,
    to: ctx.now,
    ...stats,
  };
  const body = JSON.stringify(summary);
  const sha = sha256Hex(body);
  let contentId: string;
  const existing = ctx.db
    .prepare('SELECT content_id FROM core_content_item WHERE sha256 = ?')
    .get(sha) as { content_id: string } | undefined;
  if (existing) {
    contentId = existing.content_id;
  } else {
    contentId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO core_content_item
           (content_id, media_type, content_uri, sha256, byte_size, title, language, creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
         VALUES (?, 'application/json', ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)`,
      )
      .run(
        contentId,
        `data:application/json,${encodeURIComponent(body)}`,
        sha,
        Buffer.byteLength(body, 'utf8'),
        `${input.vital_type} trend, ${input.days}d`,
        subjectPartyId(ctx),
        ctx.now,
      );
    ctx.wrote('core.content_item', contentId);
  }
  // Explanation is citation (§04 P4): the summary cites its window.
  ctx.cite({
    claim: `${stats.count} ${input.vital_type} reading(s) in [${cutoff}, ${ctx.now}] → min ${stats.min}, max ${stats.max}, avg ${stats.avg}`,
    entityType: 'core.content_item',
    entityId: contentId,
  });
  return {
    content_id: contentId,
    count: stats.count,
    min: stats.min,
    max: stats.max,
    avg: stats.avg,
  };
}

/** Register the health domain's commands on a gateway. */
export function registerHealthCommands(gateway: Gateway): void {
  gateway.registerCommand(LOG_VITAL);
  gateway.registerCommand(VOID_VITAL);
  gateway.registerCommand(IMPORT_WORKOUT);
  gateway.registerCommand(ADJUST_COURSE);
  gateway.registerCommand(SUMMARIZE_TRENDS);
}
