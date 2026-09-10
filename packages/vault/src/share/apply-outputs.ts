/*
 * THE AUDIENCE APPLIES THE THREE OUTPUTS (#996, R10).
 *
 * A subscription no longer costs the audience a re-projection of everything it
 * holds. It costs it the rows that moved: an `enter` is an insert of a full
 * image, an `update` is one `UPDATE` of the columns the origin changed, and a
 * `leave` is a delete of a row nothing else claims. This module is the one
 * place that knows how an ORIGIN row becomes an AUDIENCE row.
 *
 * THREE THINGS EVERY ROW GOES THROUGH.
 *
 *   1. RE-KEYED THROUGH LINEAGE. `share_subscription_lineage` is the durable
 *      origin→audience id map, per grant: the applier claims EVERY row it
 *      writes, not only the named items, so a later `update` or `leave` can
 *      find the audience's row even when the two ids differ (a deduped
 *      photograph, a colliding uuid). A table that is not an entity — one
 *      whose id `core_entity` does not hold — cannot be claimed, and does not
 *      need to be: its audience key IS its origin key, deterministically, so
 *      the map has nothing to remember.
 *   2. CROSS-VAULT COLUMNS NULLED. A `creator_party_id`, an `origin_device_id`,
 *      a `place_id`, a `camera_device_id` name a graph the audience does not
 *      hold. Which vault a row came from is the SUBSCRIPTION's answer, never a
 *      column here (`closure.ts`).
 *   3. LOCAL FACTS LEFT LOCAL. `updated_at` and `row_version` are the audience
 *      vault's own (#916, ONT-08): the origin's values are never copied, and
 *      the audience's touch trigger stamps its own.
 *
 * READ-ONLY IN THE AUDIENCE VAULT. A projected row is the origin's; an
 * `edit`-grant edit is an intent forwarded to the origin, committed there, and
 * returned through the subscription — `forwardProjectedEdit` is where a seat
 * asks that question, and it answers with the origin the row came from rather
 * than writing. What the recipient MAY write against a projected row is its
 * own derived rows, which is what `projection-ingest.ts` enqueues.
 */

import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";

import { decodeWireValue } from "@centraid/core/protocol";

import { VaultShareError } from "../errors.js";
import { prepared } from "../grant/prepared.js";
import { uuidv7 } from "../ids.js";
import {
  divergedClaimCount,
  stampAudienceVersions,
} from "./apply-divergence.js";
import {
  keyValues,
  lineageKey,
  orderOf,
  scrubUnrenewedClaims,
} from "./apply-lineage.js";
import { SPECS } from "./apply-registry.js";
import type { RowSpec } from "./apply-registry.js";
import {
  entityIdColumn,
  PHYSICAL_OF_ENTITY,
  quoted,
  shapeOf,
} from "./apply-shape.js";
import type { ShareClosureOutputs, ShareRowImage } from "./closure-outputs.js";
import { ownerPartyId } from "./project-household.js";

/** Columns that are the AUDIENCE vault's own fact about its own row. */
const LOCAL_COLUMNS: readonly string[] = ["updated_at", "row_version"];

/**
 * True when every table these outputs touch can be applied as rows. A closure
 * carrying anything else — today, only a Locker item — takes the snapshot
 * path, which is `readShareClosure` as R10's bootstrap builder rather than a
 * second transport.
 */
export function shareOutputsAreApplicable(
  outputs: ShareClosureOutputs
): boolean {
  const tables = [
    ...outputs.enter.map((row) => row.table),
    ...outputs.update.map((row) => row.table),
    ...outputs.leave.map((row) => row.table),
  ];
  return tables.every((table) => SPECS.has(table));
}

/** One prepared upsert per (table, column set), for the same reason. */
const UPSERTS = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

function upsertFor(
  audience: DatabaseSync,
  table: string,
  names: readonly string[]
): StatementSync {
  let perDb = UPSERTS.get(audience);
  if (!perDb) {
    perDb = new Map();
    UPSERTS.set(audience, perDb);
  }
  const cacheKey = `${table} ${names.join(",")}`;
  const held = perDb.get(cacheKey);
  if (held) return held;
  const { key, idColumn } = shapeOf(audience, table);
  const assignable = names.filter(
    (column) => column !== idColumn && !key.includes(column)
  );
  const statement = audience.prepare(
    `INSERT INTO ${quoted(table)} (${names.map(quoted).join(", ")})
     VALUES (${names.map(() => "?").join(", ")})
     ON CONFLICT (${key.map(quoted).join(", ")})
     DO UPDATE SET ${assignable
       .map((column) => `${quoted(column)} = excluded.${quoted(column)}`)
       .join(", ")}`
  );
  perDb.set(cacheKey, statement);
  return statement;
}

interface Applier {
  readonly audience: DatabaseSync;
  readonly authorityId: string;
  /** `<entity> <originItemId>` → the AUDIENCE row id. */
  readonly ids: Map<string, string>;
  readonly owner: string;
  /**
   * ONE QUERY PER PASS, NOT ONE PER ROW. Both questions `resolveId` asks about
   * an id — is it taken in this vault's entity namespace, and does some live
   * subscription already claim it — are asked for every id the pass carries,
   * up front, in chunks. A bootstrap is 800 rows whose answers are all "no",
   * and 1,600 round trips to learn that was 2.4x the projector this replaces.
   */
  readonly taken: ReadonlySet<string>;
  readonly claimed: ReadonlySet<string>;
  /**
   * `<entity> <audienceId>` for every row THIS pass claimed. A resend carries
   * the whole member set, so what it did not claim is no longer in the closure
   * (#1014, V10) — a `leave` list cannot say so, because a resend has none.
   */
  readonly placed: Set<string>;
}

/** `IN (…)` in chunks a prepared statement can hold. */
function chunked<T>(values: readonly T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < values.length; at += size)
    out.push(values.slice(at, at + size));
  return out;
}

function idsCarriedBy(outputs: ShareClosureOutputs): string[] {
  const ids = new Set<string>();
  for (const row of [...outputs.enter, ...outputs.update, ...outputs.leave])
    ids.add(String((JSON.parse(row.pk) as unknown[])[0]));
  return [...ids];
}

function loadLineage(
  audience: DatabaseSync,
  authorityId: string,
  outputs: ShareClosureOutputs
): Applier {
  const ids = new Map<string, string>();
  for (const row of prepared(
    audience,
    `SELECT target_type, target_id, origin_item_id
       FROM share_subscription_lineage WHERE authority_id = ?`
  ).all(authorityId) as unknown as {
    target_type: string;
    target_id: string;
    origin_item_id: string;
  }[])
    ids.set(lineageKey(row.target_type, row.origin_item_id), row.target_id);
  const carried = idsCarriedBy(outputs);
  const taken = new Set<string>();
  const claimed = new Set<string>();
  for (const chunk of chunked(carried)) {
    const slots = chunk.map(() => "?").join(", ");
    for (const row of prepared(
      audience,
      `SELECT entity_id FROM core_entity WHERE entity_id IN (${slots})`
    ).all(...chunk) as unknown as { entity_id: string }[])
      taken.add(row.entity_id);
    for (const row of prepared(
      audience,
      `SELECT target_type, target_id FROM share_subscription_lineage
        WHERE target_id IN (${slots})`
    ).all(...chunk) as unknown as {
      target_type: string;
      target_id: string;
    }[])
      claimed.add(lineageKey(row.target_type, row.target_id));
  }
  return {
    audience,
    authorityId,
    ids,
    owner: ownerPartyId(audience),
    taken,
    claimed,
    placed: new Set<string>(),
  };
}

/**
 * The audience id an ORIGIN id stands for.
 *
 * LINEAGE first — durable, and it survives a restart. Then the row's NATURAL
 * KEY, because an audience already holding those bytes or that owner's reading
 * holds that row. Then ONE question, asked of `core_entity` because entity ids
 * are one namespace: is this id free here?
 *
 *   - FREE — take it. Reusing the origin's uuidv7 is what makes provenance
 *     readable, and nothing can be colliding with it.
 *   - TAKEN, and some live subscription claims it — that is the projected row
 *     this grant is talking about, so a second grant over one photograph lands
 *     on the first grant's row.
 *   - TAKEN, and it is the audience's OWN row — mint. A peer cannot name a
 *     local row into a share (`freeId`'s warning, kept).
 *
 * NO PROBE AT ALL in the common case: both id questions are answered from the
 * two sets `loadLineage` reads once for the whole pass. Only a table with a
 * NATURAL KEY still asks per row, and only because "does this vault already
 * hold these bytes" is a question about a column rather than an id.
 */
function resolveId(
  applier: Applier,
  table: string,
  spec: RowSpec,
  originId: string,
  columns: Readonly<Record<string, SQLInputValue>>
): string {
  const held = applier.ids.get(lineageKey(spec.entity, originId));
  if (held !== undefined) return held;
  const idColumn = entityIdColumn(applier.audience, table);
  if (idColumn === undefined) return originId;
  if (spec.identity !== undefined) {
    const predicate = spec.identity
      .map((column) => `${quoted(column)} = ?`)
      .join(" AND ");
    const existing = prepared(
      applier.audience,
      `SELECT ${quoted(idColumn)} AS id FROM ${quoted(table)} WHERE ${predicate}`
    ).get(...spec.identity.map((column) => columns[column] ?? null)) as
      | { id: string }
      | undefined;
    if (existing) return existing.id;
  }
  if (!applier.taken.has(originId)) return originId;
  if (spec.adoptByOriginId === true) return originId;
  return applier.claimed.has(lineageKey(spec.entity, originId))
    ? originId
    : uuidv7();
}

/** An id already resolved for a row this pass has not reached is not an error
 *  — it is a reference the audience does not hold, which the spec decides. */
function referencedId(
  applier: Applier,
  table: string,
  originId: string
): string | undefined {
  const spec = SPECS.get(table);
  if (!spec) return undefined;
  const held = applier.ids.get(lineageKey(spec.entity, originId));
  if (held !== undefined) return held;
  const idColumn = entityIdColumn(applier.audience, table);
  if (idColumn === undefined) return originId;
  return applier.taken.has(originId) ? originId : undefined;
}

/**
 * The audience's version of one origin row: the id, the references, the nulled
 * columns and the re-owned ones. `undefined` when a reference the row cannot do
 * without is missing — the row is skipped rather than written against a
 * dangling key.
 */
function translate(
  applier: Applier,
  table: string,
  spec: RowSpec,
  image: ShareRowImage["row"]
): Record<string, SQLInputValue> | undefined {
  const idColumn = entityIdColumn(applier.audience, table);
  const out: Record<string, SQLInputValue> = {};
  for (const [column, value] of Object.entries(image)) {
    if (LOCAL_COLUMNS.includes(column) || column === idColumn) continue;
    if (spec.nulled?.includes(column)) {
      out[column] = null;
      continue;
    }
    if (spec.audienceOwner?.includes(column)) {
      out[column] = applier.owner;
      continue;
    }
    const typeColumn = spec.polymorphic?.[column];
    const target =
      spec.references?.[column] ??
      (typeColumn === undefined
        ? undefined
        : PHYSICAL_OF_ENTITY.get(String(decodeWireValue(image[typeColumn]!))));
    if (target !== undefined) {
      const originRef = decodeWireValue(value);
      if (originRef === null) {
        out[column] = null;
        continue;
      }
      const resolved = referencedId(applier, target, String(originRef));
      if (resolved === undefined) {
        if (!spec.optionalReferences?.includes(column)) return undefined;
        out[column] = null;
        continue;
      }
      out[column] = resolved;
      continue;
    }
    out[column] = decodeWireValue(value) as SQLInputValue;
  }
  return out;
}

/** A name that must not collide within one owner's rows, decided once the
 *  audience id is known so the row does not rename itself on every pass. */
function deconflict(
  applier: Applier,
  table: string,
  spec: RowSpec,
  columns: Record<string, SQLInputValue>,
  audienceId: string
): void {
  const rule = spec.uniqueWithin;
  if (!rule) return;
  const idColumn = entityIdColumn(applier.audience, table);
  if (idColumn === undefined) return;
  const held = prepared(
    applier.audience,
    `SELECT 1 AS present FROM ${quoted(table)}
      WHERE ${quoted(rule.scope)} = ? AND ${quoted(rule.column)} = ?
        AND ${quoted(idColumn)} <> ?`
  ).get(columns[rule.scope] ?? null, columns[rule.column] ?? null, audienceId);
  if (held)
    columns[rule.column] = `${String(columns[rule.column])}${rule.suffix}`;
}

function claim(
  applier: Applier,
  spec: RowSpec,
  originId: string,
  audienceId: string,
  originRowVersion: number
): void {
  applier.ids.set(lineageKey(spec.entity, originId), audienceId);
  if (!PHYSICAL_OF_ENTITY.has(spec.entity)) return;
  applier.placed.add(lineageKey(spec.entity, audienceId));
  prepared(
    applier.audience,
    `INSERT INTO share_subscription_lineage
       (authority_id, target_type, target_id, origin_item_id, origin_row_version)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (authority_id, target_type, target_id) DO UPDATE SET
       origin_item_id = excluded.origin_item_id,
       origin_row_version = excluded.origin_row_version`
  ).run(
    applier.authorityId,
    spec.entity,
    audienceId,
    originId,
    originRowVersion
  );
}

/** The primary key of one member row, as bindable audience values. */
function keyPredicate(audience: DatabaseSync, table: string): string {
  return shapeOf(audience, table)
    .key.map((column) => `${quoted(column)} = ?`)
    .join(" AND ");
}

export interface ApplyShareOutputsResult {
  readonly authorityId: string;
  /**
   * Claimed rows this vault had written behind the origin's back — the
   * divergence ruling G-view says the next pass must erase them. The applier
   * REPORTS the count rather than repairing it, because repair needs the
   * origin's images and this pass carries only what moved: the caller's answer
   * is a resend, and `ingestShareTail` has already reset the cursor so the
   * next pass is one.
   */
  readonly diverged: number;
  readonly entered: number;
  readonly updated: number;
  /** Rows deleted. A row another live grant still claims is not one. */
  readonly left: number;
  /** Rows released by this grant and kept for another. */
  readonly retained: number;
  /** Rows the outputs named that the audience could not place. */
  readonly skipped: number;
  /**
   * Claims a RESEND did not renew, so the row left the closure while the
   * audience was in another epoch or behind the floor (#1014, V10). Counted
   * separately from `left` because no `leave` output named them.
   */
  readonly scrubbed: number;
}

function writeRow(
  applier: Applier,
  row: ShareRowImage,
  originRowVersion: number
): "written" | "skipped" {
  const spec = SPECS.get(row.table);
  if (!spec) return "skipped";
  const key = keyValues(row);
  const originId = String(key[0]);
  const columns = translate(applier, row.table, spec, row.row);
  if (columns === undefined) return "skipped";
  const idColumn = entityIdColumn(applier.audience, row.table);
  const audienceId = resolveId(applier, row.table, spec, originId, columns);
  if (idColumn !== undefined) columns[idColumn] = audienceId;
  deconflict(applier, row.table, spec, columns, audienceId);
  const names = Object.keys(columns);
  upsertFor(applier.audience, row.table, names).run(
    ...(names.map((column) => columns[column]) as SQLInputValue[])
  );
  claim(applier, spec, originId, audienceId, originRowVersion);
  return "written";
}

/**
 * Apply one pass of the three outputs, in ONE audience transaction. The caller
 * owns the replica commit bracket and the cursor: this writes rows and claims,
 * and nothing else.
 */
export function applyShareOutputs(
  audience: DatabaseSync,
  outputs: ShareClosureOutputs,
  input: { originRowVersion?: number } = {}
): ApplyShareOutputsResult {
  if (!shareOutputsAreApplicable(outputs))
    throw new VaultShareError(
      `share outputs for ${outputs.authorityId} name a table the row applier cannot place`
    );
  // BEFORE anything is written: a row this pass is about to overwrite is not
  // divergence, but a claimed row it does not touch is.
  const diverged = divergedClaimCount(audience, outputs.authorityId);
  const applier = loadLineage(audience, outputs.authorityId, outputs);
  const originRowVersion = input.originRowVersion ?? outputs.cursor.seq;
  let entered = 0;
  let updated = 0;
  let skipped = 0;
  for (const row of [...outputs.enter].toSorted(
    (left, right) => orderOf(left.table) - orderOf(right.table)
  ))
    if (writeRow(applier, row, originRowVersion) === "written") entered += 1;
    else skipped += 1;
  for (const row of [...outputs.update].toSorted(
    (left, right) => orderOf(left.table) - orderOf(right.table)
  ))
    if (writeRow(applier, row, originRowVersion) === "written") updated += 1;
    else skipped += 1;

  // LEAVE, in the exact reverse of the write order: a container's members go
  // before the container, so a foreign key is never left dangling mid-pass.
  const claimed = prepared(
    audience,
    `SELECT 1 AS present FROM share_subscription_lineage
      WHERE target_type = ? AND target_id = ? AND authority_id <> ? LIMIT 1`
  );
  let left = 0;
  let retained = 0;
  for (const member of [...outputs.leave].toSorted(
    (a, b) => orderOf(b.table) - orderOf(a.table)
  )) {
    const spec = SPECS.get(member.table);
    if (!spec) continue;
    const key = keyValues(member);
    const originId = String(key[0]);
    const audienceId =
      applier.ids.get(lineageKey(spec.entity, originId)) ?? originId;
    applier.ids.delete(lineageKey(spec.entity, originId));
    prepared(
      audience,
      `DELETE FROM share_subscription_lineage
        WHERE authority_id = ? AND target_type = ? AND target_id = ?`
    ).run(outputs.authorityId, spec.entity, audienceId);
    if (claimed.get(spec.entity, audienceId, outputs.authorityId)) {
      retained += 1;
      continue;
    }
    const idColumn = entityIdColumn(audience, member.table);
    const changes =
      idColumn === undefined
        ? prepared(
            audience,
            `DELETE FROM ${quoted(member.table)} WHERE ${keyPredicate(audience, member.table)}`
          ).run(...(key as SQLInputValue[])).changes
        : prepared(
            audience,
            `DELETE FROM ${quoted(member.table)} WHERE ${quoted(idColumn)} = ?`
          ).run(audienceId).changes;
    if (Number(changes) > 0) left += 1;
  }
  const unrenewed =
    outputs.reason === "resend"
      ? scrubUnrenewedClaims(
          audience,
          outputs.authorityId,
          outputs,
          applier.placed
        )
      : { scrubbed: 0, retained: 0 };
  retained += unrenewed.retained;
  stampAudienceVersions(audience, outputs.authorityId);
  return {
    authorityId: outputs.authorityId,
    diverged,
    entered,
    updated,
    left,
    retained,
    skipped,
    scrubbed: unrenewed.scrubbed,
  };
}

/**
 * PROJECTED ROWS ARE READ-ONLY (#996, R10). A seat that wants to change one
 * asks here and is told where the write belongs: the ORIGIN vault, as an
 * intent, over the subscription that delivered the row. `undefined` means the
 * row is the audience's own and it may write it directly.
 *
 * This is a QUESTION, not an enforcement point — the enforcement is that the
 * audience holds no grant over the origin and the origin is the single writer
 * of its own rows (#929 wave 3). What it prevents is the seat quietly writing
 * a local edit that the next `update` would overwrite without telling anyone.
 */
export interface ProjectedEditRoute {
  readonly authorityId: string;
  /** The entity type the row is, as lineage keys it. */
  readonly entity: string;
  readonly originVaultId: string;
  /** The row id to name in the intent — the ORIGIN's, not the audience's. */
  readonly originItemId: string;
  readonly originRowVersion: number;
}

export function forwardProjectedEdit(
  audience: DatabaseSync,
  target: { entity: string; rowId: string }
): ProjectedEditRoute | undefined {
  const row = audience
    .prepare(
      `SELECT l.authority_id, l.origin_item_id, l.origin_row_version,
              s.origin_vault_id
         FROM share_subscription_lineage l
         JOIN share_subscription s ON s.authority_id = l.authority_id
        WHERE l.target_type = ? AND l.target_id = ? AND s.state = 'subscribed'
        ORDER BY l.authority_id LIMIT 1`
    )
    .get(target.entity, target.rowId) as
    | {
        authority_id: string;
        origin_item_id: string;
        origin_row_version: number;
        origin_vault_id: string;
      }
    | undefined;
  return row === undefined
    ? undefined
    : {
        authorityId: row.authority_id,
        entity: target.entity,
        originVaultId: row.origin_vault_id,
        originItemId: row.origin_item_id,
        originRowVersion: row.origin_row_version,
      };
}
