// The polymorphic-reference registry (#441).
//
// Engine FKs cannot cover the vault's polymorphic `(type, id)` mechanisms —
// a `target_type='core.party'` / `target_id=…` pair is a logical reference
// SQLite knows nothing about — so a hard delete of a canonical row must clean
// up every polymorphic pointer at it BY HAND. That hand-maintenance was
// provably uneven: `core_link`/`core_tag`/`core_collection_entry` were swept
// generically, `knowledge_annotation`/`core_attachment` only for notes, and
// `enrich_embedding`/`sync_external_entity` never at all (orphan vectors
// resurface deleted content in search, stale sync-map rows make re-import
// silently skip a purged entity).
//
// This registry enumerates the SET, once. `cleanupPolyRefs` walks it, so the
// purge sweep is complete BY CONSTRUCTION and the next mechanism is one entry
// here, not a remembered sweep clause. `poly-refs.test.ts` scans the live DDL
// of both files and asserts every `(table, type/id pair)` is either registered
// below or in `POLY_REF_EXCLUSIONS` — a 7th mechanism added without a registry
// entry fails that test. (Part B's Browse tab needs exactly this metadata for
// dependent-aware deletes, since polymorphic dependents are invisible to
// `PRAGMA foreign_key_list`.)

import type { DatabaseSync } from "node:sqlite";

/**
 * What happens to a live polymorphic pointer when its target row is purged:
 *   - `end-date`: temporal relation — stamp `valid_to = now` on open rows
 *     (a link onto a purged row ends, it does not dangle; #272).
 *   - `delete`: classification/curation/derived data that says nothing once
 *     the row is gone — remove it (#274).
 */
export type PolyRefPolicy = "end-date" | "delete";

export interface PolyRefPair {
  /** Column holding the logical entity name, e.g. `target_type`. */
  typeCol: string;
  /** Column holding the target row's id, e.g. `target_id`. */
  idCol: string;
}

export interface PolyRefEntry {
  /** Physical vault.db table name. */
  table: string;
  /**
   * The `(type, id)` column pair(s) that point at a canonical row. `core_link`
   * is the only table with two (its from- and to- endpoints); every other
   * mechanism carries exactly one.
   */
  pairs: PolyRefPair[];
  policy: PolyRefPolicy;
  /**
   * Raw-SQL predicate ANDed onto the type/id match (no bound parameters).
   * Only `enrich_request` uses it, to scope cleanup to still-open queue rows —
   * a drained request is inert completed history, an open one would send an
   * enricher after a row that no longer exists.
   */
  predicate?: string;
  note: string;
}

/**
 * Every polymorphic reference in vault.db that must be cleaned when its target
 * is hard-deleted. Ordered core → domain → consent/enrich/sync for reading;
 * `cleanupPolyRefs` applies them in one pass, and the order among them is
 * immaterial (no table here FKs another).
 */
export const POLY_REF_REGISTRY: readonly PolyRefEntry[] = [
  {
    table: "core_link",
    pairs: [
      { typeCol: "from_type", idCol: "from_id" },
      { typeCol: "to_type", idCol: "to_id" },
    ],
    policy: "end-date",
    note: "A relation onto a purged row ends rather than dangles (issue #272). An open link matching EITHER endpoint is end-dated.",
  },
  {
    table: "core_tag",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    policy: "delete",
    note: "Classification says nothing once the row is gone (issue #274).",
  },
  {
    table: "core_collection_entry",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    policy: "delete",
    note: "Curation membership says nothing once the row is gone (issue #274).",
  },
  {
    table: "core_share_origin",
    pairs: [{ typeCol: "item_type", idCol: "item_id" }],
    policy: "delete",
    note: "Share-by-placement provenance (issue #599 decision 11): the record of where a PROJECTED row came from. Once that row is purged out of the audience vault there is nothing left to attribute, exactly like a tag — and a stale record would keep an audience badge claiming a shared item that no longer exists.",
  },
  {
    table: "share_commons_lineage",
    pairs: [{ typeCol: "item_type", idCol: "item_id" }],
    policy: "delete",
    note: "Commons projection lineage names a resident row. Once the row is purged there is nothing left for revoke to scrub, and retaining the marker could make a later row that reuses the id look shared.",
  },
  {
    table: "share_commons_retained",
    pairs: [{ typeCol: "item_type", idCol: "item_id" }],
    policy: "delete",
    note: "Save-to-my-vault retention protects the current resident row from a later Commons revoke. If the owner purges that row, its marker must leave too so an id reused by a future row cannot inherit retention.",
  },
  {
    table: "core_attachment",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    policy: "delete",
    note: "An attachment ON a purged target dangles; previously cleaned ONLY for notes (issue #441 A1 — now for every target).",
  },
  {
    table: "knowledge_annotation",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    policy: "delete",
    note: "A margin note on a purged target dangles; previously cleaned ONLY for notes (issue #441 A1 — now for photos, documents, transactions…).",
  },
  {
    table: "schedule_recurrence_exception",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    policy: "delete",
    note: "An occurrence exception has no meaning after its event or recurring-expense template is purged; deleting it prevents a future row that reuses the id from inheriting stale skips or overrides (issue #630 W4).",
  },
  {
    table: "enrich_embedding",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    policy: "delete",
    note: "Never cleaned before (issue #441 A1): an orphan vector lets deleted content resurface in vector search — the worst-feeling class of vault bug.",
  },
  {
    table: "enrich_derivation",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    policy: "delete",
    note: "A stamp for a purged target claims that target's variant is derived and current (issue #724 W2). Left behind, an id reused by a later row inherits it, and the sweep skips work that was never done for the new content.",
  },
  {
    table: "enrich_request",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    policy: "delete",
    predicate: "drained_at IS NULL",
    note: "Open queue rows only (issue #441 A1): drop pending enrichment for a purged entity so no enricher chases a dead row. Drained rows are inert completed history.",
  },
  {
    table: "sync_external_entity",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    policy: "delete",
    note: "Never cleaned before (issue #441 A1): a stale map row makes the next import believe a purged entity is still known, so re-import SILENTLY skips it — silent data loss.",
  },
  {
    table: "consent_seed_row",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    policy: "delete",
    note: "Judgment call beyond the A1 brief (see below): a demo marker has no meaning once its entity is gone, like a tag. gateway/demo.ts already drops it on its OWN purge path; the general sweep does too now, so a demo row purged via the normal lifecycle (owner trashes a demo photo) leaves no stale marker and demoStatus stays honest.",
  },
];

/**
 * What a merge does with a party pointer whose re-point collides with a
 * uniqueness constraint the survivor already satisfies.
 *   - `revoke`: the row is a standing ANSWER, and an answer is never silently
 *     deleted — it is dated shut and then re-pointed, which is also the only
 *     order that works where the constraint covers live rows only.
 *   - `delete`: the row is duplicate machinery that says nothing the survivor's
 *     copy does not already say.
 */
export type PartyPointerCollision = "revoke" | "delete";

export interface PartyPointer {
  /** Physical vault.db table name. */
  table: string;
  /** The column holding a `core_party.party_id` with no foreign key on it. */
  column: string;
  /**
   * Raw-SQL predicate ANDed onto the match (no bound parameters), for a column
   * that holds a party id only for SOME rows.
   */
  predicate?: string;
  collision: PartyPointerCollision;
  note: string;
}

/**
 * Party pointers the engine cannot see (#290 + #883).
 *
 * `core.merge_party` re-points references two ways, and neither reaches these:
 * `PRAGMA foreign_key_list` finds nothing, because the column carries no
 * foreign key, and `POLY_REF_REGISTRY` matches `= 'core.party'`, a value these
 * columns never hold. Nor does the DDL scan in `poly-refs.test.ts` catch them —
 * it looks for `(X_type, X_id)` siblings, and neither `principal_kind` nor a
 * bare `member_party_id` has that shape. So this list is the third mechanism,
 * enumerated once for the same reason `POLY_REF_REGISTRY` is: the next
 * FK-less party pointer is one entry here, not a remembered clause.
 *
 * PURGE deliberately does not walk it — a person is soft-deleted, never purged,
 * and both rows here are meant to outlive the row they name. MERGE must, because
 * a merge DELETES the folded-in party: left behind, the pointer names a row that
 * no longer exists and the feature it belongs to silently stops working, with
 * nothing reporting a failure.
 */
export const PARTY_POINTER_REGISTRY: readonly PartyPointer[] = [
  {
    table: "share_authority",
    column: "principal_id",
    predicate: "principal_kind = 'person'",
    collision: "revoke",
    note: "The authority plane is polymorphic on BOTH sides, so `principal_id` holds a party id, a circle id, an engine class or a device id depending on `principal_kind`. A standing grant left naming the folded-in party cannot be resolved to a peer vault, so a share the owner already granted stops being delivered.",
  },
  {
    table: "share_commons_invitation",
    column: "member_party_id",
    collision: "delete",
    note: "A pending invitation names the party it is addressed to. Left behind, the ask can never be matched to the person it was for, and `UNIQUE (grant_id, member_party_id)` no longer does its job: the two ids are different rows, so one person ends up holding two open invitations to the same commons.",
  },
];

/**
 * Tables that carry a `(type, id)`-shaped pair but are deliberately NOT swept
 * on purge, each with the reason. `poly-refs.test.ts` treats membership here as
 * accounting for the pair, so an exclusion is a documented decision, never an
 * oversight. Keyed by physical table name.
 *
 * `sync_import_row`, `replica_change` and `enrich_policy_rule` are documented
 * here for completeness even though none of them is matched by the DDL scan —
 * `sync_import_row` carries `entity_type` with no `entity_id` sibling,
 * `replica_change` uses `entity`/`row_id`, and `enrich_policy_rule` uses
 * `scope_type`/`scope_ref` — so a future rename that gave any of them the
 * canonical shape would land in the scan and be forced to a decision.
 */
export const POLY_REF_EXCLUSIONS: ReadonlyMap<string, string> = new Map([
  [
    "share_circle_grant",
    "The container pair is durable Commons control truth, not an independently swept live pointer. Active root deletion is structurally refused by the actable registry; after revocation, the grant and its receipts intentionally survive container removal for restore/reconciliation and audit.",
  ],
  [
    "share_authority",
    "The subject pair is the same family as share_circle_grant's container pair (issues #825, #883): durable authority truth, not an independently swept live pointer. A standing answer states what the owner decided about a subject; purging that subject ends the answer through revocation, which is a dated decision, not a silent row deletion — and the revoked row must survive as the record that the authority once stood. This covers the plane's own subjects too: `core.vault` for a device's reach and `enrich.scope` for an egress answer name a cascade level, not a purgeable row. The PRINCIPAL pair (`principal_kind`/`principal_id`) is a different question and is not excluded by this entry — the scan cannot see it, since `principal_kind` is not `_type`-shaped. It is accounted for in `PARTY_POINTER_REGISTRY` below.",
  ],
  [
    "share_commons_invitation",
    "Consent metadata may name a container that is not present in the receiving vault before acceptance, and it remains the historical accept/refuse record after unshare. The Commons invitation lifecycle, not target-row purge, owns its status and retention.",
  ],
  [
    "core_entity_revision",
    "Append-only P5 lifecycle history (issue #630). entity_type/entity_id names the row whose pre-mutation snapshot is retained for undo, audit, and export; it must survive soft delete and eventual purge rather than being treated as a live dangling pointer.",
  ],
  [
    "consent_provenance",
    "journal.db, append-only audit stream (§03). The provenance trail of a purged row is exactly what must survive it — NEVER cleaned by design.",
  ],
  [
    "consent_receipt",
    "journal.db, append-only audit stream. object_type/object_id is the receipted subject; history is never rewritten (writeReceipt has no update path). NEVER cleaned.",
  ],
  [
    "agent_evidence",
    "journal.db, append-only audit stream. Evidence citing a since-purged entity is a historical claim about a past invocation — NEVER cleaned.",
  ],
  [
    "agent_correction",
    "The historical record of a human correcting the agent (before/after JSON). It documents a past act on the target and stays true after the target is purged — a learning-plane audit fact, not a live pointer.",
  ],
  [
    "outbox_item",
    "The external-write outbox owns its own drain lifecycle (pending → sent/discarded). target_type/target_id is the canonical row the artifact was ABOUT; a sent-message record stays meaningful after its target is purged.",
  ],
  [
    "sync_import_row",
    "Immutable import history — the row-by-row ledger of what a connector proposed. entity_type records the kind that was imported; the row is never mutated after its batch resolves.",
  ],
  [
    "replica_change",
    "Replication machinery with its own epoch/floor lifecycle (change-log.ts). It records past mutations (entity/row_id) for replica catch-up and is trimmed by epoch, not by target liveness.",
  ],
  [
    "enrich_policy_rule",
    "Not a polymorphic pointer at all (issue #807): scope_type names a CASCADE LEVEL (vault|domain|collection|item), not an ontology entity, and scope_ref is '' or a domain name at the two upper levels. A rule whose collection or item was purged matches nothing the resolver walks from a live item, so it is inert rather than dangling — and sweeping it would delete an owner decision on a purge the owner may be undoing.",
  ],
]);

/**
 * End-date / delete every polymorphic reference pointing at a just-purged
 * canonical row. `entityType` is the LOGICAL name stored in the type columns
 * (`core.content_item`, `media.asset`, `knowledge.note`…); `now` is the
 * sweep's ISO timestamp. Operates on vault.db only — journal.db pointers are
 * excluded above and never touched.
 *
 * Idempotent: a second call finds no open links and nothing left to delete.
 */
export function cleanupPolyRefs(
  vault: DatabaseSync,
  now: string,
  entityType: string,
  entityId: string
): void {
  for (const entry of POLY_REF_REGISTRY) {
    const match = entry.pairs
      .map((p) => `("${p.typeCol}" = ? AND "${p.idCol}" = ?)`)
      .join(" OR ");
    const matchParams = entry.pairs.flatMap(() => [entityType, entityId]);
    const extra = entry.predicate ? ` AND ${entry.predicate}` : "";
    if (entry.policy === "delete") {
      vault
        .prepare(`DELETE FROM "${entry.table}" WHERE (${match})${extra}`)
        .run(...matchParams);
    } else {
      // end-date
      vault
        .prepare(
          `UPDATE "${entry.table}" SET valid_to = ? WHERE valid_to IS NULL AND (${match})`
        )
        .run(now, ...matchParams);
    }
  }
}
