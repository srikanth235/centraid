// THE SHARE PLANE OF THE DOCS PARITY CORPUS (#1020, wave 4 slot 4b).
//
// Split out of `export-docs-parity.ts` at the repository's 625-line ceiling,
// and it is the natural seam: this is the one part of the corpus **no command
// wrote**. `share.*` has three commands in v0 and all three are
// container-routed writes belonging to the peer plane, which is a later lane
// (census §Cross-lane: "`share_*` is read-only for Docs").
//
// A fixture with no standing answers would make `shared_with` an always-empty
// column, and an always-empty column is exactly what a broken share fold looks
// like — so the rows are written with the vault's own DDL, the way the
// ontology-scenario fixtures do, and the lane's receipt says so.
//
// Every shape the fold has a branch for, and nothing more: a PERSON answer on a
// document, a CIRCLE answer on the grandparent folder, a REVOKED answer the
// read must filter rather than the fold, a delivered pass, a pass still
// syncing, and one inbound subscription whose lineage names a document with no
// folders-scheme tag of its own.

import type { openVaultDb } from "../../packages/vault/src/db.js";
import { PARITY_EPOCH } from "./docs-parity-bundle.js";

/** Write the corpus's share and subscription rows. */
export function seedSharePlane(
  vault: ReturnType<typeof openVaultDb>["vault"],
  ownerPartyId: string
): void {
  const at = PARITY_EPOCH;
  const party = (id: string, name: string) => {
    vault
      .prepare(
        `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
         VALUES (?, 'person', ?, ?, ?)`
      )
      .run(id, name, at, at);
  };
  party("party-ana", "Ana");
  party("party-tom", "Tom");
  vault
    .prepare(
      `INSERT INTO social_circle
         (circle_id, owner_party_id, name, kind, created_at, updated_at)
       VALUES ('circle-family', ?, 'Family', 'family', ?, ?)`
    )
    .run(ownerPartyId, at, at);
  for (const [memberId, partyId] of [
    ["member-ana", "party-ana"],
    ["member-tom", "party-tom"],
  ]) {
    vault
      .prepare(
        `INSERT INTO social_circle_member (member_id, circle_id, party_id, added_at)
         VALUES (?, 'circle-family', ?, ?)`
      )
      .run(memberId, partyId, at);
  }
  // THE GRANDPARENT, not the folder a document is filed in. `Property` holds
  // `Leases`, which holds the deposit receipt — so this answer has to walk two
  // steps to reach it, which is exactly the walk the projection fix restored.
  const folder = vault
    .prepare(
      `SELECT c.concept_id FROM core_concept c
         JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
        WHERE s.uri = 'https://centraid.dev/schemes/folders'
          AND c.pref_label = 'Property'`
    )
    .get() as { concept_id: string } | undefined;
  if (!folder) throw new Error("the script did not create the Property folder");
  const document = vault
    .prepare(
      `SELECT document_id FROM core_document
        WHERE title LIKE 'Tahoe%' ORDER BY document_id LIMIT 1`
    )
    .get() as { document_id: string } | undefined;
  if (!document) throw new Error("the demo seed did not file the packing list");
  const grant = vault.prepare(
    `INSERT INTO share_authority
       (authority_id, principal_kind, principal_id, subject_type, subject_id,
        verb, duration, expires_at, decision, granted_at, granted_by, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, 'standing', NULL, 'granted', ?, ?, NULL)`
  );
  grant.run(
    "grant-folder",
    "circle",
    "circle-family",
    "docs.folder",
    folder.concept_id,
    "view",
    at,
    ownerPartyId
  );
  grant.run(
    "grant-document",
    "person",
    "party-ana",
    "core.document",
    document.document_id,
    "edit",
    at,
    ownerPartyId
  );
  // A REVOKED answer, which the read must filter rather than the fold.
  vault
    .prepare(
      `INSERT INTO share_authority
         (authority_id, principal_kind, principal_id, subject_type, subject_id,
          verb, duration, expires_at, decision, granted_at, granted_by, revoked_at)
       VALUES ('grant-revoked', 'person', 'party-tom', 'core.document', ?, 'view',
               'standing', NULL, 'granted', ?, ?, ?)`
    )
    .run(document.document_id, at, ownerPartyId, at);
  for (const [bindingId, partyId, vaultId] of [
    ["binding-ana", "party-ana", "vault-ana"],
    ["binding-tom", "party-tom", "vault-tom"],
  ]) {
    vault
      .prepare(
        `INSERT INTO share_party_vault_binding
           (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
         VALUES (?, ?, ?, NULL, ?, NULL)`
      )
      .run(bindingId, partyId, vaultId, at);
  }
  // Ana holds it; Tom's vault has never been reached — so `pending_count` is a
  // number the fold computed and not a zero.
  const fulfillment = vault.prepare(
    `INSERT INTO share_fulfillment
       (grant_id, peer_vault_id, state, updated_at, detail, delivered_at)
     VALUES (?, ?, ?, ?, NULL, ?)`
  );
  fulfillment.run("grant-folder", "vault-ana", "delivered", at, at);
  fulfillment.run("grant-folder", "vault-tom", "syncing", at, null);
  fulfillment.run("grant-document", "vault-ana", "delivered", at, at);
  // ONE INBOUND PLACEMENT. Its lineage names a document with no folders-scheme
  // tag of its own, which is the whole reason the origin read is a second door.
  vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, content_uri, sha256, byte_size, language, creator_party_id,
          origin_device_id, deleted_at, purge_at, created_at)
       VALUES ('content-delivered', 'data:text/plain;charset=utf-8,delivered',
               ?, 9, NULL, NULL, NULL, NULL, NULL, ?)`
    )
    .run("de".repeat(32), at);
  vault
    .prepare(
      `INSERT INTO core_document
         (document_id, title, current_content_id, current_revision_id,
          created_at, updated_at, deleted_at, purge_at)
       VALUES ('doc-delivered', 'A document that arrived', 'content-delivered',
               NULL, ?, ?, NULL, NULL)`
    )
    .run(at, at);
  vault
    .prepare(
      `INSERT INTO share_subscription
         (authority_id, audience_vault_id, origin_vault_id, subject_type,
          cursor_epoch, cursor_seq, state, subscribed_at, removed_at, detail, updated_at)
       VALUES ('grant-inbound', 'vault-mine', 'vault-ana', 'core.document',
               NULL, 0, 'subscribed', ?, NULL, NULL, ?)`
    )
    .run(at, at);
  vault
    .prepare(
      `INSERT INTO share_subscription_lineage
         (authority_id, target_type, target_id, origin_item_id,
          origin_row_version, audience_row_version)
       VALUES ('grant-inbound', 'core.document', 'doc-delivered', 'origin-1', 1, 1)`
    )
    .run();
}
