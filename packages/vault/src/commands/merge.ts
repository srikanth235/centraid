// core.merge_party (#290): without a merge every added source DEGRADES the
// vault. Folds B into A — engine FKs re-point (PRAGMA foreign_key_list, no
// hand-kept list), polymorphic refs follow, the FK-less party pointers follow
// from their own registry, identifiers demote rather than vanish, B's row
// deletes, history is not rewritten. Uniqueness collisions dedupe onto the
// survivor's copy; a handle is never lost.

import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";
import {
  citeMerge,
  MERGEABLE,
  MERGEABLE_ENTITIES,
  mergeEntity,
} from "./merge-fold.js";
import type { MergeableEntity } from "./merge-fold.js";

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
      sql: `SELECT count(*) AS n FROM core_vault WHERE self_party_id = :merged_party_id`,
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

function mergeParty(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    survivor_party_id: string;
    merged_party_id: string;
  };
  const spec = MERGEABLE[0] as MergeableEntity;
  const tally = mergeEntity(
    ctx,
    spec,
    input.survivor_party_id,
    input.merged_party_id
  );
  citeMerge(ctx, spec, input.survivor_party_id, input.merged_party_id, tally);
  return {
    survivor_party_id: input.survivor_party_id,
    repointed: tally.repointed,
    deduped: tally.deduped,
  };
}

/**
 * The same fold for every other entity that gets minted per observation
 * (#916, review 2.2). One command rather than five near-identical ones: the
 * walks are the registry's, so the only per-entity knowledge is the row above.
 */
const MERGE_ENTITY: CommandDefinition = {
  name: "core.merge_entity",
  ownerSchema: "core",
  inputSchema: {
    type: "object",
    required: ["entity_type", "survivor_id", "merged_id"],
    additionalProperties: false,
    properties: {
      entity_type: { type: "string", enum: [...MERGEABLE_ENTITIES] },
      survivor_id: { type: "string", minLength: 1 },
      merged_id: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["survivor_id", "repointed"],
    properties: {
      survivor_id: { type: "string" },
      repointed: { type: "integer" },
      deduped: { type: "integer" },
      summed: { type: "integer" },
    },
  },
  preconditions: [
    {
      name: "two_distinct_live_entities",
      sql: `SELECT count(*) AS n FROM core_entity
             WHERE entity_type = :entity_type
               AND entity_id IN (:survivor_id, :merged_id)
               AND :survivor_id != :merged_id`,
      column: "n",
      op: "eq",
      value: 2,
    },
  ],
  postconditions: [
    {
      name: "merged_entity_gone",
      sql: `SELECT count(*) AS n FROM core_entity
             WHERE entity_type = :entity_type AND entity_id = :merged_id`,
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  idempotency: "once",
  risk: "high",
  confirm: true,
  handler: (ctx) => {
    const input = ctx.input as {
      entity_type: string;
      survivor_id: string;
      merged_id: string;
    };
    const spec = MERGEABLE.find((m) => m.entity === input.entity_type);
    if (!spec) throw new Error(`${input.entity_type} cannot be merged`);
    if (spec.entity === "core.party") {
      const self = ctx.db
        .prepare("SELECT count(*) AS n FROM core_vault WHERE self_party_id = ?")
        .get(input.merged_id) as { n: number };
      if (self.n > 0) throw new Error("the vault owner cannot be merged away");
    }
    const tally = mergeEntity(ctx, spec, input.survivor_id, input.merged_id);
    citeMerge(ctx, spec, input.survivor_id, input.merged_id, tally);
    return {
      survivor_id: input.survivor_id,
      repointed: tally.repointed,
      deduped: tally.deduped,
      summed: tally.summed,
    };
  },
};

// Convergence sweep (#310): handle→party resolution runs at import time only,
// so per-source duplicates accumulate unsurfaced. Deterministic candidates
// only; the assistant proposes and merge stays owner-confirmed.
/**
 * The claims that let a member tell two same-named rows apart. BOTH stores
 * (#883): reach on `social_contact_channel`, identity keys in the register —
 * reading only one leaves a duplicate card showing two identical names.
 */
function IDENTIFIER_CONTEXT_SQL(alias: string): string {
  return `SELECT group_concat(claim, ', ') FROM (
            SELECT scheme || ':' || value AS claim
              FROM core_party_identifier WHERE party_id = ${alias}.party_id
            UNION ALL
            SELECT kind || ':' || normalized_value AS claim
              FROM social_contact_channel WHERE party_id = ${alias}.party_id
          )`;
}

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
                (${IDENTIFIER_CONTEXT_SQL("a")}) AS a_identifiers,
                (${IDENTIFIER_CONTEXT_SQL("b")}) AS b_identifiers
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
  gateway.registerCommand(MERGE_ENTITY);
  gateway.registerCommand(FIND_DUPLICATES);
}
