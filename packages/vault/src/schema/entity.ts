// The entity supertype (#916). `core_entity` is the one table every ontology
// entity has a row in, and the one table every polymorphic pointer has a REAL
// composite foreign key into.
//
// WHAT THIS REPLACES. The vault carried thirteen `(type, id)` mechanisms the
// engine knew nothing about. Nothing checked that `target_type='media.asset'`
// named a live asset, and nothing removed the pointer when the asset was
// purged — a hand-kept registry (`POLY_REF_REGISTRY`) and a hand-called sweep
// (`cleanupPolyRefs`) did, at each of the two dozen call sites that remembered
// to call it. The owner's ruling for v0: the vault must not carry
// engine-unenforced pointers. Both the registry-as-mechanism and the sweep are
// gone; `entity-refs.ts` keeps the list as METADATA, because a
// composite foreign key reports `core_entity` as its parent and so cannot
// answer Browse's question ("what points at THIS event?") on its own.
//
// HOW MEMBERSHIP IS KEPT. Not by command code: a BEFORE INSERT trigger on
// every entity table writes the supertype row, so inserting an event IS
// creating the entity, and no writer changes. An AFTER DELETE trigger removes
// it, and the entity table's own `FOREIGN KEY (<pk>) REFERENCES
// core_entity(entity_id) ON DELETE CASCADE` closes the other direction, so
// deleting either row deletes both and the purge duty becomes one DELETE.
// The triggers are GENERATED from the registry on open (`refreshEntityTriggers`)
// for the reason the replica's are: no DDL module should name a primary key by
// hand, and an entity added to the catalog must not need a trigger written for
// it in a second place.
//
// ENTITY OR PROJECTION. `core_entity.entity_id` is a
// PRIMARY KEY and the membership trigger REFUSES an id another kind already
// holds (#916, audit F1), so two entities can never share an id — which settles every
// sidecar keyed by its parent's id by construction, not by taste:
// `media.asset_phash`, `media.face_cluster` and `locker.item_passkey` are
// PROJECTIONS of the row they are keyed by, and so are the composite-keyed
// join rows (`media.memory_member`, `tally.expense_split`,
// `tally.expense_payer`, `tally.expense_line_allocation`) and
// `share.subscription_lineage`, whose key carries its pointer. `locker.item_alias` is a
// projection for a sharper reason: its key is a word the member chose, and
// entity ids are one opaque namespace — an alias called "github" would occupy
// an entity id, and a later entity minted with that id would satisfy the
// alias's foreign key. Each of them keeps its foreign key to its PARENT and
// leaves the target-able set: nothing can tag, link, attach to or share a
// fingerprint, a passkey slot or a split on its own, and its parent's purge
// still takes it through the cascade it already had. They stay REGISTERED
// entities — the export walk and the replica change log both need them — and
// declare `projectionOf` so the registry says which row they belong to.
//
// WHERE THE TWO TABLES LIVE. They are the vault's own machinery, not life
// data: `LOCAL_TABLES` carries them with the reason, and it is a true one —
// `core_entity` is DERIVED (a restore re-creates every row through the same
// BEFORE INSERT triggers, carrying `created_at` across) and `core_entity_kind`
// is re-seeded from the registry on every open. Registering them as a
// machinery BAND was not open: a band's name is the physical prefix, these
// tables are `core_*`, and `core` is an ontology pack — renaming the supertype
// to fit the band would have been the worse trade.

import type { DatabaseSync } from "node:sqlite";

import { ONTOLOGY_PACKS } from "./atlas.js";
import { PRINCIPAL_ENTITY_KINDS } from "./authority.js";
import { VAULT_ENTITIES } from "./tables.js";

const CLOCK = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/**
 * Ontology-pack entities that are ENTITIES rather than projections of another
 * row, as `[logical, physical]`. Derived from the registry, so the kind seed,
 * the backfill, the triggers and the tests all read one list.
 */
export function entitySupertypeMembers(): [string, string][] {
  const members: [string, string][] = [];
  for (const pack of ONTOLOGY_PACKS) {
    const entities = VAULT_ENTITIES[pack];
    if (entities === undefined) continue;
    for (const [table, declaration] of Object.entries(entities)) {
      if (declaration.projectionOf !== undefined) continue;
      members.push([`${pack}.${table}`, `${pack}_${table}`]);
    }
  }
  return members;
}

/**
 * Tables whose creation stamp has a DOMAIN name rather than `created_at`
 * (#916, ruling ONT-08 kept these deliberately — see `lifecycle.test.ts`).
 * The supertype's `created_at` is the row's own beginning, so it reads the
 * table's real creation column wherever it is spelled differently.
 */
export const CREATION_COLUMNS: ReadonlyMap<string, string> = new Map([
  ["core_account", "opened_at"],
  ["core_collection_entry", "added_at"],
  ["core_entity_revision", "recorded_at"],
  ["core_link", "valid_from"],
  ["core_party_identifier", "valid_from"],
  ["core_tag", "tagged_at"],
  // Projections, so no membership trigger reads these — the map is shared with
  // `lifecycle.test.ts`, which holds every ontology table to having a creation
  // stamp under SOME name (#916, ruling ONT-08).
  ["media_asset_phash", "computed_at"],
  ["media_face_cluster", "computed_at"],
  ["media_memory", "computed_at"],
  ["social_circle_member", "added_at"],
  ["social_thread_participant", "joined_at"],
]);

/**
 * The supertype and its kind vocabulary.
 *
 * `core_entity_kind` exists so `entity_type` is a foreign key rather than a
 * free-text column: a typo'd kind is refused by the engine, and the set of
 * kinds is exactly what the registry declares. It is seeded here and re-seeded
 * on every open by `refreshEntityTriggers`, so a build that adds an entity does
 * not need a rung to teach the file its name.
 *
 * `UNIQUE (entity_type, entity_id)` is the composite every pointer references.
 * `entity_id` alone is the PRIMARY KEY, which is what makes the id namespace
 * one namespace — see the header on projections.
 */
export const CORE_ENTITY_DDL = `
CREATE TABLE core_entity_kind (
  kind TEXT NOT NULL PRIMARY KEY
) STRICT;

INSERT INTO core_entity_kind (kind) VALUES
${entitySupertypeMembers()
  .map(([logical]) => `  ('${logical}')`)
  .join(",\n")};

CREATE TABLE core_entity (
  entity_id   TEXT NOT NULL PRIMARY KEY,
  entity_type TEXT NOT NULL REFERENCES core_entity_kind(kind),
  created_at  TEXT NOT NULL,
  UNIQUE (entity_type, entity_id)
) STRICT;
`;

/**
 * PURGE REVOKES, IT DOES NOT ERASE (#916, E2).
 *
 * `share_authority` points at a subject with a `(type, id)` pair and is
 * deliberately NOT a composite foreign key: an answer
 * the member gave is a dated decision, and cascading it away on purge would
 * delete the record that the authority once stood — exactly the evidence a
 * revocation exists to keep. But leaving the rows untouched was the other
 * error: `gateway/duties.ts` carried `revokeAuthorityForPurgedSubject` and a
 * `verifyPurgedSubjectsRevoked` audit that walked every authority row per
 * purge, and a hand-called sweep is a rule only where someone remembered it.
 *
 * The rule is in the engine now. Deleting a supertype row — which is what a
 * purge IS — stamps `revoked_at` and a reason on every LIVE
 * answer and grant about that subject, in the same statement, whether the
 * purge came from a command, a sweep, a cascade or a hand-written DELETE.
 * The rows stay; they are history, and history says when it ended.
 *
 * `share_authority_subject` is the index this reads through; it is partial on
 * `revoked_at IS NULL`, which is exactly the set the trigger touches.
 */
export const ENTITY_PURGE_REVOKE_DDL = `
CREATE TRIGGER core_entity_revoke_on_purge
BEFORE DELETE ON core_entity
BEGIN
  UPDATE share_authority
     SET revoked_at = ${CLOCK}, revoked_reason = 'subject-purged'
   WHERE subject_type = OLD.entity_type
     AND subject_id = OLD.entity_id
     AND revoked_at IS NULL;
  -- The PRINCIPAL side of the same rule (#916, D1). \`principal_id\` is
  -- polymorphic on \`principal_kind\` and carries no foreign key, so a purged
  -- principal would leave live answers naming a row that is not there — a share
  -- the member granted that can no longer be resolved to a peer vault, failing
  -- silently. See schema/party-pointers.ts.
  --
  -- EVERY principal kind that is a ROW, not just 'person' (#916, audit F3):
  -- the clause is generated from \`PRINCIPAL_ENTITY_KINDS\`, so a circle
  -- deleted by \`tally.delete_group\` or by share/removal.ts ends the answers
  -- its members hold through it, and a fifth kind cannot be added to the
  -- table's CHECK without landing here too.
  UPDATE share_authority
     SET revoked_at = ${CLOCK}, revoked_reason = 'principal-purged'
   WHERE principal_id = OLD.entity_id
     AND revoked_at IS NULL
     AND principal_kind = CASE OLD.entity_type
${[...PRINCIPAL_ENTITY_KINDS]
  .map(([kind, entityType]) => `           WHEN '${entityType}' THEN '${kind}'`)
  .join("\n")}
         END;
END;
`;

/**
 * Seed the kind vocabulary and (re)generate the membership triggers, from the
 * registry, on every open — the entity half of what `refreshReplicaTriggers`
 * does for replication, and for the same reason: a catalog change must reach
 * the file without a rung, and no DDL module should name a primary key.
 *
 * `<t>_entity_insert` is a BEFORE INSERT trigger, which is what makes the
 * entity table's own foreign key satisfiable: the supertype row is written
 * before the row that references it exists. `<t>_entity_delete` is AFTER
 * DELETE, so a hard delete of the entity row purges its pointers through the
 * cascade; the two directions converge, and deleting either row leaves neither.
 *
 * THE ID NAMESPACE IS ENFORCED, NOT ASSUMED (#916, audit F1). The membership
 * INSERT is `OR IGNORE` because it is load-bearing: SQLite fires BEFORE INSERT
 * triggers ahead of conflict resolution, so every upsert on an entity table
 * (`ON CONFLICT (party_id) DO UPDATE`, and the dozens like it in
 * `share/commons-bootstrap.ts`) re-derives a supertype row that is already
 * there, as does a restore replaying the same row. But `OR IGNORE` on its own
 * ALSO swallowed the case it must not: an id already held by a DIFFERENT kind
 * minted no supertype row for the new entity, whose own
 * `FOREIGN KEY (<pk>) REFERENCES core_entity(entity_id)` was then satisfied by
 * the other kind's row — and purging that unrelated entity cascaded the
 * intruder away. So the guard is separated from the write: the `RAISE(ABORT)`
 * refuses a CROSS-KIND collision outright, and `OR IGNORE` keeps absorbing the
 * same-kind re-derivation it exists for. `share/sql.ts:freeId` is the other
 * half — it asks `core_entity`, not just the destination table, before reusing
 * a peer-supplied id.
 */
export function refreshEntityTriggers(db: DatabaseSync): void {
  const members = entitySupertypeMembers();
  const kinds = db
    .prepare("SELECT count(*) AS n FROM core_entity_kind")
    .get() as {
    n: number;
  };
  const triggers = db
    .prepare(
      `SELECT count(*) AS n FROM sqlite_master
        WHERE type = 'trigger' AND name LIKE '%\\_entity\\_insert' ESCAPE '\\'`
    )
    .get() as { n: number };
  if (kinds.n === members.length && triggers.n === members.length) return;

  const insertKind = db.prepare(
    "INSERT OR IGNORE INTO core_entity_kind (kind) VALUES (?)"
  );
  for (const [logical] of members) insertKind.run(logical);

  for (const [logical, physical] of members) {
    const cols = db
      .prepare(`PRAGMA table_info(${JSON.stringify(physical)})`)
      .all() as { name: string; pk: number }[];
    const pk = cols.filter((c) => c.pk > 0).map((c) => c.name);
    if (pk.length !== 1)
      throw new Error(
        `entity registry: ${logical} is an entity with a composite primary key — declare it a projection or give it its own id (#916)`
      );
    const names = new Set(cols.map((c) => c.name));
    const domain = CREATION_COLUMNS.get(physical);
    const created = names.has("created_at")
      ? "NEW.created_at"
      : domain !== undefined && names.has(domain)
        ? `NEW.${domain}`
        : CLOCK;
    db.exec(`
CREATE TRIGGER IF NOT EXISTS ${physical}_entity_insert
BEFORE INSERT ON ${physical}
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: ${physical} (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.${pk[0]} AND entity_type <> '${logical}');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.${pk[0]}, '${logical}', COALESCE(${created}, ${CLOCK}));
END;
CREATE TRIGGER IF NOT EXISTS ${physical}_entity_delete
AFTER DELETE ON ${physical}
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.${pk[0]};
END;`);
  }
}
