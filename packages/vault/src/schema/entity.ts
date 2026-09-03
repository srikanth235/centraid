import type { DatabaseSync } from "node:sqlite";

import { ONTOLOGY_PACKS } from "./atlas.js";
import { PRINCIPAL_ENTITY_KINDS } from "./authority.js";
import { VAULT_ENTITIES } from "./tables.js";

const CLOCK = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

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

export const CREATION_COLUMNS: ReadonlyMap<string, string> = new Map([
  ["core_account", "opened_at"],
  ["core_collection_entry", "added_at"],
  ["core_entity_revision", "recorded_at"],
  ["core_link", "valid_from"],
  ["core_party_identifier", "valid_from"],
  ["core_tag", "tagged_at"],
  ["media_asset_phash", "computed_at"],
  ["media_face_cluster", "computed_at"],
  ["media_memory", "computed_at"],
  ["social_circle_member", "added_at"],
  ["social_thread_participant", "joined_at"],
]);

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

export const ENTITY_PURGE_REVOKE_DDL = `
CREATE TRIGGER core_entity_revoke_on_purge
BEFORE DELETE ON core_entity
BEGIN
  UPDATE share_authority
     SET revoked_at = ${CLOCK}, revoked_reason = 'subject-purged'
   WHERE subject_type = OLD.entity_type
     AND subject_id = OLD.entity_id
     AND revoked_at IS NULL;
  UPDATE share_circle_grant
     SET revoked_at = ${CLOCK}, revoked_reason = 'container-purged'
   WHERE container_type = OLD.entity_type
     AND container_id = OLD.entity_id
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
