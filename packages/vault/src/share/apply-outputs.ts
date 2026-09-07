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

import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { decodeWireValue } from "@centraid/core/protocol";

import { VaultShareError } from "../errors.js";
import { primaryKeyOf } from "../replica/log.js";
import { entitySupertypeMembers } from "../schema/entity.js";
import type { ShareMemberRow } from "./closure-members.js";
import type { ShareClosureOutputs, ShareRowImage } from "./closure-outputs.js";
import { ownerPartyId } from "./project-household.js";
import { freeId } from "./sql.js";

/** Columns that are the AUDIENCE vault's own fact about its own row. */
const LOCAL_COLUMNS: readonly string[] = ["updated_at", "row_version"];

interface RowSpec {
  /** Logical entity name — `share_subscription_lineage.target_type`. */
  readonly entity: string;
  /** Columns naming another row, by the physical table they name. */
  readonly references?: Readonly<Record<string, string>>;
  /** Polymorphic id columns, by the column carrying the target's TYPE. */
  readonly polymorphic?: Readonly<Record<string, string>>;
  /** Columns naming a graph the audience never holds. */
  readonly nulled?: readonly string[];
  /** Columns re-pointed at the audience's own owner party. */
  readonly audienceOwner?: readonly string[];
  /** A reference the audience may legitimately not hold: NULL, never refuse. */
  readonly optionalReferences?: readonly string[];
  /**
   * A NATURAL KEY: the audience already holding a row under these columns
   * means the row is that one. Byte dedupe (`sha256`), an asset's content, an
   * owner's one reading of its bytes — all the same question.
   */
  readonly identity?: readonly string[];
  /**
   * Adopt a row the audience already holds under the ORIGIN's own id. Only for
   * `core_party`, and deliberately: a ledger naming a party the audience
   * already knows twice is a broken ledger, and an accounting party is not a
   * principal, so adopting one grants nothing.
   */
  readonly adoptByOriginId?: boolean;
  /** A name that must not collide within one owner's rows. */
  readonly uniqueWithin?: {
    readonly column: string;
    readonly scope: string;
    readonly suffix: string;
  };
}

/**
 * WRITE ORDER, and its exact reverse for `leave`. A referencing row is written
 * after the row it names and deleted before it, which is the whole reason this
 * is a list and not a set: the audience's foreign keys are real.
 *
 * `locker_item` is absent DELIBERATELY, and its absence is what sends a Locker
 * closure down the snapshot path: its sealed columns must be re-sealed under
 * the AUDIENCE DEK, which needs both vault keys in one process
 * (`project-household.ts`), and no row on a wire can carry that.
 */
const APPLY_ORDER: readonly string[] = [
  "core_party",
  "core_content_item",
  "media_asset",
  "core_document",
  "core_content_representation",
  "core_concept_scheme",
  "core_concept",
  "core_collection",
  "core_collection_entry",
  "core_tag",
  "social_circle",
  "social_circle_member",
  "tally_group",
  "tally_expense",
  "core_attachment",
  "tally_expense_split",
  "tally_expense_payer",
  "tally_settlement",
  "tally_recurring_expense",
  "tally_recurring_expense_split",
  "schedule_recurrence_exception",
  "tally_expense_line_item",
  "tally_expense_line_allocation",
];

const SPECS: ReadonlyMap<string, RowSpec> = new Map<string, RowSpec>([
  [
    "core_party",
    {
      entity: "core.party",
      // The avatar names a content item that was never in this closure.
      nulled: ["avatar_content_id"],
      adoptByOriginId: true,
    },
  ],
  [
    "core_content_item",
    {
      entity: "core.content_item",
      nulled: ["creator_party_id", "origin_device_id"],
      // Byte dedupe survives the boundary: the same photograph shared twice is
      // one content item in the audience vault.
      identity: ["sha256"],
    },
  ],
  [
    "media_asset",
    {
      entity: "media.asset",
      references: { content_id: "core_content_item" },
      // `source_asset_id` names an ORIGIN asset (#711).
      nulled: ["place_id", "camera_device_id", "source_asset_id"],
      identity: ["content_id"],
    },
  ],
  [
    "core_document",
    {
      entity: "core.document",
      references: { current_content_id: "core_content_item" },
    },
  ],
  [
    "core_content_representation",
    {
      entity: "core.content_representation",
      references: { content_id: "core_content_item" },
      polymorphic: { owner_id: "owner_type" },
      // An owner has exactly ONE reading of its content, by UNIQUE constraint:
      // two grants over the same photograph must land on the same row.
      identity: ["owner_type", "owner_id"],
    },
  ],
  ["core_concept_scheme", { entity: "core.concept_scheme" }],
  [
    "core_concept",
    {
      entity: "core.concept",
      references: {
        scheme_id: "core_concept_scheme",
        broader_concept_id: "core_concept",
      },
      optionalReferences: ["broader_concept_id"],
    },
  ],
  [
    "core_collection",
    {
      entity: "core.collection",
      references: {
        cover_content_id: "core_content_item",
        parent_collection_id: "core_collection",
      },
      optionalReferences: ["cover_content_id", "parent_collection_id"],
      audienceOwner: ["owner_party_id"],
    },
  ],
  [
    "core_collection_entry",
    {
      entity: "core.collection_entry",
      references: { collection_id: "core_collection" },
      polymorphic: { target_id: "target_type" },
    },
  ],
  [
    "core_tag",
    {
      entity: "core.tag",
      references: { concept_id: "core_concept" },
      polymorphic: { target_id: "target_type" },
      audienceOwner: ["tagged_by_party_id"],
    },
  ],
  [
    "social_circle",
    {
      entity: "social.circle",
      audienceOwner: ["owner_party_id"],
      uniqueWithin: {
        column: "name",
        scope: "owner_party_id",
        suffix: " (shared)",
      },
    },
  ],
  [
    "social_circle_member",
    {
      entity: "social.circle_member",
      references: { circle_id: "social_circle", party_id: "core_party" },
    },
  ],
  [
    "tally_group",
    { entity: "tally.group", references: { circle_id: "social_circle" } },
  ],
  [
    "tally_expense",
    {
      entity: "tally.expense",
      references: { group_id: "tally_group", paid_by: "core_party" },
      // A transaction row belongs to the origin's own accounts.
      nulled: ["txn_id"],
    },
  ],
  [
    "core_attachment",
    {
      entity: "core.attachment",
      references: { content_id: "core_content_item" },
      polymorphic: { target_id: "target_type" },
    },
  ],
  [
    "tally_expense_split",
    {
      entity: "tally.expense_split",
      references: { expense_id: "tally_expense", party_id: "core_party" },
    },
  ],
  [
    "tally_expense_payer",
    {
      entity: "tally.expense_payer",
      references: { expense_id: "tally_expense", party_id: "core_party" },
    },
  ],
  [
    "tally_settlement",
    {
      entity: "tally.settlement",
      references: {
        group_id: "tally_group",
        from_party: "core_party",
        to_party: "core_party",
      },
      nulled: ["txn_id"],
    },
  ],
  [
    "tally_recurring_expense",
    {
      entity: "tally.recurring_expense",
      references: { group_id: "tally_group", paid_by: "core_party" },
    },
  ],
  [
    "tally_recurring_expense_split",
    {
      entity: "tally.recurring_expense_split",
      references: {
        template_id: "tally_recurring_expense",
        party_id: "core_party",
      },
    },
  ],
  [
    "schedule_recurrence_exception",
    {
      entity: "schedule.recurrence_exception",
      polymorphic: { target_id: "target_type" },
    },
  ],
  [
    "tally_expense_line_item",
    {
      entity: "tally.expense_line_item",
      references: {
        expense_id: "tally_expense",
        receipt_id: "core_attachment",
      },
      // A line whose receipt did not cross keeps its typed amounts and loses
      // only the photo pointer.
      optionalReferences: ["receipt_id"],
    },
  ],
  [
    "tally_expense_line_allocation",
    {
      entity: "tally.expense_line_allocation",
      references: {
        line_item_id: "tally_expense_line_item",
        party_id: "core_party",
      },
    },
  ],
]);

/** Physical table for a logical entity name — the polymorphic resolution. */
const PHYSICAL_OF_ENTITY: ReadonlyMap<string, string> = new Map(
  entitySupertypeMembers()
);

/** Tables whose ids live in the one `core_entity` namespace. */
const ENTITY_TABLES: ReadonlySet<string> = new Set(
  entitySupertypeMembers().map(([, physical]) => physical)
);

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

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** The single-column id of an entity table; `undefined` for anything else. */
function entityIdColumn(
  audience: DatabaseSync,
  table: string
): string | undefined {
  if (!ENTITY_TABLES.has(table)) return undefined;
  const key = primaryKeyOf(audience, table);
  return key.length === 1 ? key[0] : undefined;
}

interface Applier {
  readonly audience: DatabaseSync;
  readonly authorityId: string;
  /** `<entity> <originItemId>` → the AUDIENCE row id. */
  readonly ids: Map<string, string>;
  readonly owner: string;
}

function lineageKey(entity: string, originId: string): string {
  return `${entity} ${originId}`;
}

function loadLineage(audience: DatabaseSync, authorityId: string): Applier {
  const ids = new Map<string, string>();
  for (const row of audience
    .prepare(
      `SELECT target_type, target_id, origin_item_id
         FROM share_subscription_lineage WHERE authority_id = ?`
    )
    .all(authorityId) as unknown as {
    target_type: string;
    target_id: string;
    origin_item_id: string;
  }[])
    ids.set(lineageKey(row.target_type, row.origin_item_id), row.target_id);
  return {
    audience,
    authorityId,
    ids,
    owner: ownerPartyId(audience),
  };
}

/**
 * The audience id an ORIGIN id stands for, decided in four steps and in this
 * order: LINEAGE, because it is durable and survives a restart; the row's
 * NATURAL KEY, because an audience already holding those bytes or that
 * owner's reading holds that row; a row this or another grant ALREADY
 * PROJECTED under the same origin id, because a projected id is globally
 * unique and a second grant over one photograph must land on it; and only
 * then the origin's own id, reused because reuse is what makes provenance
 * readable, with `freeId` minting on a genuine collision.
 *
 * The third step is what keeps `freeId`'s warning honest. An id the audience
 * holds for a row of its OWN is not adopted — a peer cannot name a local row
 * into a share — but one that some live subscription already claims is by
 * definition the projected row this grant is talking about.
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
    const existing = applier.audience
      .prepare(
        `SELECT ${quoted(idColumn)} AS id FROM ${quoted(table)} WHERE ${predicate}`
      )
      .get(...spec.identity.map((column) => columns[column] ?? null)) as
      | { id: string }
      | undefined;
    if (existing) return existing.id;
  }
  if (spec.adoptByOriginId === true) {
    const known = applier.audience
      .prepare(
        `SELECT ${quoted(idColumn)} AS id FROM ${quoted(table)} WHERE ${quoted(idColumn)} = ?`
      )
      .get(originId) as { id: string } | undefined;
    if (known) return known.id;
  }
  const projected = applier.audience
    .prepare(
      `SELECT 1 AS present FROM share_subscription_lineage
        WHERE target_type = ? AND target_id = ? LIMIT 1`
    )
    .get(spec.entity, originId);
  if (projected) return originId;
  return freeId(applier.audience, table, idColumn, originId);
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
  const present = applier.audience
    .prepare(
      `SELECT ${quoted(idColumn)} AS id FROM ${quoted(table)} WHERE ${quoted(idColumn)} = ?`
    )
    .get(originId) as { id: string } | undefined;
  return present?.id;
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
  const held = applier.audience
    .prepare(
      `SELECT 1 AS present FROM ${quoted(table)}
        WHERE ${quoted(rule.scope)} = ? AND ${quoted(rule.column)} = ?
          AND ${quoted(idColumn)} <> ?`
    )
    .get(columns[rule.scope] ?? null, columns[rule.column] ?? null, audienceId);
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
  applier.audience
    .prepare(
      `INSERT INTO share_subscription_lineage
         (authority_id, target_type, target_id, origin_item_id, origin_row_version)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (authority_id, target_type, target_id) DO UPDATE SET
         origin_item_id = excluded.origin_item_id,
         origin_row_version = excluded.origin_row_version`
    )
    .run(
      applier.authorityId,
      spec.entity,
      audienceId,
      originId,
      originRowVersion
    );
}

/** The primary key of one member row, as bindable audience values. */
function keyValues(member: ShareMemberRow): unknown[] {
  return (JSON.parse(member.pk) as unknown[]).map((value) =>
    decodeWireValue(value as never)
  );
}

function keyPredicate(audience: DatabaseSync, table: string): string {
  return primaryKeyOf(audience, table)
    .map((column) => `${quoted(column)} = ?`)
    .join(" AND ");
}

export interface ApplyShareOutputsResult {
  readonly authorityId: string;
  readonly entered: number;
  readonly updated: number;
  /** Rows deleted. A row another live grant still claims is not one. */
  readonly left: number;
  /** Rows released by this grant and kept for another. */
  readonly retained: number;
  /** Rows the outputs named that the audience could not place. */
  readonly skipped: number;
}

function orderOf(table: string): number {
  const index = APPLY_ORDER.indexOf(table);
  return index === -1 ? APPLY_ORDER.length : index;
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
  const assignable = names.filter(
    (column) =>
      column !== idColumn &&
      !primaryKeyOf(applier.audience, row.table).includes(column)
  );
  applier.audience
    .prepare(
      `INSERT INTO ${quoted(row.table)} (${names.map(quoted).join(", ")})
       VALUES (${names.map(() => "?").join(", ")})
       ON CONFLICT (${primaryKeyOf(applier.audience, row.table).map(quoted).join(", ")})
       DO UPDATE SET ${assignable
         .map((column) => `${quoted(column)} = excluded.${quoted(column)}`)
         .join(", ")}`
    )
    .run(...(names.map((column) => columns[column]) as SQLInputValue[]));
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
  const applier = loadLineage(audience, outputs.authorityId);
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
  const claimed = audience.prepare(
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
    audience
      .prepare(
        `DELETE FROM share_subscription_lineage
          WHERE authority_id = ? AND target_type = ? AND target_id = ?`
      )
      .run(outputs.authorityId, spec.entity, audienceId);
    if (claimed.get(spec.entity, audienceId, outputs.authorityId)) {
      retained += 1;
      continue;
    }
    const idColumn = entityIdColumn(audience, member.table);
    const changes =
      idColumn === undefined
        ? audience
            .prepare(
              `DELETE FROM ${quoted(member.table)} WHERE ${keyPredicate(audience, member.table)}`
            )
            .run(...(key as SQLInputValue[])).changes
        : audience
            .prepare(
              `DELETE FROM ${quoted(member.table)} WHERE ${quoted(idColumn)} = ?`
            )
            .run(audienceId).changes;
    if (Number(changes) > 0) left += 1;
  }
  return {
    authorityId: outputs.authorityId,
    entered,
    updated,
    left,
    retained,
    skipped,
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
        originVaultId: row.origin_vault_id,
        originItemId: row.origin_item_id,
        originRowVersion: row.origin_row_version,
      };
}
