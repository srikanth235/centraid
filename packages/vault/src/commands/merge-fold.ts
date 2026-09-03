import type { HandlerCtx } from "../gateway/types.js";
import { ENTITY_POINTERS } from "../schema/entity-refs.js";
import { PARTY_POINTER_REGISTRY } from "../schema/party-pointers.js";

export interface FkRef {
  table: string;
  column: string;
  pk: readonly string[];
}

function primaryKeyOf(ctx: HandlerCtx, table: string): string[] {
  const cols = ctx.db
    .prepare(`PRAGMA table_info(${JSON.stringify(table)})`)
    .all() as { name: string; pk: number }[];
  const keys = cols
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  return keys.length > 0 ? keys : ["rowid"];
}

function keyWhere(pk: readonly string[]): string {
  return pk.map((column) => `"${column}" = ?`).join(" AND ");
}

type KeyValue = string | number | null;

function keyValues(
  pk: readonly string[],
  row: Record<string, unknown>
): KeyValue[] {
  return pk.map((column) => row[`pk_${column}`] as KeyValue);
}

function selectKey(pk: readonly string[]): string {
  return pk.map((column) => `"${column}" AS "pk_${column}"`).join(", ");
}

type ConstraintClass = "unique" | "check" | "foreign-key" | "other";

function constraintClassOf(error: unknown): ConstraintClass {
  const message = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed|PRIMARY KEY/iu.test(message)) return "unique";
  if (/CHECK constraint failed/iu.test(message)) return "check";
  if (/FOREIGN KEY constraint failed/iu.test(message)) return "foreign-key";
  return "other";
}

function fkColumnsOnto(ctx: HandlerCtx, parent: string): FkRef[] {
  const tables = ctx.db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name != ?`
    )
    .all(parent) as { name: string }[];
  const refs: FkRef[] = [];
  for (const { name } of tables) {
    const fks = ctx.db
      .prepare(`PRAGMA foreign_key_list(${JSON.stringify(name)})`)
      .all() as {
      table: string;
      from: string;
      to: string | null;
    }[];
    for (const fk of fks) {
      if (fk.table !== parent) continue;
      refs.push({ table: name, column: fk.from, pk: primaryKeyOf(ctx, name) });
    }
  }
  return refs;
}

function laterIso(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}

function foldPeopleProfile(
  ctx: HandlerCtx,
  survivor: string,
  merged: string
): void {
  type Profile = {
    cadence_days: number;
    last_contacted_at: string | null;
    avatar_color: string | null;
    role: string | null;
    met: string | null;
  };
  const load = (partyId: string): Profile | undefined =>
    ctx.db
      .prepare(
        `SELECT cadence_days, last_contacted_at, avatar_color, role, met
           FROM people_profile WHERE party_id = ?`
      )
      .get(partyId) as Profile | undefined;
  const kept = load(survivor);
  const extra = load(merged);
  if (!extra) return;
  if (!kept) {
    ctx.db
      .prepare("UPDATE people_profile SET party_id = ? WHERE party_id = ?")
      .run(survivor, merged);
    return;
  }
  ctx.db
    .prepare(
      `UPDATE people_profile
          SET cadence_days = ?, last_contacted_at = ?, avatar_color = ?,
              role = ?, met = ?
        WHERE party_id = ?`
    )
    .run(
      kept.cadence_days > 0 ? kept.cadence_days : extra.cadence_days,
      laterIso(kept.last_contacted_at, extra.last_contacted_at),
      kept.avatar_color ?? extra.avatar_color,
      kept.role ?? extra.role,
      kept.met ?? extra.met,
      survivor
    );
  ctx.db.prepare("DELETE FROM people_profile WHERE party_id = ?").run(merged);
}

function foldPartyPointers(
  ctx: HandlerCtx,
  survivor: string,
  merged: string
): { repointed: number; revoked: number; deduped: number } {
  let repointed = 0;
  let revoked = 0;
  let deduped = 0;
  for (const pointer of PARTY_POINTER_REGISTRY) {
    const pk =
      (
        ctx.db
          .prepare(`PRAGMA table_info(${JSON.stringify(pointer.table)})`)
          .all() as { name: string; pk: number }[]
      ).find((column) => column.pk === 1)?.name ?? "rowid";
    const scope = pointer.predicate ? ` AND ${pointer.predicate}` : "";
    const rows = ctx.db
      .prepare(
        `SELECT "${pk}" AS pk FROM "${pointer.table}"
          WHERE "${pointer.column}" = ?${scope}`
      )
      .all(merged) as { pk: string | number }[];
    for (const row of rows) {
      try {
        ctx.db
          .prepare(
            `UPDATE "${pointer.table}" SET "${pointer.column}" = ?
              WHERE "${pk}" = ?`
          )
          .run(survivor, row.pk);
        repointed += 1;
      } catch {
        if (pointer.collision === "revoke") {
          ctx.db
            .prepare(
              `UPDATE "${pointer.table}"
                  SET revoked_at = ?, "${pointer.column}" = ?
                WHERE "${pk}" = ?`
            )
            .run(ctx.now, survivor, row.pk);
          repointed += 1;
          revoked += 1;
        } else {
          ctx.db
            .prepare(`DELETE FROM "${pointer.table}" WHERE "${pk}" = ?`)
            .run(row.pk);
          deduped += 1;
        }
      }
    }
  }
  return { repointed, revoked, deduped };
}

type MergeCollision =
  | { kind: "sum"; column: string }
  | { kind: "demote"; column: string }
  | { kind: "drop-duplicate" };

const MERGE_COLLISIONS: Readonly<Record<string, MergeCollision>> = {
  tally_expense_split: { kind: "sum", column: "share_minor" },
  tally_expense_payer: { kind: "sum", column: "paid_minor" },
  tally_expense_line_allocation: { kind: "sum", column: "share_minor" },
  tally_recurring_expense_split: { kind: "sum", column: "share_minor" },
  core_party_identifier: { kind: "demote", column: "is_primary" },
  social_contact_channel: { kind: "demote", column: "is_preferred" },
};

export interface FoldTally {
  repointed: number;
  deduped: number;
  summed: number;
  degenerate: number;
}

function repointRow(
  ctx: HandlerCtx,
  ref: FkRef,
  key: Record<string, unknown>,
  survivor: string,
  merged: string,
  tally: FoldTally
): void {
  const where = keyWhere(ref.pk);
  const values = keyValues(ref.pk, key);
  try {
    ctx.db
      .prepare(`UPDATE "${ref.table}" SET "${ref.column}" = ? WHERE ${where}`)
      .run(survivor, ...values);
    tally.repointed += 1;
    return;
  } catch (error) {
    const failure = constraintClassOf(error);
    if (failure === "check") {
      ctx.db
        .prepare(`DELETE FROM "${ref.table}" WHERE ${where}`)
        .run(...values);
      tally.degenerate += 1;
      return;
    }
    if (failure !== "unique") throw error;
  }
  const policy = MERGE_COLLISIONS[ref.table] ?? { kind: "drop-duplicate" };
  if (policy.kind === "sum" && ref.pk.includes(ref.column)) {
    const survivorValues: KeyValue[] = ref.pk.map((column) =>
      column === ref.column ? survivor : (key[`pk_${column}`] as KeyValue)
    );
    const amount = ctx.db
      .prepare(
        `SELECT "${policy.column}" AS amount FROM "${ref.table}" WHERE ${where}`
      )
      .get(...values) as { amount: number } | undefined;
    ctx.db
      .prepare(
        `UPDATE "${ref.table}" SET "${policy.column}" = "${policy.column}" + ?
          WHERE ${where}`
      )
      .run(Number(amount?.amount ?? 0), ...survivorValues);
    ctx.db.prepare(`DELETE FROM "${ref.table}" WHERE ${where}`).run(...values);
    tally.summed += 1;
    return;
  }
  if (policy.kind === "demote") {
    try {
      ctx.db
        .prepare(
          `UPDATE "${ref.table}" SET "${ref.column}" = ?, "${policy.column}" = 0
            WHERE ${where}`
        )
        .run(survivor, ...values);
      tally.repointed += 1;
      return;
    } catch (error) {
      if (constraintClassOf(error) !== "unique") throw error;
    }
  }
  ctx.db.prepare(`DELETE FROM "${ref.table}" WHERE ${where}`).run(...values);
  tally.deduped += 1;
}

function foldForeignKeys(
  ctx: HandlerCtx,
  physical: string,
  survivor: string,
  merged: string,
  tally: FoldTally
): void {
  for (const ref of fkColumnsOnto(ctx, physical)) {
    const rows = ctx.db
      .prepare(
        `SELECT ${selectKey(ref.pk)} FROM "${ref.table}" WHERE "${ref.column}" = ?`
      )
      .all(merged) as Record<string, unknown>[];
    for (const row of rows) repointRow(ctx, ref, row, survivor, merged, tally);
  }
}

function foldEntityPointers(
  ctx: HandlerCtx,
  entity: string,
  survivor: string,
  merged: string,
  tally: FoldTally
): void {
  for (const pointer of ENTITY_POINTERS) {
    const pk = primaryKeyOf(ctx, pointer.table);
    for (const pair of pointer.pairs) {
      const ref: FkRef = { table: pointer.table, column: pair.idCol, pk };
      const rows = ctx.db
        .prepare(
          `SELECT ${selectKey(pk)} FROM "${pointer.table}"
            WHERE "${pair.typeCol}" = ? AND "${pair.idCol}" = ?`
        )
        .all(entity, merged) as Record<string, unknown>[];
      for (const row of rows)
        repointRow(ctx, ref, row, survivor, merged, tally);
    }
  }
}

export interface MergeableEntity {
  entity: string;
  physical: string;
  idColumn: string;
  before?: (ctx: HandlerCtx, survivor: string, merged: string) => void;
  partyPointers?: boolean;
}

export const MERGEABLE: readonly MergeableEntity[] = [
  {
    entity: "core.party",
    physical: "core_party",
    idColumn: "party_id",
    before: foldPeopleProfile,
    partyPointers: true,
  },
  { entity: "core.place", physical: "core_place", idColumn: "place_id" },
  { entity: "core.concept", physical: "core_concept", idColumn: "concept_id" },
  {
    entity: "core.content_item",
    physical: "core_content_item",
    idColumn: "content_id",
  },
  {
    entity: "core.document",
    physical: "core_document",
    idColumn: "document_id",
  },
  { entity: "media.asset", physical: "media_asset", idColumn: "asset_id" },
];

export const MERGEABLE_ENTITIES: readonly string[] = MERGEABLE.map(
  (m) => m.entity
);

export function mergeEntity(
  ctx: HandlerCtx,
  spec: MergeableEntity,
  survivor: string,
  merged: string
): FoldTally & { revoked: number } {
  const tally: FoldTally = {
    repointed: 0,
    deduped: 0,
    summed: 0,
    degenerate: 0,
  };
  spec.before?.(ctx, survivor, merged);
  let revoked = 0;
  if (spec.partyPointers) {
    const pointers = foldPartyPointers(ctx, survivor, merged);
    tally.repointed += pointers.repointed;
    tally.deduped += pointers.deduped;
    revoked = pointers.revoked;
  }
  foldForeignKeys(ctx, spec.physical, survivor, merged, tally);
  foldEntityPointers(ctx, spec.entity, survivor, merged, tally);
  ctx.db
    .prepare(`DELETE FROM "${spec.physical}" WHERE "${spec.idColumn}" = ?`)
    .run(merged);
  ctx.wrote(spec.entity, survivor);
  ctx.wrote(spec.entity, merged);
  return { ...tally, revoked };
}

export function citeMerge(
  ctx: HandlerCtx,
  spec: MergeableEntity,
  survivor: string,
  merged: string,
  tally: FoldTally & { revoked: number }
): void {
  ctx.cite({
    claim:
      `${spec.entity} ${merged} folded into ${survivor}: ${tally.repointed} reference(s) ` +
      `re-pointed, ${tally.deduped} duplicate relation(s) removed` +
      (tally.summed ? `, ${tally.summed} share(s) added together` : "") +
      (tally.degenerate
        ? `, ${tally.degenerate} row(s) that became self-referential dropped`
        : "") +
      (tally.revoked
        ? `, ${tally.revoked} duplicate standing answer(s) revoked`
        : ""),
    entityType: spec.entity,
    entityId: survivor,
  });
}
