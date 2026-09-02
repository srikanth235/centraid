// governance: allow-repo-hygiene file-size-limit (#406) consent selection, temporal membership, and opaque row identity form one security boundary
// Server-derived replica shapes (#406): app consent scopes intersected with the
// acting owner's write authority. Manifests carry no replica field; this module
// projects gateway-enforced grants into a row/column-minimized offline shape.

import crypto from "node:crypto";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";

import {
  compileFilters,
  compileReplicaHistoricalFilters,
  currentReplicaLogState,
  evaluateAccess,
  listVaultEntities,
  readReplicaRow,
  readReplicaRows,
  replicaUnavailableColumnsOf,
  resolveEntity,
} from "@centraid/vault";
import type { FilterClause, AccessAllow, ReplicaRow } from "@centraid/vault";

import { readGrantees } from "./replica-grantees.js";
import { preparedStatement } from "./sql-statement-cache.js";

export const REPLICA_PROTOCOL_VERSION = 1 as const;
export const REPLICA_MAX_VALUE_BYTES = 64 * 1024;
export const REPLICA_SYNTHETIC_PRIMARY_KEY = "__centraid_row_id";

export interface ReplicaShapeAccess {
  /** Ownership-sourced write authority (#726), not a grant. */
  canWrite: boolean;
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
  /** Last log seq touching THIS entity, never the global watermark (#659):
   *  keyed on the watermark, any commit anywhere would force a rescan. */
  entitySeq: number;
  computedAt: number;
  validUntil: number;
  digest: string;
  /** Membership behind `digest`; absent past `INCREMENTAL_MEMBERSHIP_LIMIT`. */
  membership?: Map<string, string[]>;
  /** A row past its transition must be re-evaluated though nothing wrote it. */
  transitions?: Map<string, number>;
}

const DAY_MS = 86_400_000;

/**
 * Bounds on WORK PER CALL: above either, recompute from the table. Incremental
 * costs a read + probe per CHANGED row, full one of each per row in the entity.
 */
const INCREMENTAL_MEMBERSHIP_LIMIT = 50_000;
const INCREMENTAL_CHANGE_LIMIT = 5_000;

/** `undefined` past `limit`. Backed by `idx_replica_change_latest_row`. */
function changedRowIdsSince(
  db: DatabaseSync,
  epoch: string,
  entity: string,
  sinceSeq: number,
  limit: number
): string[] | undefined {
  const rows = preparedStatement(
    db,
    `SELECT DISTINCT row_id FROM replica_change
      WHERE epoch = ? AND entity = ? AND seq > ?
      LIMIT ?`
  ).all(epoch, entity, sinceSeq, limit + 1) as { row_id: string }[];
  return rows.length > limit ? undefined : rows.map((row) => row.row_id);
}

/** Index probe, not a scan — `idx_replica_change_latest_row` covers it. */
function entityChangeSeq(
  db: DatabaseSync,
  epoch: string,
  entity: string
): number {
  const row = preparedStatement(
    db,
    `SELECT MAX(seq) AS seq FROM replica_change WHERE epoch = ? AND entity = ?`
  ).get(epoch, entity) as { seq: number | null } | undefined;
  return row?.seq ?? 0;
}
const temporalFingerprintCache = new WeakMap<
  DatabaseSync,
  Map<string, TemporalFingerprintCacheEntry>
>();

/**
 * Cached: this runs once per vault ENTITY per subscriber per commit. `physical`
 * comes from the vault registry, never the wire — that is what makes the
 * interpolation safe.
 */
function tableColumns(db: DatabaseSync, physical: string): TableColumn[] {
  return preparedStatement(
    db,
    `PRAGMA table_info(${JSON.stringify(physical)})`
  ).all() as unknown as TableColumn[];
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function alternativeFor(
  db: DatabaseSync,
  physical: string,
  scope: Pick<AccessAllow, "rowFilter" | "fieldMask">,
  columns: TableColumn[],
  keyColumns: string[],
  unavailable: Set<string>,
  now: string
): ScopeAlternative | undefined {
  const filters = scope.rowFilter;
  const mask = scope.fieldMask;
  if (
    !Array.isArray(filters) ||
    filters.some(
      (filter) =>
        filter === null ||
        typeof filter !== "object" ||
        typeof filter.column !== "string" ||
        typeof filter.op !== "string"
    ) ||
    (mask !== null &&
      (!Array.isArray(mask) ||
        mask.some((column) => typeof column !== "string")))
  ) {
    return undefined;
  }
  const actual = new Set(columns.map((column) => column.name));
  // Fails closed: membership never widens because a replica cannot evaluate.
  if (
    filters.some(
      (filter) => !actual.has(filter.column) || unavailable.has(filter.column)
    )
  ) {
    return undefined;
  }
  if (
    keyColumns.length === 0 ||
    keyColumns.some((column) => unavailable.has(column))
  ) {
    return undefined;
  }
  const allowed =
    mask === null
      ? columns
          .map((column) => column.name)
          .filter((column) => !unavailable.has(column))
      : mask.filter((column) => actual.has(column) && !unavailable.has(column));
  // Mirrors applyFieldMask: zero real fields is invalid, not identity-only.
  if (allowed.length === 0) return undefined;
  try {
    const compiled = compileFilters(db, physical, filters, now);
    const historical = compileReplicaHistoricalFilters(
      db,
      physical,
      filters,
      now
    );
    const keys = keyColumns
      .map((column) => `${quoteIdentifier(column)} = ?`)
      .join(" AND ");
    const alternative: ScopeAlternative = {
      filters,
      columns: [...new Set(allowed)],
      membershipParams: compiled.params,
      historicalParams: historical.params,
    } as ScopeAlternative;
    // Non-enumerable: StatementSync exposes expandedSQL with its last bindings.
    Object.defineProperties(alternative, {
      membership: {
        value: db.prepare(
          `SELECT 1 AS matched FROM ${quoteIdentifier(physical)}
            WHERE ${keys} AND (${compiled.where}) LIMIT 1`
        ),
        enumerable: false,
      },
      historicalMembership: {
        value: db.prepare(
          `WITH replica_old(value) AS (VALUES (?))
           SELECT 1 AS matched WHERE (${historical.where})`
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
  return filter.op === "within-days" || filter.op === "within-next-days";
}

function nextTemporalTransition(
  row: ReplicaRow,
  filter: FilterClause,
  nowMs: number
): number | undefined {
  if (!isTemporal(filter)) return undefined;
  const raw = row.values[filter.column];
  const days = Number(filter.value);
  if (typeof raw !== "string" || !Number.isFinite(days) || days <= 0)
    return undefined;
  const at = Date.parse(raw);
  const span = days * DAY_MS;
  if (!Number.isFinite(at) || !Number.isFinite(span)) return undefined;
  if (filter.op === "within-days") {
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
  nowMs: number
): string | undefined {
  if (
    !entity.alternatives.some((alternative) =>
      alternative.filters.some(isTemporal)
    )
  ) {
    return undefined;
  }
  const state = currentReplicaLogState(db);
  const policy = JSON.stringify(
    entity.alternatives.map((alternative) => ({
      filters: alternative.filters,
      columns: alternative.columns,
    }))
  );
  const key = `${appId}\u0000${purpose}\u0000${entity.entity}\u0000${policy}`;
  const cache =
    temporalFingerprintCache.get(db) ??
    new Map<string, TemporalFingerprintCacheEntry>();
  temporalFingerprintCache.set(db, cache);
  const entitySeq = entityChangeSeq(db, state.epoch, entity.entity);
  const cached = cache.get(key);
  if (
    cached?.epoch === state.epoch &&
    cached.entitySeq === entitySeq &&
    nowMs >= cached.computedAt &&
    nowMs < cached.validUntil
  ) {
    return cached.digest;
  }

  const memberColumns = (row: ReplicaRow): string[] | undefined => {
    const applicable = entity.alternatives.filter((alternative) =>
      alternativeMatches(entity, row, alternative)
    );
    if (applicable.length === 0) return undefined;
    const columns = new Set(
      applicable.flatMap((alternative) => alternative.columns)
    );
    if (entity.primaryKey === REPLICA_SYNTHETIC_PRIMARY_KEY) {
      columns.add(REPLICA_SYNTHETIC_PRIMARY_KEY);
    }
    return [...columns].sort();
  };
  const rowTransition = (row: ReplicaRow): number | undefined => {
    let soonest: number | undefined;
    for (const filter of entity.alternatives.flatMap(
      (alternative) => alternative.filters
    )) {
      const transition = nextTemporalTransition(row, filter, nowMs);
      if (transition === undefined) continue;
      soonest =
        soonest === undefined ? transition : Math.min(soonest, transition);
    }
    return soonest;
  };

  // Incremental (#883 C2): only a row the log says was written, or one past its
  // recorded transition, can have MOVED. The retained map carries the rest.
  const priorMembership = cached?.membership;
  const priorTransitions = cached?.transitions;
  const changed =
    priorMembership && priorTransitions && cached.epoch === state.epoch
      ? changedRowIdsSince(
          db,
          state.epoch,
          entity.entity,
          cached.entitySeq,
          INCREMENTAL_CHANGE_LIMIT
        )
      : undefined;
  if (priorMembership && priorTransitions && changed) {
    const stale = new Set(changed);
    for (const [rowId, at] of priorTransitions)
      if (at <= nowMs) stale.add(rowId);
    const membership = new Map(priorMembership);
    const transitions = new Map(priorTransitions);
    for (const rowId of stale) {
      const row = readReplicaRow(db, entity.entity, rowId, {
        maxValueBytes: REPLICA_MAX_VALUE_BYTES,
      });
      // Gone from the table is gone from the membership; the log's own delete
      // entry is what put the id in `stale`.
      if (!row) {
        membership.delete(rowId);
        transitions.delete(rowId);
        continue;
      }
      const columns = memberColumns(row);
      if (columns) membership.set(rowId, columns);
      else membership.delete(rowId);
      const transition = rowTransition(row);
      if (transition === undefined) transitions.delete(rowId);
      else transitions.set(rowId, transition);
    }
    const digest = digestOfMembership(membership);
    cache.set(key, {
      epoch: state.epoch,
      entitySeq,
      computedAt: nowMs,
      validUntil: soonestTransition(transitions),
      digest,
      membership,
      transitions,
    });
    return digest;
  }

  const membership = new Map<string, string[]>();
  const transitions = new Map<string, number>();
  let after: string | undefined;
  do {
    const page = readReplicaRows(db, entity.entity, {
      ...(after ? { after } : {}),
      limit: 10_000,
      maxValueBytes: REPLICA_MAX_VALUE_BYTES,
    });
    for (const row of page.rows) {
      const columns = memberColumns(row);
      if (columns) membership.set(row.rowId, columns);
      const transition = rowTransition(row);
      if (transition !== undefined) transitions.set(row.rowId, transition);
    }
    after = page.nextAfter;
  } while (after);
  const digest = digestOfMembership(membership);
  // Retain the membership only while carrying it is cheaper than rebuilding it.
  const retainable =
    membership.size + transitions.size <= INCREMENTAL_MEMBERSHIP_LIMIT;
  cache.set(key, {
    epoch: state.epoch,
    entitySeq,
    computedAt: nowMs,
    validUntil: soonestTransition(transitions),
    digest,
    ...(retainable ? { membership, transitions } : {}),
  });
  return digest;
}

/**
 * ONE CANONICAL ORDER, so incremental and full cannot disagree: the digest feeds
 * the shape id, and an id depending on WHICH path produced it would rebootstrap
 * every device. Row-id sort is the only order a mutated map can also reach.
 */
function digestOfMembership(membership: Map<string, string[]>): string {
  const ordered = [...membership.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(ordered))
    .digest("hex");
}

function soonestTransition(transitions: Map<string, number>): number {
  let soonest = Number.POSITIVE_INFINITY;
  for (const at of transitions.values()) soonest = Math.min(soonest, at);
  return soonest;
}

export interface BuildReplicaShapesOptions {
  /**
   * Skip every other app's consent evaluation and pragmas (#883 C2). The id's
   * `${appId}:` prefix only NARROWS the walk — the shape is still derived from
   * live grants, so naming an app you hold no grant for yields nothing.
   */
  onlyShapeId?: string;
}

export function buildReplicaShapes(
  db: DatabaseSync,
  access: ReplicaShapeAccess,
  now = new Date().toISOString(),
  options: BuildReplicaShapesOptions = {}
): ReplicaServerShape[] {
  const grantees = readGrantees(db, now, access.appId);
  const shapes: ReplicaServerShape[] = [];
  const nowMs = Date.parse(now);
  const replicaEpoch = currentReplicaLogState(db).epoch;
  const onlyAppId =
    options.onlyShapeId === undefined
      ? undefined
      : options.onlyShapeId.slice(0, options.onlyShapeId.lastIndexOf(":"));
  for (const grantee of grantees) {
    if (!grantee.signing_key) continue;
    const appId = grantee.app_name;
    if (onlyAppId !== undefined && appId !== onlyAppId) continue;
    const purpose = grantee.purpose;
    const entities: ReplicaEntityShape[] = [];
    for (const entity of listVaultEntities(db)) {
      // ONE file (#916): every entity `resolveEntity` names lives in it.
      const ref = resolveEntity(entity, db);
      if (!ref) continue;
      let effective: AccessAllow;
      try {
        const decision = evaluateAccess(
          db,
          {
            kind: "app",
            callerId: grantee.app_id,
            provAgentKind: "app",
            partyId: null,
            mayAct: access.canWrite,
          },
          ref.schema,
          ref.table,
          "read",
          purpose,
          now
        );
        if (decision.decision !== "allow") continue;
        effective = decision;
      } catch {
        // Fails closed; never falls through to a later, broader grant.
        continue;
      }
      const info = tableColumns(db, ref.physical);
      const unavailable = new Set(replicaUnavailableColumnsOf(entity, db));
      const pk = info
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name);
      const alternative = alternativeFor(
        db,
        ref.physical,
        effective,
        info,
        pk,
        unavailable,
        now
      );
      if (!alternative) continue;
      const alternatives = [alternative];
      const allowed = new Set(alternatives.flatMap((scope) => scope.columns));
      // Sticky over consent masks too: a handler touching a masked field must
      // rerun online rather than see `undefined` and change its semantics.
      const hasUnavailableFields =
        unavailable.size > 0 ||
        alternatives.some((scope) =>
          info.some((column) => !scope.columns.includes(column.name))
        );
      const primaryKey =
        pk.length === 1 && allowed.has(pk[0] ?? "")
          ? (pk[0] ?? REPLICA_SYNTHETIC_PRIMARY_KEY)
          : REPLICA_SYNTHETIC_PRIMARY_KEY;
      if (primaryKey === REPLICA_SYNTHETIC_PRIMARY_KEY) allowed.add(primaryKey);
      const ordered = info
        .map((column) => column.name)
        .filter((column) => allowed.has(column));
      if (allowed.has(REPLICA_SYNTHETIC_PRIMARY_KEY))
        ordered.push(REPLICA_SYNTHETIC_PRIMARY_KEY);
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
      canWrite: access.canWrite,
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
        temporalFingerprint: temporalFingerprint(
          db,
          appId,
          purpose,
          entity,
          nowMs
        ),
      })),
    };
    const digest = crypto
      .createHash("sha256")
      .update(JSON.stringify(digestInput))
      .digest("hex");
    const shapeId = `${appId}:${digest.slice(0, 24)}`;
    const entityMap = new Map(
      entities.map((entity) => [entity.entity, entity])
    );
    const rowKeySecret = crypto
      .createHmac("sha256", grantee.signing_key)
      .update(`replica-row-key\u0000${replicaEpoch}`)
      .digest("hex");
    const shape = {
      shapeId,
      appId,
      purpose,
      entities,
      entityMap,
    } as ReplicaServerShape;
    Object.defineProperty(shape, "rowKeySecret", {
      value: rowKeySecret,
      enumerable: false,
    });
    shapes.push(shape);
  }
  return shapes;
}

function keyValues(
  entity: ReplicaEntityShape,
  row: ReplicaRow
): SQLInputValue[] | undefined {
  const values: SQLInputValue[] = [];
  for (const column of entity.keyColumns) {
    const value = row.values[column];
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
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
  alternative: ScopeAlternative
): boolean {
  const keys = keyValues(entity, row);
  if (!keys) return false;
  try {
    return (
      alternative.membership.get(...keys, ...alternative.membershipParams) !==
      undefined
    );
  } catch {
    return false;
  }
}

export function replicaRowColumns(
  shape: ReplicaServerShape,
  entity: string,
  row: ReplicaRow,
  nowMs = Date.now()
): Set<string> | undefined {
  void nowMs;
  const schema = shape.entityMap.get(entity);
  if (!schema) return undefined;
  const applicable = schema.alternatives.filter((scope) =>
    alternativeMatches(schema, row, scope)
  );
  if (applicable.length === 0) return undefined;
  const columns = new Set(applicable.flatMap((scope) => scope.columns));
  if (schema.primaryKey === REPLICA_SYNTHETIC_PRIMARY_KEY)
    columns.add(schema.primaryKey);
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
  oldValuesJson: string | null
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
        alternative.historicalMembership.get(
          oldValuesJson,
          ...alternative.historicalParams
        ) !== undefined
      ) {
        applicable.push(alternative);
      }
    } catch {
      unknown = true;
    }
  }
  if (applicable.length === 0)
    return unknown ? { known: false } : { known: true };
  const columns = new Set(applicable.flatMap((scope) => scope.columns));
  if (schema.primaryKey === REPLICA_SYNTHETIC_PRIMARY_KEY)
    columns.add(schema.primaryKey);
  return { known: true, columns };
}

/** Public identity is canonical only when consent already exposes that PK. */
export function replicaWireRowId(
  shape: ReplicaServerShape,
  entity: string,
  canonicalRowId: string
): string {
  const schema = shape.entityMap.get(entity);
  if (!schema)
    throw new Error(
      `entity ${entity} is not present in shape ${shape.shapeId}`
    );
  if (schema.primaryKey !== REPLICA_SYNTHETIC_PRIMARY_KEY)
    return canonicalRowId;
  const digest = crypto
    .createHmac("sha256", shape.rowKeySecret)
    .update(JSON.stringify([shape.shapeId, entity, canonicalRowId]))
    .digest("base64url");
  return `r_${digest}`;
}

export interface ReplicaRowWire {
  shapeId: string;
  entity: string;
  rowId: string;
  values: Record<string, unknown>;
  rowVersion?: number;
  oversizedFields?: string[];
}

export function shapeReplicaRow(
  shape: ReplicaServerShape,
  entity: string,
  row: ReplicaRow,
  nowMs = Date.now()
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
  const oversizedFields = row.deferredColumns.filter((column) =>
    columns.has(column)
  );
  return {
    shapeId: shape.shapeId,
    entity,
    rowId,
    values,
    ...(row.rowVersion === undefined ? {} : { rowVersion: row.rowVersion }),
    ...(oversizedFields.length > 0 ? { oversizedFields } : {}),
  };
}

export function replicaShapesWire(
  shapes: ReplicaServerShape[]
): ReplicaShapeWire[] {
  return shapes.map(publicShape);
}
