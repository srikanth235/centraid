// DELETION IS DECLARED BY RELATIONSHIP ROLE (#996, ruling R22).
//
// The vault's delete rules were a per-column audit written four times in
// comments: which foreign keys onto `core_party` were relaxed to SET NULL,
// which hold the line, and why. A comment is not a census. This module is the
// declaration — one row per reference onto the two parents whose deletion is a
// PURGE DECISION (`core_party` and `core_content_item`) — and
// `deletion-roles.test.ts` holds the live schema to it: a reference that
// arrives without a role fails, and a delete rule that changes without its
// role changing fails with it.
//
// The five roles, and what each one MEANS when the parent goes:
//
//   owned-child     the child is a fact about the parent and says nothing
//                   without it. It goes with the parent.
//   derived         rebuildable output computed FROM the parent. It goes, and
//                   nothing is lost that cannot be recomputed.
//   attribution     the child records that the parent did or made something.
//                   The child survives, unattributed.
//   participation   a live relationship involving the parent. The purge is
//                   REFUSED until the member ends the relationship.
//   durable-record  money, consent history, egress. The purge is refused
//                   because the record is somebody else's, or is what happened.
//
// R22's "a parent-owned projection is told apart from rebuildable derived
// data" is the split between `owned-child` and `derived`: both cascade, and
// only one of them can be regenerated.

/** What a child row IS to the parent it references (#996, ruling R22). */
export type DeletionRole =
  | "owned-child"
  | "derived"
  | "attribution"
  | "participation"
  | "durable-record";

export interface ReferenceDeletionRole {
  /** Physical child table. */
  readonly table: string;
  /** The referencing column. */
  readonly column: string;
  /** Physical parent table. */
  readonly parent: string;
  readonly role: DeletionRole;
  /** The live `ON DELETE` rule, which the test compares against the schema. */
  readonly onDelete: "CASCADE" | "SET NULL" | "NO ACTION";
  /**
   * WHO carries the role out. `fk` means the engine does it; `sweep` means the
   * purge path deletes the row itself before the key gets a chance to refuse —
   * which is a real answer, and one a census by referenced table could not see.
   */
  readonly enforcedBy: "fk" | "sweep";
  /** One line. A role with no reason is a label. */
  readonly why: string;
}

/**
 * What each role does when the parent is purged, as the engine sees it. The
 * test asserts the live `ON DELETE` rule against this — so the role is a
 * checked claim, not prose beside the DDL.
 */
export const ROLE_ON_DELETE: Readonly<
  Record<DeletionRole, ReferenceDeletionRole["onDelete"]>
> = {
  "owned-child": "CASCADE",
  derived: "CASCADE",
  attribution: "SET NULL",
  participation: "NO ACTION",
  "durable-record": "NO ACTION",
};

/** The parents whose deletion is a purge decision, and whose whole reference
 *  set is therefore declared here. */
export const ROLED_PARENTS: readonly string[] = [
  "core_party",
  "core_content_item",
];

export const DELETION_ROLES: readonly ReferenceDeletionRole[] = [
  {
    table: "access_agent",
    column: "party_id",
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "An automation's principal row is authority history: the agent's answers and receipts name this party, and history does not lose its subject because the subject was purged.",
  },
  {
    table: "access_device",
    column: "owner_party_id",
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "An enrolment is authority history for the same reason; a device belongs to a person, and the enrolment is the record that it did.",
  },
  {
    table: "core_account",
    column: "institution_party_id",
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "An account names the institution that issued it; money keeps its counterparties.",
  },
  {
    table: "core_account",
    column: "owner_party_id",
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "An account is money, and money refuses the purge of the person it belongs to until the member closes it.",
  },
  {
    table: "core_activity",
    column: "actor_party_id",
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "The activity band is history; who did a thing is part of what happened.",
  },
  {
    table: "core_collection",
    column: "owner_party_id",
    parent: "core_party",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "A collection is the member's own container; purging the person who owns one is refused until the container is dealt with.",
  },
  {
    table: "core_content_item",
    column: "creator_party_id",
    parent: "core_party",
    role: "attribution",
    onDelete: "SET NULL",
    enforcedBy: "fk",
    why: "Who captured the bytes. The bytes outlive the attribution — a photo does not disappear because the photographer was purged.",
  },
  {
    table: "core_entity_revision",
    column: "actor_party_id",
    parent: "core_party",
    role: "attribution",
    onDelete: "SET NULL",
    enforcedBy: "fk",
    why: "Who made this revision. The revision is the history; the name on it is attribution and may go.",
  },
  {
    table: "core_event",
    column: "organizer_party_id",
    parent: "core_party",
    role: "attribution",
    onDelete: "SET NULL",
    enforcedBy: "fk",
    why: "Who convened the event. The event survives unattributed rather than blocking a purge (#916, D1).",
  },
  {
    table: "core_party_identifier",
    column: "party_id",
    parent: "core_party",
    role: "owned-child",
    onDelete: "NO ACTION",
    enforcedBy: "sweep",
    why: "An identifier is a fact ABOUT this person and says nothing without them. The engine does not cascade it: `purgePartyRow` deletes it first, so the enforcement is the sweep's, not the key's.",
  },
  {
    table: "core_tag",
    column: "tagged_by_party_id",
    parent: "core_party",
    role: "attribution",
    onDelete: "SET NULL",
    enforcedBy: "fk",
    why: "Who asserted the tag. An owner-asserted tag that loses its asserter becomes a machine-shaped row, which the preferred-assertion reader already knows how to read.",
  },
  {
    table: "core_transaction",
    column: "counterparty_party_id",
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "A transaction is money: who it was with is part of the record.",
  },
  {
    table: "core_vault",
    column: "self_party_id",
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "The vault's own owner. `purgePartyRow` refuses this party before the key gets a chance to.",
  },
  {
    table: "knowledge_annotation",
    column: "author_party_id",
    parent: "core_party",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "An annotation is the member's own writing on someone's row.",
  },
  {
    table: "knowledge_note",
    column: "author_party_id",
    parent: "core_party",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "A note is the member's own writing, and belongs to whoever wrote it.",
  },
  {
    table: "media_face_region",
    column: "confirmed_by_party_id",
    parent: "core_party",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "Who confirmed the face — a member's own act on a photo.",
  },
  {
    table: "media_face_region",
    column: "party_id",
    parent: "core_party",
    role: "attribution",
    onDelete: "SET NULL",
    enforcedBy: "fk",
    why: "WHO the face is. Forgetting a person leaves the region as an unnamed face rather than deleting the photo's geometry (#711).",
  },
  {
    table: "outbox_item",
    column: "recipient_party_id",
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "An egress record names who it was for; a sent thing does not un-send.",
  },
  {
    table: "people_important_date",
    column: "party_id",
    parent: "core_party",
    role: "owned-child",
    onDelete: "NO ACTION",
    enforcedBy: "sweep",
    why: "A birthday is a fact ABOUT this person. Enforced by the sweep, like the identifier above.",
  },
  {
    table: "people_profile",
    column: "party_id",
    parent: "core_party",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "The People app's decoration on a party; the profile is trashed and purged on its own clock.",
  },
  {
    table: "schedule_attendee",
    column: "party_id",
    parent: "core_party",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "Being on a guest list is a live relationship; the member removes it before the person can go.",
  },
  {
    table: "schedule_calendar",
    column: "owner_party_id",
    parent: "core_party",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "A calendar belongs to whoever owns it, and is not somebody else's to lose.",
  },
  {
    table: "schedule_project",
    column: "owner_party_id",
    parent: "core_party",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "A project belongs to whoever owns it, and is not somebody else's to lose.",
  },
  {
    table: "schedule_recurrence_exception_attendee",
    column: "party_id",
    parent: "core_party",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "A shadow occurrence's guest list, same rule as the series'.",
  },
  {
    table: "schedule_task",
    column: "owner_party_id",
    parent: "core_party",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "A task belongs to whoever owns it, and is not somebody else's to lose.",
  },
  {
    table: "share_authority",
    column: "granted_by",
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "Who granted an authority is consent history, and history keeps its subject.",
  },
  {
    table: "share_party_vault_binding",
    column: "party_id",
    parent: "core_party",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "Which vault a person is bound to — a live relationship the member ends first.",
  },
  {
    table: "social_circle",
    column: "owner_party_id",
    parent: "core_party",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "A circle belongs to whoever owns it, and is not somebody else's to lose.",
  },
  {
    table: "social_circle_member",
    column: "party_id",
    parent: "core_party",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "Membership of a circle is a live relationship the member ends first.",
  },
  {
    table: "social_contact_channel",
    column: "party_id",
    parent: "core_party",
    role: "owned-child",
    onDelete: "CASCADE",
    enforcedBy: "fk",
    why: "A way to REACH someone is a fact about them and goes with them — the one party reference the engine cascades.",
  },
  {
    table: "social_message",
    column: "sender_party_id",
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "Who sent a message is part of what the message IS.",
  },
  {
    table: "social_thread_participant",
    column: "party_id",
    parent: "core_party",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "Being in a thread is a live relationship the member ends first.",
  },
  {
    table: "tally_expense",
    column: "paid_by",
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "Who paid is money: an expense keeps the person who fronted it.",
  },
  {
    table: "tally_expense_line_allocation",
    column: "party_id",
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "A share of a line is money owed, down to the item.",
  },
  {
    table: "tally_expense_payer",
    column: "party_id",
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "What someone put down is money, and money keeps the hand that put it down.",
  },
  {
    table: "tally_expense_split",
    column: "party_id",
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "A share is money owed; it refuses the purge until the member settles or removes it (#916, D1).",
  },
  {
    table: "tally_friend",
    column: "party_id",
    parent: "core_party",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "Being on the Tally friend list is a live relationship the member ends first.",
  },
  {
    table: "tally_nudge",
    column: "party_id",
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "A prepared reminder names who it is about, and was never sent.",
  },
  {
    table: "tally_obligation",
    column: "from_party",
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "A standing IOU is money, and it names both ends.",
  },
  {
    table: "tally_obligation",
    column: "to_party",
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "A standing IOU is money, and it names both ends.",
  },
  {
    table: "tally_recurring_expense",
    column: "paid_by",
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "Who pays a recurring template is money, the same as an expense.",
  },
  {
    table: "tally_recurring_expense_split",
    column: "party_id",
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "A recurring template's share is money owed, the same as an expense's.",
  },
  {
    table: "tally_settlement",
    column: "from_party",
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "A payment is money, and it names who paid and who was paid.",
  },
  {
    table: "tally_settlement",
    column: "to_party",
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "A payment is money, and it names who paid and who was paid.",
  },
  {
    table: "blob_custody_state",
    column: "content_id",
    parent: "core_content_item",
    role: "derived",
    onDelete: "CASCADE",
    enforcedBy: "fk",
    why: "Where the bytes are kept is observation about them, recomputable from the stores.",
  },
  {
    table: "core_attachment",
    column: "content_id",
    parent: "core_content_item",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "An attachment RENTS the bytes; the rental holds them alive.",
  },
  {
    table: "core_collection",
    column: "cover_content_id",
    parent: "core_content_item",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "A collection's cover rents the bytes it shows.",
  },
  {
    table: "core_content_derivative",
    column: "content_id",
    parent: "core_content_item",
    role: "derived",
    onDelete: "CASCADE",
    enforcedBy: "fk",
    why: "A thumbnail, preview or extracted text is recomputable from the original.",
  },
  {
    table: "core_content_representation",
    column: "content_id",
    parent: "core_content_item",
    role: "owned-child",
    onDelete: "CASCADE",
    enforcedBy: "fk",
    why: "An owner's READING of the bytes has no meaning once the bytes are gone (#996, R20(b)).",
  },
  {
    table: "core_content_text",
    column: "content_id",
    parent: "core_content_item",
    role: "derived",
    onDelete: "CASCADE",
    enforcedBy: "fk",
    why: "Decoded body text, recomputable from the bytes.",
  },
  {
    table: "core_document",
    column: "current_content_id",
    parent: "core_content_item",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "sweep",
    why: "A document's head rents the bytes it currently is; the sweep walks past the head deliberately (#352).",
  },
  {
    table: "core_entity_revision",
    column: "content_id",
    parent: "core_content_item",
    role: "attribution",
    onDelete: "SET NULL",
    enforcedBy: "fk",
    why: "A revision names the content that became current at that moment. History survives the bytes it named.",
  },
  {
    table: "core_party",
    column: "avatar_content_id",
    parent: "core_content_item",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "An avatar rents the bytes it is a picture of.",
  },
  {
    table: "knowledge_note",
    column: "body_content_id",
    parent: "core_content_item",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "A note's body rents the bytes it decodes from.",
  },
  {
    table: "media_asset",
    column: "content_id",
    parent: "core_content_item",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "A photo rents the bytes it is a picture of.",
  },
  {
    table: "social_message",
    column: "body_content_id",
    parent: "core_content_item",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    why: "A message body rents the bytes it decodes from.",
  },
];

export function deletionRoleOf(
  table: string,
  column: string
): ReferenceDeletionRole | undefined {
  return DELETION_ROLES.find(
    (entry) => entry.table === table && entry.column === column
  );
}

export function referencesInRole(
  role: DeletionRole
): readonly ReferenceDeletionRole[] {
  return DELETION_ROLES.filter((entry) => entry.role === role);
}

/** The census R22 asks for: how many references stand in each role. */
export function roleCensus(): Readonly<Record<DeletionRole, number>> {
  const census: Record<DeletionRole, number> = {
    "owned-child": 0,
    derived: 0,
    attribution: 0,
    participation: 0,
    "durable-record": 0,
  };
  for (const entry of DELETION_ROLES) census[entry.role] += 1;
  return census;
}
