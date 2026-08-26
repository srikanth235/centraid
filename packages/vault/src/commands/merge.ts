// core.merge_party (#290): multi-source ingestion mints duplicate people and
// without a merge every added source DEGRADES the vault. Folds party B into
// A: engine FKs re-point (PRAGMA foreign_key_list — no hand-kept list),
// polymorphic refs follow, identifiers demote rather than vanish, B's row
// deletes; history is not rewritten. Uniqueness collisions dedupe onto the
// survivor's copy; a handle is never lost in a merge.

import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";
import { POLY_REF_REGISTRY } from "../schema/poly-refs.js";

const MERGE_PARTY: CommandDefinition = {
  name: "core.merge_party",
  ownerSchema: "core",
  inputSchema: {
    type: "object",
    required: ["survivor_party_id", "merged_party_id"],
    additionalProperties: false,
    properties: {
      survivor_party_id: { type: "string", minLength: 1 },
      merged_party_id: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["survivor_party_id", "repointed"],
    properties: {
      survivor_party_id: { type: "string" },
      repointed: { type: "integer" },
      deduped: { type: "integer" },
    },
  },
  preconditions: [
    {
      name: "two_distinct_live_people",
      sql: `SELECT count(*) AS n FROM core_party
             WHERE party_id IN (:survivor_party_id, :merged_party_id)
               AND kind != 'agent'
               AND :survivor_party_id != :merged_party_id`,
      column: "n",
      op: "eq",
      value: 2,
    },
    {
      name: "merged_is_not_the_owner",
      sql: `SELECT count(*) AS n FROM core_vault WHERE owner_party_id = :merged_party_id`,
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  postconditions: [
    {
      name: "merged_party_gone",
      sql: "SELECT count(*) AS n FROM core_party WHERE party_id = :merged_party_id",
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  idempotency: "once",
  // Tier 4 (#306): an irreversible merge stays loud on purpose.
  risk: "high",
  confirm: true,
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
        AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name != 'core_party'`
    )
    .all() as { name: string }[];
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
      if (fk.table !== "core_party") continue;
      const pkRow = (
        ctx.db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all() as {
          name: string;
          pk: number;
        }[]
      ).find((c) => c.pk === 1);
      refs.push({ table: name, column: fk.from, pk: pkRow?.name ?? "rowid" });
    }
  }
  return refs;
}

function mergeParty(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    survivor_party_id: string;
    merged_party_id: string;
  };
  const survivor = input.survivor_party_id;
  const merged = input.merged_party_id;
  let repointed = 0;
  let deduped = 0;

  for (const ref of partyFkColumns(ctx)) {
    const rows = ctx.db
      .prepare(
        `SELECT "${ref.pk}" AS pk FROM "${ref.table}" WHERE "${ref.column}" = ?`
      )
      .all(merged) as { pk: string | number }[];
    for (const row of rows) {
      try {
        ctx.db
          .prepare(
            `UPDATE "${ref.table}" SET "${ref.column}" = ? WHERE "${ref.pk}" = ?`
          )
          .run(survivor, row.pk);
        repointed += 1;
      } catch {
        if (ref.table === "core_party_identifier") {
          // Survivor already holds a primary handle of this scheme — demote, keep.
          ctx.db
            .prepare(
              `UPDATE core_party_identifier SET party_id = ?, is_primary = 0 WHERE identifier_id = ?`
            )
            .run(survivor, row.pk);
          repointed += 1;
        } else {
          ctx.db
            .prepare(`DELETE FROM "${ref.table}" WHERE "${ref.pk}" = ?`)
            .run(row.pk);
          deduped += 1;
        }
      }
    }
  }

  // Polymorphic refs: same closed registry purge uses — no drift (#450).
  for (const poly of POLY_REF_REGISTRY.flatMap((entry) =>
    entry.pairs.map((pair) => ({ table: entry.table, ...pair }))
  )) {
    const pkRow = (
      ctx.db
        .prepare(`PRAGMA table_info(${JSON.stringify(poly.table)})`)
        .all() as {
        name: string;
        pk: number;
      }[]
    ).find((c) => c.pk === 1);
    const pk = pkRow?.name ?? "rowid";
    const rows = ctx.db
      .prepare(
        `SELECT "${pk}" AS pk FROM "${poly.table}"
          WHERE "${poly.typeCol}" = 'core.party' AND "${poly.idCol}" = ?`
      )
      .all(merged) as { pk: string | number }[];
    for (const row of rows) {
      try {
        ctx.db
          .prepare(
            `UPDATE "${poly.table}" SET "${poly.idCol}" = ? WHERE "${pk}" = ?`
          )
          .run(survivor, row.pk);
        repointed += 1;
      } catch {
        ctx.db
          .prepare(`DELETE FROM "${poly.table}" WHERE "${pk}" = ?`)
          .run(row.pk);
        deduped += 1;
      }
    }
  }
  ctx.db.prepare("DELETE FROM core_party WHERE party_id = ?").run(merged);
  ctx.wrote("core.party", survivor);
  ctx.wrote("core.party", merged);
  ctx.cite({
    claim: `party ${merged} folded into ${survivor}: ${repointed} reference(s) re-pointed, ${deduped} duplicate relation(s) removed`,
    entityType: "core.party",
    entityId: survivor,
  });
  return { survivor_party_id: survivor, repointed, deduped };
}

// Convergence sweep (#310): handle→party resolution runs at import time only,
// so per-source duplicates accumulate unsurfaced; this read reports
// deterministic candidates (case-insensitive display-name collisions plus
// identifier schemes). The assistant proposes; merge stays owner-confirmed.
const FIND_DUPLICATES: CommandDefinition = {
  name: "core.find_duplicate_parties",
  ownerSchema: "core",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { limit: { type: "integer", minimum: 1, maximum: 500 } },
  },
  outputSchema: {
    type: "object",
    required: ["candidates"],
    properties: { candidates: { type: "array" } },
  },
  preconditions: [],
  postconditions: [],
  idempotency: "retry-safe",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as { limit?: number };
    const limit = input.limit ?? 100;
    const rows = ctx.db
      .prepare(
        `SELECT a.party_id AS party_a, b.party_id AS party_b, a.display_name AS display_name,
                (SELECT group_concat(scheme || ':' || value, ', ') FROM core_party_identifier WHERE party_id = a.party_id) AS a_identifiers,
                (SELECT group_concat(scheme || ':' || value, ', ') FROM core_party_identifier WHERE party_id = b.party_id) AS b_identifiers
           FROM core_party a
           JOIN core_party b
             ON lower(a.display_name) = lower(b.display_name)
            AND a.party_id < b.party_id
          WHERE a.kind = 'person' AND b.kind = 'person'
          ORDER BY a.display_name
          LIMIT ?`
      )
      .all(limit) as Record<string, unknown>[];
    for (const r of rows) {
      ctx.cite({
        claim: `possible duplicate person: "${String(r.display_name)}"`,
        entityType: "core.party",
        entityId: String(r.party_a),
      });
    }
    return { candidates: rows };
  },
};

export function registerMergeCommands(gateway: Gateway): void {
  gateway.registerCommand(MERGE_PARTY);
  gateway.registerCommand(FIND_DUPLICATES);
}
