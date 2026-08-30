import type { DatabaseSync } from "node:sqlite";

import { uuidv7 } from "../ids.js";
import type { Household, SeededPhoto } from "../share/placement-fixture.js";
import { seedPhoto } from "../share/placement-fixture.js";

export const AUDIENCE_VAULT = "vault-family";
export const ORIGIN_VAULT = "vault-priya";

export function addParty(db: DatabaseSync, name: string, now: string): string {
  const partyId = uuidv7();
  db.prepare(
    `INSERT INTO core_party
       (party_id, kind, display_name, sort_name, created_at, updated_at,
        ontology_version)
     VALUES (?, 'person', ?, ?, ?, ?, '1.4')`
  ).run(partyId, name, name, now, now);
  return partyId;
}

export function linkVault(
  db: DatabaseSync,
  partyId: string,
  vaultId: string,
  now: string
): void {
  db.prepare(
    `INSERT INTO share_party_vault_binding
       (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
     VALUES (?, ?, ?, NULL, ?, NULL)`
  ).run(uuidv7(), partyId, vaultId, now);
}

/** An album holding one photograph — the container-grant subject. */
export function seedAlbum(
  home: Household,
  now: string
): { albumId: string; first: SeededPhoto } {
  const first = seedPhoto(home.origin, home.originBoot, "a");
  const albumId = uuidv7();
  home.origin.vault
    .prepare(
      `INSERT INTO core_collection
         (collection_id, owner_party_id, name, cover_content_id,
          parent_collection_id, sort_order, created_at)
       VALUES (?, ?, 'Trip', ?, NULL, 0, ?)`
    )
    .run(albumId, home.originBoot.ownerPartyId, first.contentId, now);
  addToAlbum(home, albumId, first.assetId, 0, now);
  return { albumId, first };
}

export function addToAlbum(
  home: Household,
  albumId: string,
  assetId: string,
  position: number,
  now: string
): void {
  home.origin.vault
    .prepare(
      `INSERT INTO core_collection_entry
         (entry_id, collection_id, target_type, target_id, position, added_at)
       VALUES (?, ?, 'media.asset', ?, ?, ?)`
    )
    .run(uuidv7(), albumId, assetId, position, now);
}

/** Titles of every content item the audience vault holds, in album order. */
export function audienceTitles(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        `SELECT c.title AS title
           FROM core_collection_entry e
           JOIN media_asset a ON a.asset_id = e.target_id
           JOIN core_content_item c ON c.content_id = a.content_id
          ORDER BY e.position`
      )
      .all() as { title: string }[]
  ).map((row) => row.title);
}
