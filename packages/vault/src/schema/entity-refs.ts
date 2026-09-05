// Rung ten (#916): which tables POINT at an entity, and which look like they
// do and do not.
//
// Until this rung the vault carried thirteen `(type, id)` pairs the engine
// knew nothing about, swept by hand on purge through `POLY_REF_REGISTRY` and
// `cleanupPolyRefs`. The owner's ruling for v0 is that a pointer is a
// REFERENCE or it is not a pointer: every pair below is now a composite
// FOREIGN KEY into `core_entity(entity_type, entity_id)` with `ON DELETE
// CASCADE`, so the engine both CHECKS the target on write and REMOVES the
// pointer when the target is purged. The type column stays — queries and
// indexes read it, and it is now engine-checked rather than trusted.
//
// This module is therefore no longer a cleanup registry. It is METADATA: the
// list of pointers, which Browse still needs (a composite FK reports
// `core_entity` as its parent, so `PRAGMA foreign_key_list` cannot answer
// "what points at THIS event") and which `entity-refs.test.ts` scans the live
// DDL against, so a fourteenth mechanism cannot arrive unaccounted for.
//
// ONE POLICY, replacing two. `POLY_REF_POLICY` had `end-date` for `core_link`
// (a relation onto a purged row ends rather than dangles, #272) and `delete`
// for everything else (#274). A cascade cannot end-date, and the choice is
// settled the other way: THIS RUNG SUPERSEDES #272 for `core_link`. A link
// must not outlive an endpoint that no longer exists — an end-dated edge onto
// a purged row still names it, still shows in history, and still lets an id
// reused later inherit a relation nobody drew. The relation is deleted with
// its endpoint. (docs/decisions.md records the supersession.)

/** Column pair holding a logical entity name and that entity's row id. */
export interface EntityRefPair {
  /** Column holding the logical entity name, e.g. `target_type`. */
  typeCol: string;
  /** Column holding the target row's id, e.g. `target_id`. */
  idCol: string;
}

export interface EntityPointer {
  /** Physical vault.db table name. */
  table: string;
  /**
   * The `(type, id)` pair(s) carrying the composite foreign key. `core_link`
   * is the only table with two — its from- and to- endpoints; every other
   * mechanism carries exactly one.
   */
  pairs: readonly EntityRefPair[];
  note: string;
}

/**
 * Every composite foreign key into the entity supertype, one entry per table.
 * The rung builds the FKs from this list, `entity-refs.test.ts` asserts the
 * live DDL matches it exactly, and Browse walks it to count the dependents an
 * engine FK cannot name.
 *
 * Ordered core → domain → machinery for reading.
 */
export const ENTITY_POINTERS: readonly EntityPointer[] = [
  {
    table: "core_link",
    pairs: [
      { typeCol: "from_type", idCol: "from_id" },
      { typeCol: "to_type", idCol: "to_id" },
    ],
    note: "A relation between two entities. Both ends are real references now; purging either end deletes the edge (this rung supersedes #272's end-date rule — see the header).",
  },
  {
    table: "core_tag",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    note: "Classification says nothing once the row is gone (#274).",
  },
  {
    table: "core_collection_entry",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    note: "Curation membership says nothing once the row is gone (#274).",
  },
  {
    table: "core_attachment",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    note: "An attachment ON a purged target dangles (#441 A1). It was swept only for notes before this registry existed; now the engine does it for every target.",
  },
  {
    table: "knowledge_annotation",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    note: "A margin note on a purged target dangles (#441 A1) — previously swept only for notes, now for photos, documents and transactions too.",
  },
  {
    table: "schedule_recurrence_exception",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    note: "An occurrence exception has no meaning after its event or recurring-expense template is purged (#630 W4). It keeps its own CHECK on the two allowed types IN ADDITION to the foreign key: the FK says the target exists, the CHECK says only these two kinds may be excepted.",
  },
  {
    table: "enrich_embedding",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    note: "Never cleaned before this registry (#441 A1): an orphan vector lets deleted content resurface in vector search.",
  },
  {
    table: "enrich_derivation",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    note: "A stamp claiming a purged target's variant is derived and current (#724 W2); an id reused by a later row would inherit it and the sweep would skip work never done.",
  },
  {
    table: "enrich_request",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    note: "Open enrichment queued for a purged entity would send an enricher after a dead row. `target_id` is NULLABLE — a search-miss request names a KIND and no row, and a composite FK with a NULL column is satisfied by definition, which is exactly the right reading. The hand sweep scoped itself to open rows; the cascade takes drained ones too, and a drained request for a row that no longer exists is inert history nothing reads.",
  },
  {
    table: "outbox_item",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    note: "The row the queued artifact is ABOUT. Read as an audit value until #916 (E1) — but an item still PENDING when its subject is purged would drain afterwards and publish about a row the member deleted, so the queue is emptied of it instead. `target_id` is NULLABLE (an outbound write with no canonical subject), and a composite key with a NULL column is satisfied by definition.",
  },
  {
    table: "sync_external_entity",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    note: "Never cleaned before this registry (#441 A1): a stale map row makes the next import believe a purged entity is still known, so re-import SILENTLY skips it.",
  },
  {
    table: "share_subscription_lineage",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    note: "A subscription's lineage names a RESIDENT row in this vault (#929). Purge it and there is nothing left for a revoke to scrub, while a stale claim would make a later row that reuses the id look shared.",
  },
];

/**
 * Tables carrying a `(type, id)`-shaped pair that is NOT a reference, each
 * with the reason (#916). Membership here accounts for the pair in
 * `entity-refs.test.ts`, so an exclusion is a documented decision rather than
 * an oversight. Keyed by physical table name.
 *
 * THE TEST APPLIED: if the pointed-at row may legitimately be gone while this
 * row stays meaningful, the pair is an AUDIT VALUE — a record of what was
 * named at the time — and a foreign key would delete the very evidence the
 * row exists to keep. Everything else is a reference and is in
 * `ENTITY_POINTERS` above.
 *
 * `sync_import_row`, `replica_change` and `enrich_policy_rule` are listed for
 * completeness even though the DDL scan does not match them — `sync_import_row`
 * carries `entity_type` with no `entity_id` sibling, `replica_change` uses
 * `entity`/`row_id`, `enrich_policy_rule` uses `scope_type`/`scope_ref` — so a
 * future rename into the canonical shape lands in the scan and is forced to a
 * decision rather than inheriting silence.
 */
export const ENTITY_REF_EXCLUSIONS: ReadonlyMap<string, string> = new Map([
  [
    "core_entity",
    "The supertype itself. `(entity_type, entity_id)` is the composite every pointer below REFERENCES; a table cannot be a foreign key into itself, and the scan cannot tell the target apart from the pointers by shape alone.",
  ],
  [
    "access_seed_row",
    "The demo registry marks any row an APP wrote, and that set is wider than the entity supertype: `atlas.insert_row` reaches an app's own ext-band tables (`ext.<appId>.<table>`, which are the app's and never registered entities) and the locker commands report projections such as `locker.item_passkey`, so `target_type` can name something that has no supertype row and never will. A pointer whose type column may name a non-entity cannot carry the composite key. It keeps its own lifecycle instead: `gateway/demo.ts` deletes each marker as it purges the row it names, and demo mode is its only reader (#916; it left POLY_REF_REGISTRY here rather than becoming a foreign key).",
  ],
  [
    "core_entity_revision",
    "Append-only P5 lifecycle history (#630). `entity_type`/`entity_id` names the row whose pre-mutation snapshot is retained for undo, audit and export; surviving the purge of that row is the whole point of keeping it.",
  ],
  [
    "share_authority",
    "REVOKED BY TRIGGER, RETAINED AS HISTORY (#916, E2). A standing answer states what the owner decided about a subject; cascading it away on purge would delete the record that the authority once stood, which is the evidence a revocation exists to keep. So it is not a foreign key — but it is not a hand-swept pointer either: the BEFORE DELETE trigger on `core_entity` (`core_entity_revoke_on_purge`, schema/entity.ts) stamps `revoked_at` and `revoked_reason = 'subject-purged'` on every live answer about the subject, in the same statement as the purge. The plane's own subjects are not always rows — `enrich.scope` names a cascade level. The PRINCIPAL pair is a different question, accounted for in `party-pointers.ts`.",
  ],
  [
    "access_provenance",
    "THE AUDIT OUTLIVES ITS SUBJECT (#916). The band is in the same file now, so a composite key WOULD be expressible — and is deliberately not taken: the provenance trail of a purged row is exactly what must survive it, and a cascade would delete the record that the row ever existed.",
  ],
  [
    "access_receipt",
    "THE AUDIT OUTLIVES ITS SUBJECT (#916). `object_type`/`object_id` is the receipted subject; the receipt chain is hashed and never rewritten, so the pointer is a VALUE.",
  ],
  [
    "agent_evidence",
    "THE AUDIT OUTLIVES ITS SUBJECT (#916). Evidence citing a since-purged entity is a historical claim about a past invocation, not a live pointer.",
  ],
  [
    "sync_import_row",
    "Immutable import history — the row-by-row ledger of what a connector proposed. `entity_type` records the kind that was imported; the row is never mutated after its batch resolves.",
  ],
  [
    "replica_change",
    "Replication machinery with its own epoch/floor lifecycle (replica/change-log.ts). It records PAST mutations and is trimmed by epoch, not by target liveness.",
  ],
  [
    "enrich_policy_rule",
    "Not a pointer at all (#807): `scope_type` names a CASCADE LEVEL (vault|domain|collection|item) and `scope_ref` is '' or a domain name at the two upper levels. A rule whose collection was purged matches nothing the resolver walks, so it is inert rather than dangling — and sweeping it would delete an owner decision on a purge the owner may be undoing.",
  ],
]);
