// The MERGE ENGINE (#916, review 2.1/2.2): the two walks that re-point every
// reference to a folded-in row — the engine's foreign keys, and the composite
// keys into the entity supertype — and the per-table policy for what a
// collision means. Split from `merge.ts`, which is the command surface over
// it: the walks are shared by every mergeable entity and are the part with the
// interesting failure modes.

import type { HandlerCtx } from "../gateway/types.js";
import { ENTITY_POINTERS } from "../schema/entity-refs.js";
import { PARTY_POINTER_REGISTRY } from "../schema/party-pointers.js";

export interface FkRef {
  table: string;
  column: string;
  /** EVERY primary key column, in key order — see `primaryKeyOf`. */
  pk: readonly string[];
}

/**
 * THE PRIMARY KEY, WHOLE (#916, review 2.1).
 *
 * This used to be `cols.find((c) => c.pk === 1)?.name`, read as "the primary
 * key column". `PRAGMA table_info.pk` is not a boolean: it is the column's
 * POSITION in the key, 1-based. On `tally_expense_split (expense_id,
 * party_id)` that returned `expense_id` alone, so a merge's "re-point this one
 * row" ran `UPDATE ... WHERE expense_id = ?` and rewrote — or, on the
 * collision path, DELETED — every split of the expense. A shared 900 became an
 * expense with no splits and no payers, silently.
 */
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

/**
 * WHICH constraint refused, so the fold can answer it rather than reach for
 * the delete (#916, review 2.1). The old code caught every failure and deleted
 * the row: a UNIQUE collision (the survivor already has this) and a CHECK
 * violation (the merge just made this row nonsense) and a foreign-key refusal
 * (a bug) were all "duplicate relation removed" in the citation.
 */
type ConstraintClass = "unique" | "check" | "foreign-key" | "other";

function constraintClassOf(error: unknown): ConstraintClass {
  const message = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed|PRIMARY KEY/iu.test(message)) return "unique";
  if (/CHECK constraint failed/iu.test(message)) return "check";
  if (/FOREIGN KEY constraint failed/iu.test(message)) return "foreign-key";
  return "other";
}

/** Every engine FK column referencing a table, discovered live. */
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

/**
 * `people_profile.party_id` is UNIQUE, so the generic re-point would delete the
 * duplicate's cadence, last-contacted and colour: fold them first (#864).
 */
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

/**
 * The FK-less party pointers, from the one registry that enumerates them
 * (`schema/poly-refs.ts`). Neither walk in `mergeParty` can reach these — there
 * is no foreign key for `PRAGMA foreign_key_list` to find, and no `core.party`
 * type column for the polymorphic sweep to match — so a merge that skipped them
 * would delete the folded-in party out from under a live pointer and break the
 * feature holding it, silently.
 *
 * A collision means the survivor already satisfies the constraint. What happens
 * to the loser is the registry's call, not this walk's: an ANSWER is dated shut
 * and kept, duplicate machinery is dropped. Revoking BEFORE re-pointing is also
 * the only order that works where the constraint covers live rows only.
 */
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

/**
 * WHAT A COLLISION MEANS, per table (#916, review 2.1/2.2).
 *
 * The old fold had one answer for every refusal — delete the row — with two
 * hand-written exceptions. That is how a merge could destroy money: the splits
 * and payers of a shared expense are keyed `(expense_id, party_id)`, so
 * folding two people who both appear on one bill collides, and "delete" threw
 * away a share the total still counted. A share is a NUMBER: the right answer
 * is to add it to the survivor's.
 */
type MergeCollision =
  /** Both rows are real and their amounts add: fold onto the survivor's row. */
  | { kind: "sum"; column: string }
  /** A second row of a kind only one may be primary: keep it, demote it. */
  | { kind: "demote"; column: string }
  /** Duplicate machinery saying nothing the survivor's copy does not. */
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

/**
 * Re-point ONE row from `merged` to `survivor`, answering whichever constraint
 * refuses.
 *
 * A CHECK failure is the merge's own doing and has exactly one honest reading:
 * the two sides of a two-party row just became the same party. A payment from
 * someone to themselves is not a payment, and a debt to oneself is not a debt,
 * so the row is folded away and COUNTED as such. A FOREIGN KEY failure is a
 * bug in this code or a corrupt vault and is re-thrown — the old blanket catch
 * turned it into a silent delete.
 */
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
      // Both ends are the survivor now: the row says nothing.
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
    // The survivor's row carries the same key with this column swapped.
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
      // A collision on the VALUE, not on primacy: a genuine duplicate.
      if (constraintClassOf(error) !== "unique") throw error;
    }
  }
  ctx.db.prepare(`DELETE FROM "${ref.table}" WHERE ${where}`).run(...values);
  tally.deduped += 1;
}

/** The engine FK walk: every column REFERENCING the merged row's table. */
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

/**
 * The polymorphic pointers, from the registry the entity supertype is built
 * from — the same list the engine's composite foreign keys are generated from,
 * so the two cannot drift (#916).
 */
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

/**
 * What can be merged, and what each one needs done that the two generic walks
 * cannot see (#916, review 2.2).
 *
 * Only parties had a merge, and every other minted-per-observation entity
 * accumulated duplicates with no way back: `findOrCreatePlaceTx` mints a place
 * per four-decimal coordinate, so one café becomes a dozen; concepts arrive
 * per import; assets, documents and content items arrive per copy of the same
 * bytes.
 */
export interface MergeableEntity {
  entity: string;
  physical: string;
  idColumn: string;
  /** Fold-first work for a UNIQUE sidecar the generic walk would delete. */
  before?: (ctx: HandlerCtx, survivor: string, merged: string) => void;
  /** Pointers with no foreign key for `PRAGMA foreign_key_list` to find. */
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
