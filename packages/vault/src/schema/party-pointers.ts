// Party pointers the engine cannot see (#290 + #883), extracted from the
// retired `poly-refs.ts` when rung ten (#916) turned every polymorphic
// ENTITY pointer into a real composite foreign key.
//
// These did not become foreign keys with the rest, and the reason is worth
// stating: neither column holds an entity id under a type column beside it.
// `share_authority.principal_id` is polymorphic on `principal_kind`, which
// selects a party, a circle, an engine class or a device, so no single
// REFERENCES clause can express it. So this stays what it always was: the
// enumerated set of party pointers a MERGE must re-point, kept in one place so
// the next one is an entry here rather than a remembered clause.
//
// "A PERSON IS NEVER PURGED" IS RETIRED (#916, owner decision D1). A party
// carries the trash pair now and a purge is the ordinary hard DELETE, so both
// columns below name a row that CAN go. What each does about it:
//
//   - `share_authority.principal_id` is handled in the ENGINE, not here: the
//     BEFORE DELETE trigger on `core_entity` (`core_entity_revoke_on_purge`,
//     schema/entity.ts) revokes every live answer the purged party is the
//     PRINCIPAL of, alongside the ones it is the subject of. A revoked answer
//     is history and is meant to outlive the row it names; a LIVE one that
//     cannot be resolved to a peer vault is a share that silently stops being
//     delivered.
//
// The registry itself STAYS, because MERGE still has no other way to find
// it: a merge DELETES the folded-in party, and a pointer left behind
// names a row that no longer exists with nothing reporting the failure. It is
// the enumerated set of party pointers the engine cannot see, kept in one
// place so the next one is an entry here rather than a remembered clause.

//
// THE PER-COLUMN AUDIT of the foreign keys onto `core_party` lives here too,
// beside the pointers the engine cannot see, because the two answer one
// question together: what happens to everything that names a person when the
// person is purged. It moved out of `entity-catalog.ts` so the registry reads
// as a registry.
//
//   ON DELETE SET NULL — pure ATTRIBUTION, where the row stays true without
//   the person: `core_tag.tagged_by_party_id`,
//   `core_content_item.creator_party_id`,
//   `core_entity_revision.actor_party_id`, `core_event.organizer_party_id`,
//   `media_face_region.party_id` (forgetting a person takes their name off
//   their faces).
//
//   RESTRICT (left as NO ACTION) — everything else, so the purge is REFUSED
//   while the person is still named. Money and authority by rule: every
//   `tally_*` party column, `core_account.*`,
//   `core_transaction.counterparty_party_id`, `access_grant.*`,
//   `access_scope_tombstone.grantee_party_id`, `share_authority.granted_by`,
//   `share_party_vault_binding.party_id`, `outbox_item.recipient_party_id`,
//   `core_vault.self_party_id` (the vault's own person is not purgeable at
//   all). Roster and ownership rows by the same reading — a purge that
//   emptied them would be deleting the member's data to make a delete
//   succeed, so the purge command removes the person's OWN sidecars
//   deliberately (`gateway/duties.ts`) and receipts it.
//
//   Two nullable columns are RESTRICT despite reading as attribution, because
//   a CHECK ties them to another column and a foreign-key SET NULL cannot
//   satisfy it mid-delete: `media_face_region.confirmed_by_party_id` (CHECK:
//   confirmed ⇔ confirmer) and `social_message.sender_party_id` (CHECK: a
//   message has a sender party or a sender handle).
//
//   `social_contact_channel.party_id` keeps its CASCADE: a channel is how to
//   reach THAT person and is meaningless without them.

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

export const PARTY_POINTER_REGISTRY: readonly PartyPointer[] = [
  {
    table: "share_authority",
    column: "principal_id",
    predicate: "principal_kind = 'person'",
    collision: "revoke",
    note: "The authority plane is polymorphic on BOTH sides, so `principal_id` holds a party id, a circle id, an engine class or a device id depending on `principal_kind`. A standing grant left naming the folded-in party cannot be resolved to a peer vault, so a share the owner already granted stops being delivered.",
  },
];
