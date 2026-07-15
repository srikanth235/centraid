// governance: allow-repo-hygiene file-size-limit (#406) consent selection, temporal membership, and opaque row identity form one security boundary
// Server-derived replica shapes (issue #406): existing app consent scopes
// intersected with the ambient device trust tier. There is no replica field
// in app manifests; this module projects the grants already enforced by the
// vault gateway into a row/column-minimized offline shape.

import crypto from 'node:crypto';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import {
  compileFilters,
  compileReplicaHistoricalFilters,
  currentReplicaLogState,
  evaluateConsent,
  listVaultEntities,
  readReplicaRows,
  replicaUnavailableColumnsOf,
  resolveEntity,
  type FilterClause,
  type ConsentAllow,
  type ReplicaRow,
} from '@centraid/vault';

export const REPLICA_PROTOCOL_VERSION = 1 as const;
export const REPLICA_MAX_VALUE_BYTES = 64 * 1024;
export const REPLICA_SYNTHETIC_PRIMARY_KEY = '__centraid_row_id';

export interface ReplicaShapeAccess {
  trust: 'full' | 'readonly';
  rememberDevice: boolean;
  /** Trusted web-app session header or an explicit shell selection. */
  appId?: string;
}

export interface ReplicaEntitySchemaWire {
  entity: string;
  primaryKey: string;
  columns: string[];
  /** Some undisclosed fields exist; names and values never cross the wire. */
  hasUnavailableFields?: boolean;
}

export interface ReplicaShapeWire {
  shapeId: string;
  appId: string;
  purpose: string;
  entities: ReplicaEntitySchemaWire[];
}

interface ReplicaGrantee {
  app_id: string;
  app_name: string;
  signing_key: string | null;
  purpose: string;
}

interface ScopeAlternative {
  filters: FilterClause[];
  columns: string[];
  membership: StatementSync;
  membershipParams: (string | number)[];
  historicalMembership: StatementSync;
  historicalParams: (string | number)[];
}

export interface ReplicaEntityShape extends ReplicaEntitySchemaWire {
  alternatives: ScopeAlternative[];
  physical: string;
  keyColumns: string[];
}

export interface ReplicaServerShape extends ReplicaShapeWire {
  entities: ReplicaEntityShape[];
  entityMap: Map<string, ReplicaEntityShape>;
  /** Epoch-scoped derivative of the app credential; never serialized. */
  rowKeySecret: string;
}

interface TableColumn {
  name: string;
  type: string;
  pk: number;
}

interface TemporalFingerprintCacheEntry {
  epoch: string;
  watermarkSeq: number;
  computedAt: number;
  validUntil: number;
  digest: string;
}

const DAY_MS = 86_400_000;
const temporalFingerprintCache = new WeakMap<
  DatabaseSync,
  Map<string, TemporalFingerprintCacheEntry>
>();

function tableColumns(db: DatabaseSync, physical: string): TableColumn[] {
  return db
    .prepare(`PRAGMA table_info(${JSON.stringify(physical)})`)
    .all() as unknown as TableColumn[];
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function readGrantees(db: DatabaseSync, now: string, appId?: string): ReplicaGrantee[] {
  const restriction = appId ? ` AND (a.name = ? OR a.app_id = ?)` : '';
  return db
    .prepare(
      `SELECT DISTINCT a.app_id, a.name AS app_name, a.signing_key,
              c.notation AS purpose
         FROM consent_app a
         JOIN consent_access_grant g ON g.app_id = a.app_id
         JOIN core_concept c ON c.concept_id = g.purpose_concept_id
         JOIN consent_grant_scope s ON s.grant_id = g.grant_id
        WHERE a.status = 'active'
          AND g.status = 'active' AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at > ?)
          AND s.verbs IN ('read', 'read+act')${restriction}
        ORDER BY a.name, c.notation`,
    )
    .all(now, ...(appId ? [appId, appId] : [])) as unknown as ReplicaGrantee[];
}

function alternativeFor(
  db: DatabaseSync,
  physical: string,
  scope: Pick<ConsentAllow, 'rowFilter' | 'fieldMask'>,
  columns: TableColumn[],
  keyColumns: string[],
  unavailable: Set<string>,
  now: string,
): ScopeAlternative | undefined {
  const filters = scope.rowFilter;
  const mask = scope.fieldMask;
  if (
    !Array.isArray(filters) ||
    filters.some(
      (filter) =>
        filter === null ||
        typeof filter !== 'object' ||
        typeof filter.column !== 'string' ||
        typeof filter.op !== 'string',
    ) ||
    (mask !== null && (!Array.isArray(mask) || mask.some((column) => typeof column !== 'string')))
  ) {
    return undefined;
  }
  const actual = new Set(columns.map((column) => column.name));
  // A malformed or unavailable-value filter fails closed; membership must never
  // become broader merely because a replica cannot evaluate the predicate.
  if (filters.some((filter) => !actual.has(filter.column) || unavailable.has(filter.column))) {
    return undefined;
  }
  if (keyColumns.length === 0 || keyColumns.some((column) => unavailable.has(column))) {
    return undefined;
  }
  const allowed =
    mask === null
      ? columns.map((column) => column.name).filter((column) => !unavailable.has(column))
      : mask.filter((column) => actual.has(column) && !unavailable.has(column));
  // Mirrors applyFieldMask: a scope that selects zero real fields is invalid,
  // not an identity-only widening through the replica protocol.
  if (allowed.length === 0) return undefined;
  try {
    const compiled = compileFilters(db, physical, filters, now);
    const historical = compileReplicaHistoricalFilters(db, physical, filters, now);
    const keys = keyColumns.map((column) => `${quoteIdentifier(column)} = ?`).join(' AND ');
    const alternative: ScopeAlternative = {
      filters,
      columns: [...new Set(allowed)],
      membershipParams: compiled.params,
      historicalParams: historical.params,
    } as ScopeAlternative;
    // StatementSync exposes expandedSQL (including last bindings) when
    // enumerated. Keep both statements strictly internal to the server shape.
    Object.defineProperties(alternative, {
      membership: {
        value: db.prepare(
          `SELECT 1 AS matched FROM ${quoteIdentifier(physical)}
            WHERE ${keys} AND (${compiled.where}) LIMIT 1`,
        ),
        enumerable: false,
      },
      historicalMembership: {
        value: db.prepare(
          `WITH replica_old(value) AS (VALUES (?))
           SELECT 1 AS matched WHERE (${historical.where})`,
        ),
        enumerable: false,
      },
    });
    return alternative;
  } catch {
    return undefined;
  }
}

function publicShape(shape: ReplicaServerShape): ReplicaShapeWire {
  return {
    shapeId: shape.shapeId,
    appId: shape.appId,
    purpose: shape.purpose,
    entities: shape.entities.map((entity) => ({
      entity: entity.entity,
      primaryKey: entity.primaryKey,
      columns: [...entity.columns],
      ...(entity.hasUnavailableFields ? { hasUnavailableFields: true } : {}),
    })),
  };
}

function isTemporal(filter: FilterClause): boolean {
  return filter.op === 'within-days' || filter.op === 'within-next-days';
}

function nextTemporalTransition(
  row: ReplicaRow,
  filter: FilterClause,
  nowMs: number,
): number | undefined {
  if (!isTemporal(filter)) return undefined;
  const raw = row.values[filter.column];
  const days = Number(filter.value);
  if (typeof raw !== 'string' || !Number.isFinite(days) || days <= 0) return undefined;
  const at = Date.parse(raw);
  const span = days * DAY_MS;
  if (!Number.isFinite(at) || !Number.isFinite(span)) return undefined;
  if (filter.op === 'within-days') {
    const exit = at + span + 1;
    return Number.isFinite(exit) && exit > nowMs ? exit : undefined;
  }
  const enter = at - span;
  if (Number.isFinite(enter) && nowMs < enter) return enter;
  const exit = at + 1;
  return Number.isFinite(exit) && exit > nowMs ? exit : undefined;
}

function temporalFingerprint(
  db: DatabaseSync,
  appId: string,
  purpose: string,
  entity: ReplicaEntityShape,
  nowMs: number,
): string | undefined {
  if (!entity.alternatives.some((alternative) => alternative.filters.some(isTemporal))) {
    return undefined;
  }
  const state = currentReplicaLogState(db);
  const policy = JSON.stringify(
    entity.alternatives.map((alternative) => ({
      filters: alternative.filters,
      columns: alternative.columns,
    })),
  );
  const key = `${appId}\u0000${purpose}\u0000${entity.entity}\u0000${policy}`;
  const cache =
    temporalFingerprintCache.get(db) ?? new Map<string, TemporalFingerprintCacheEntry>();
  temporalFingerprintCache.set(db, cache);
  const cached = cache.get(key);
  if (
    cached?.epoch === state.epoch &&
    cached.watermarkSeq === state.watermark.seq &&
    nowMs >= cached.computedAt &&
    nowMs < cached.validUntil
  ) {
    return cached.digest;
  }

  const membership: Array<[string, string[]]> = [];
  let validUntil = Number.POSITIVE_INFINITY;
  let after: string | undefined;
  do {
    const page = readReplicaRows(db, entity.entity, {
      ...(after ? { after } : {}),
      limit: 10_000,
      maxValueBytes: REPLICA_MAX_VALUE_BYTES,
    });
    for (const row of page.rows) {
      const applicable = entity.alternatives.filter((alternative) =>
        alternativeMatches(entity, row, alternative),
      );
      if (applicable.length > 0) {
        const columns = new Set(applicable.flatMap((alternative) => alternative.columns));
        if (entity.primaryKey === REPLICA_SYNTHETIC_PRIMARY_KEY) {
          columns.add(REPLICA_SYNTHETIC_PRIMARY_KEY);
        }
        membership.push([row.rowId, [...columns].sort()]);
      }
      for (const filter of entity.alternatives.flatMap((alternative) => alternative.filters)) {
        const transition = nextTemporalTransition(row, filter, nowMs);
        if (transition !== undefined) validUntil = Math.min(validUntil, transition);
      }
    }
    after = page.nextAfter;
  } while (after);
  const digest = crypto.createHash('sha256').update(JSON.stringify(membership)).digest('hex');
  cache.set(key, {
    epoch: state.epoch,
    watermarkSeq: state.watermark.seq,
    computedAt: nowMs,
    validUntil,
    digest,
  });
  return digest;
}

/** Build one independent shape per active app + purpose pair. */
export function buildReplicaShapes(
  db: DatabaseSync,
  access: ReplicaShapeAccess,
  now = new Date().toISOString(),
): ReplicaServerShape[] {
  const grantees = readGrantees(db, now, access.appId);
  const shapes: ReplicaServerShape[] = [];
  const nowMs = Date.parse(now);
  const replicaEpoch = currentReplicaLogState(db).epoch;
  for (const grantee of grantees) {
    if (!grantee.signing_key) continue;
    const appId = grantee.app_name;
    const purpose = grantee.purpose;
    const entities: ReplicaEntityShape[] = [];
    for (const entity of listVaultEntities(db)) {
      const ref = resolveEntity(entity, db);
      if (!ref || ref.file !== 'vault') continue;
      let effective: ConsentAllow;
      try {
        const decision = evaluateConsent(
          db,
          {
            kind: 'app',
            callerId: grantee.app_id,
            provAgentKind: 'app',
            partyId: null,
            mayAct: access.trust === 'full',
          },
          ref.schema,
          ref.table,
          'read',
          purpose,
          now,
        );
        if (decision.decision !== 'allow') continue;
        effective = decision;
      } catch {
        // Malformed grant/policy JSON fails closed just as a replica shape
        // must; it can never fall through to a later, broader grant.
        continue;
      }
      const info = tableColumns(db, ref.physical);
      const unavailable = new Set(replicaUnavailableColumnsOf(entity, db));
      const pk = info
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name);
      const alternative = alternativeFor(db, ref.physical, effective, info, pk, unavailable, now);
      if (!alternative) continue;
      const alternatives = [alternative];
      const allowed = new Set(alternatives.flatMap((scope) => scope.columns));
      // Sticky availability metadata covers ordinary consent masks as well as
      // structurally forbidden fields. A local handler that touches or
      // spreads a masked field must rerun online; silently returning
      // `undefined` would change the existing handler's semantics.
      const hasUnavailableFields =
        unavailable.size > 0 ||
        alternatives.some((scope) => info.some((column) => !scope.columns.includes(column.name)));
      const primaryKey =
        pk.length === 1 && allowed.has(pk[0] ?? '')
          ? (pk[0] ?? REPLICA_SYNTHETIC_PRIMARY_KEY)
          : REPLICA_SYNTHETIC_PRIMARY_KEY;
      if (primaryKey === REPLICA_SYNTHETIC_PRIMARY_KEY) allowed.add(primaryKey);
      const ordered = info.map((column) => column.name).filter((column) => allowed.has(column));
      if (allowed.has(REPLICA_SYNTHETIC_PRIMARY_KEY)) ordered.push(REPLICA_SYNTHETIC_PRIMARY_KEY);
      entities.push({
        entity,
        physical: ref.physical,
        primaryKey,
        columns: ordered,
        ...(hasUnavailableFields ? { hasUnavailableFields: true } : {}),
        keyColumns: pk,
        alternatives,
      });
    }
    const digestInput = {
      protocolVersion: REPLICA_PROTOCOL_VERSION,
      appId,
      purpose,
      trust: access.trust,
      maxValueBytes: REPLICA_MAX_VALUE_BYTES,
      entities: entities.map((entity) => ({
        entity: entity.entity,
        primaryKey: entity.primaryKey,
        columns: entity.columns,
        hasUnavailableFields: entity.hasUnavailableFields === true,
        alternatives: entity.alternatives.map((alternative) => ({
          filters: alternative.filters,
          columns: alternative.columns,
        })),
        temporalFingerprint: temporalFingerprint(db, appId, purpose, entity, nowMs),
      })),
    };
    const digest = crypto.createHash('sha256').update(JSON.stringify(digestInput)).digest('hex');
    const shapeId = `${appId}:${digest.slice(0, 24)}`;
    const entityMap = new Map(entities.map((entity) => [entity.entity, entity]));
    const rowKeySecret = crypto
      .createHmac('sha256', grantee.signing_key)
      .update(`replica-row-key\u0000${replicaEpoch}`)
      .digest('hex');
    const shape = { shapeId, appId, purpose, entities, entityMap } as ReplicaServerShape;
    Object.defineProperty(shape, 'rowKeySecret', {
      value: rowKeySecret,
      enumerable: false,
    });
    shapes.push(shape);
  }
  return shapes;
}

function keyValues(entity: ReplicaEntityShape, row: ReplicaRow): SQLInputValue[] | undefined {
  const values: SQLInputValue[] = [];
  for (const column of entity.keyColumns) {
    const value = row.values[column];
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      ArrayBuffer.isView(value)
    ) {
      values.push(value as SQLInputValue);
      continue;
    }
    if (entity.keyColumns.length === 1) return [row.rowId];
    try {
      const parsed = JSON.parse(row.rowId) as unknown;
      return Array.isArray(parsed) && parsed.length === entity.keyColumns.length
        ? (parsed as SQLInputValue[])
        : undefined;
    } catch {
      return undefined;
    }
  }
  return values;
}

function alternativeMatches(
  entity: ReplicaEntityShape,
  row: ReplicaRow,
  alternative: ScopeAlternative,
): boolean {
  const keys = keyValues(entity, row);
  if (!keys) return false;
  try {
    return alternative.membership.get(...keys, ...alternative.membershipParams) !== undefined;
  } catch {
    return false;
  }
}

/** Field union for the alternatives whose row predicates actually match. */
export function replicaRowColumns(
  shape: ReplicaServerShape,
  entity: string,
  row: ReplicaRow,
  nowMs = Date.now(),
): Set<string> | undefined {
  void nowMs;
  const schema = shape.entityMap.get(entity);
  if (!schema) return undefined;
  const applicable = schema.alternatives.filter((scope) => alternativeMatches(schema, row, scope));
  if (applicable.length === 0) return undefined;
  const columns = new Set(applicable.flatMap((scope) => scope.columns));
  if (schema.primaryKey === REPLICA_SYNTHETIC_PRIMARY_KEY) columns.add(schema.primaryKey);
  return columns;
}

export interface ReplicaHistoricalRowState {
  known: boolean;
  columns?: Set<string>;
}

/** Evaluate logged OLD state with the same SQL operators and affinities as online reads. */
export function replicaHistoricalRowState(
  shape: ReplicaServerShape,
  entity: string,
  oldValuesJson: string | null,
): ReplicaHistoricalRowState {
  const schema = shape.entityMap.get(entity);
  if (!schema) return { known: true };
  const applicable: ScopeAlternative[] = [];
  let unknown = false;
  for (const alternative of schema.alternatives) {
    if (alternative.filters.length > 0 && oldValuesJson === null) {
      unknown = true;
      continue;
    }
    try {
      if (
        alternative.historicalMembership.get(oldValuesJson, ...alternative.historicalParams) !==
        undefined
      ) {
        applicable.push(alternative);
      }
    } catch {
      unknown = true;
    }
  }
  if (applicable.length === 0) return unknown ? { known: false } : { known: true };
  const columns = new Set(applicable.flatMap((scope) => scope.columns));
  if (schema.primaryKey === REPLICA_SYNTHETIC_PRIMARY_KEY) columns.add(schema.primaryKey);
  return { known: true, columns };
}

/** Public identity is canonical only when consent already exposes that PK. */
export function replicaWireRowId(
  shape: ReplicaServerShape,
  entity: string,
  canonicalRowId: string,
): string {
  const schema = shape.entityMap.get(entity);
  if (!schema) throw new Error(`entity ${entity} is not present in shape ${shape.shapeId}`);
  if (schema.primaryKey !== REPLICA_SYNTHETIC_PRIMARY_KEY) return canonicalRowId;
  const digest = crypto
    .createHmac('sha256', shape.rowKeySecret)
    .update(JSON.stringify([shape.shapeId, entity, canonicalRowId]))
    .digest('base64url');
  return `r_${digest}`;
}

export interface ReplicaRowWire {
  shapeId: string;
  entity: string;
  rowId: string;
  values: Record<string, unknown>;
  oversizedFields?: string[];
}

/** Apply row predicates + per-alternative field masks to one sealed-safe row. */
export function shapeReplicaRow(
  shape: ReplicaServerShape,
  entity: string,
  row: ReplicaRow,
  nowMs = Date.now(),
): ReplicaRowWire | undefined {
  const columns = replicaRowColumns(shape, entity, row, nowMs);
  const schema = shape.entityMap.get(entity);
  if (!columns || !schema) return undefined;
  const rowId = replicaWireRowId(shape, entity, row.rowId);
  const values: Record<string, unknown> = {};
  for (const column of columns) {
    if (column === REPLICA_SYNTHETIC_PRIMARY_KEY) values[column] = rowId;
    else if (column in row.values) values[column] = row.values[column];
  }
  const oversizedFields = row.deferredColumns.filter((column) => columns.has(column));
  return {
    shapeId: shape.shapeId,
    entity,
    rowId,
    values,
    ...(oversizedFields.length > 0 ? { oversizedFields } : {}),
  };
}

export function replicaShapesWire(shapes: ReplicaServerShape[]): ReplicaShapeWire[] {
  return shapes.map(publicShape);
}
