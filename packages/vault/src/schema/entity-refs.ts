export interface EntityRefPair {
  typeCol: string;
  idCol: string;
}

export interface EntityPointer {
  table: string;
  pairs: readonly EntityRefPair[];
  note: string;
}

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
    table: "core_share_origin",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    note: "Share-by-placement provenance (#599 decision 11): where a PROJECTED row came from. Its (type, id) IS its primary key, so the provenance row cannot outlive the row it attributes.",
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
    table: "share_commons_lineage",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    note: "Commons projection lineage names a RESIDENT row in this vault. Purge it and there is nothing left for revoke to scrub, while a retained marker could make a later row that reuses the id look shared.",
  },
  {
    table: "share_commons_retained",
    pairs: [{ typeCol: "target_type", idCol: "target_id" }],
    note: "Save-to-my-vault retention protects the current resident row from a later Commons revoke; if the owner purges that row its marker must leave too, or an id reused by a future row inherits retention.",
  },
];

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
    "share_circle_grant",
    "REVOKED BY TRIGGER, RETAINED AS HISTORY (#916, E2), for the same reason as `share_authority`: the grant and its receipts must survive container removal for restore, reconciliation and audit, but they must not survive it STILL LIVE. `core_entity_revoke_on_purge` stamps `revoked_at` and `revoked_reason = 'container-purged'` as the supertype row goes.",
  ],
  [
    "share_commons_invitation",
    "Consent metadata may name a container that is not present in the receiving vault before acceptance, and it remains the historical accept/refuse record after unshare. The invitation lifecycle, not target-row purge, owns its status and retention.",
  ],
  [
    "share_commons_supersession",
    "Recovery lineage, not a live pointer: `container_type` names the KIND of the two containers a steward handover moved between, and its ids are `old_container_id`/`new_container_id` — grant containers, not canonical rows.",
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
