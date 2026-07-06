// core.merge_party (issue #290 phase 2) — the entity-resolution primitive.
// Multi-source ingestion inevitably mints duplicate people ("J. Smith" from
// Takeout, "john.smith@…" from an MBOX); without a merge, every added source
// DEGRADES the vault. Merging folds party B into party A: every engine FK
// re-points (discovered via PRAGMA foreign_key_list — no hand-kept table
// list to rot), every polymorphic (type, id) reference follows, identifiers
// move with primary-flag demotion, and B's row is deleted. History is not
// rewritten: provenance records the merge on both ids and receipts stay.
//
// A re-pointed row that collides with a uniqueness constraint (B and A both
// members of the same tally group; both holding a people_profile) is the
// survivor already owning that relation — the duplicate row deletes, except
// identifiers, which demote to non-primary rather than vanish (a handle is
// never lost in a merge).

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';

/** Polymorphic (type, id) columns that may reference a party (§10 S4). */
const POLY_COLUMNS: { table: string; typeCol: string; idCol: string }[] = [
  { table: 'core_link', typeCol: 'from_type', idCol: 'from_id' },
  { table: 'core_link', typeCol: 'to_type', idCol: 'to_id' },
  { table: 'core_tag', typeCol: 'target_type', idCol: 'target_id' },
  { table: 'core_attachment', typeCol: 'subject_type', idCol: 'subject_id' },
  { table: 'core_collection_entry', typeCol: 'target_type', idCol: 'target_id' },
  { table: 'knowledge_annotation', typeCol: 'target_type', idCol: 'target_id' },
];

const MERGE_PARTY: CommandDefinition = {
  name: 'core.merge_party',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['survivor_party_id', 'merged_party_id'],
    additionalProperties: false,
    properties: {
      survivor_party_id: { type: 'string', minLength: 1 },
      merged_party_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['survivor_party_id', 'repointed'],
    properties: {
      survivor_party_id: { type: 'string' },
      repointed: { type: 'integer' },
      deduped: { type: 'integer' },
    },
  },
  preconditions: [
    {
      name: 'two_distinct_live_people',
      sql: `SELECT count(*) AS n FROM core_party
             WHERE party_id IN (:survivor_party_id, :merged_party_id)
               AND kind != 'agent'
               AND :survivor_party_id != :merged_party_id`,
      column: 'n',
      op: 'eq',
      value: 2,
    },
    {
      // The vault owner's identity row is structural — nothing merges INTO oblivion.
      name: 'merged_is_not_the_owner',
      sql: `SELECT count(*) AS n FROM core_vault WHERE owner_party_id = :merged_party_id`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  postconditions: [
    {
      name: 'merged_party_gone',
      sql: 'SELECT count(*) AS n FROM core_party WHERE party_id = :merged_party_id',
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  idempotency: 'once',
  risk: 'high',
  handler: mergeParty,
};

interface FkRef {
  table: string;
  column: string;
  pk: string;
}

/** Every engine FK column referencing core_party(party_id), discovered live. */
function partyFkColumns(ctx: HandlerCtx): FkRef[] {
  const tables = ctx.db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name != 'core_party'`,
    )
    .all() as { name: string }[];
  const refs: FkRef[] = [];
  for (const { name } of tables) {
    const fks = ctx.db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(name)})`).all() as {
      table: string;
      from: string;
      to: string | null;
    }[];
    for (const fk of fks) {
      if (fk.table !== 'core_party') continue;
      const pkRow = (
        ctx.db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all() as {
          name: string;
          pk: number;
        }[]
      ).find((c) => c.pk === 1);
      refs.push({ table: name, column: fk.from, pk: pkRow?.name ?? 'rowid' });
    }
  }
  return refs;
}

function mergeParty(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { survivor_party_id: string; merged_party_id: string };
  const survivor = input.survivor_party_id;
  const merged = input.merged_party_id;
  let repointed = 0;
  let deduped = 0;

  for (const ref of partyFkColumns(ctx)) {
    const rows = ctx.db
      .prepare(
        `SELECT "${ref.pk}" AS pk FROM "${ref.table}" WHERE "${ref.column}" = ?`,
      )
      .all(merged) as { pk: string | number }[];
    for (const row of rows) {
      try {
        ctx.db
          .prepare(`UPDATE "${ref.table}" SET "${ref.column}" = ? WHERE "${ref.pk}" = ?`)
          .run(survivor, row.pk);
        repointed += 1;
      } catch {
        if (ref.table === 'core_party_identifier') {
          // The survivor already has a primary handle of this scheme —
          // demote and keep; a handle is never lost in a merge.
          ctx.db
            .prepare(
              `UPDATE core_party_identifier SET party_id = ?, is_primary = 0 WHERE identifier_id = ?`,
            )
            .run(survivor, row.pk);
          repointed += 1;
        } else {
          // Uniqueness collision: the survivor already holds this relation.
          ctx.db.prepare(`DELETE FROM "${ref.table}" WHERE "${ref.pk}" = ?`).run(row.pk);
          deduped += 1;
        }
      }
    }
  }

  for (const poly of POLY_COLUMNS) {
    const pkRow = (
      ctx.db.prepare(`PRAGMA table_info(${JSON.stringify(poly.table)})`).all() as {
        name: string;
        pk: number;
      }[]
    ).find((c) => c.pk === 1);
    const pk = pkRow?.name ?? 'rowid';
    const rows = ctx.db
      .prepare(
        `SELECT "${pk}" AS pk FROM "${poly.table}"
          WHERE "${poly.typeCol}" = 'core.party' AND "${poly.idCol}" = ?`,
      )
      .all(merged) as { pk: string | number }[];
    for (const row of rows) {
      try {
        ctx.db
          .prepare(`UPDATE "${poly.table}" SET "${poly.idCol}" = ? WHERE "${pk}" = ?`)
          .run(survivor, row.pk);
        repointed += 1;
      } catch {
        // Both parties carried the same tag / entry — the survivor's copy wins.
        ctx.db.prepare(`DELETE FROM "${poly.table}" WHERE "${pk}" = ?`).run(row.pk);
        deduped += 1;
      }
    }
  }
  // The external-id map follows: future syncs of B's source land on A.
  const mapRes = ctx.db
    .prepare(
      `UPDATE sync_external_entity SET entity_id = ? WHERE entity_type = 'core.party' AND entity_id = ?`,
    )
    .run(survivor, merged);
  repointed += Number(mapRes.changes);

  ctx.db.prepare('DELETE FROM core_party WHERE party_id = ?').run(merged);
  ctx.wrote('core.party', survivor);
  ctx.wrote('core.party', merged);
  ctx.cite({
    claim: `party ${merged} folded into ${survivor}: ${repointed} reference(s) re-pointed, ${deduped} duplicate relation(s) removed`,
    entityType: 'core.party',
    entityId: survivor,
  });
  return { survivor_party_id: survivor, repointed, deduped };
}

/** Register the merge primitive on a gateway. */
export function registerMergeCommands(gateway: Gateway): void {
  gateway.registerCommand(MERGE_PARTY);
}
