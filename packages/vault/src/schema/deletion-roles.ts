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

/**
 * The census, DECLARED BY GROUP (#996, ruling R22).
 *
 * A role is a property of the RELATIONSHIP, not of each row that stands in it,
 * so the parent, the role, its delete rule and who carries it out are stated
 * once per group and the references under them carry only what is their own:
 * which key it is, and the one line that says why. Written per reference, the
 * same five lines were repeated fifty-six times, and a group whose rule
 * changed had to be found by reading every one of them.
 */
interface DeletionRoleGroup {
  readonly parent: string;
  readonly role: DeletionRole;
  readonly onDelete: ReferenceDeletionRole["onDelete"];
  readonly enforcedBy: ReferenceDeletionRole["enforcedBy"];
  /** `table.column` of the referencing key, to the reason it stands here. */
  readonly references: Readonly<Record<string, string>>;
}

const DELETION_ROLE_GROUPS: readonly DeletionRoleGroup[] = [
  {
    parent: "core_party",
    role: "durable-record",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    references: {
      "access_agent.party_id":
        "An automation's principal row is authority history: the agent's answers and receipts name this party, and history does not lose its subject because the subject was purged.",
      "access_device.owner_party_id":
        "An enrolment is authority history for the same reason; a device belongs to a person, and the enrolment is the record that it did.",
      "core_account.institution_party_id":
        "An account names the institution that issued it; money keeps its counterparties.",
      "core_account.owner_party_id":
        "An account is money, and money refuses the purge of the person it belongs to until the member closes it.",
      "core_activity.actor_party_id":
        "The activity band is history; who did a thing is part of what happened.",
      "core_transaction.counterparty_party_id":
        "A transaction is money: who it was with is part of the record.",
      "core_vault.self_party_id":
        "The vault's own owner. `purgePartyRow` refuses this party before the key gets a chance to.",
      "outbox_item.recipient_party_id":
        "An egress record names who it was for; a sent thing does not un-send.",
      "share_authority.granted_by":
        "Who granted an authority is consent history, and history keeps its subject.",
      "social_message.sender_party_id":
        "Who sent a message is part of what the message IS.",
      "tally_expense.paid_by":
        "Who paid is money: an expense keeps the person who fronted it.",
      "tally_expense_line_allocation.party_id":
        "A share of a line is money owed, down to the item.",
      "tally_expense_payer.party_id":
        "What someone put down is money, and money keeps the hand that put it down.",
      "tally_expense_split.party_id":
        "A share is money owed; it refuses the purge until the member settles or removes it (#916, D1).",
      "tally_nudge.party_id":
        "A prepared reminder names who it is about, and was never sent.",
      "tally_obligation.from_party":
        "A standing IOU is money, and it names both ends.",
      "tally_obligation.to_party":
        "A standing IOU is money, and it names both ends.",
      "tally_recurring_expense.paid_by":
        "Who pays a recurring template is money, the same as an expense.",
      "tally_recurring_expense_split.party_id":
        "A recurring template's share is money owed, the same as an expense's.",
      "tally_settlement.from_party":
        "A payment is money, and it names who paid and who was paid.",
      "tally_settlement.to_party":
        "A payment is money, and it names who paid and who was paid.",
    },
  },
  {
    parent: "core_party",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    references: {
      "core_collection.owner_party_id":
        "A collection is the member's own container; purging the person who owns one is refused until the container is dealt with.",
      "knowledge_annotation.author_party_id":
        "An annotation is the member's own writing on someone's row.",
      "knowledge_note.author_party_id":
        "A note is the member's own writing, and belongs to whoever wrote it.",
      "media_face_region.confirmed_by_party_id":
        "Who confirmed the face — a member's own act on a photo.",
      "people_profile.party_id":
        "The People app's decoration on a party; the profile is trashed and purged on its own clock.",
      "schedule_attendee.party_id":
        "Being on a guest list is a live relationship; the member removes it before the person can go.",
      "schedule_calendar.owner_party_id":
        "A calendar belongs to whoever owns it, and is not somebody else's to lose.",
      "schedule_project.owner_party_id":
        "A project belongs to whoever owns it, and is not somebody else's to lose.",
      "schedule_recurrence_exception_attendee.party_id":
        "A shadow occurrence's guest list, same rule as the series'.",
      "schedule_task.owner_party_id":
        "A task belongs to whoever owns it, and is not somebody else's to lose.",
      "share_party_vault_binding.party_id":
        "Which vault a person is bound to — a live relationship the member ends first.",
      "social_circle.owner_party_id":
        "A circle belongs to whoever owns it, and is not somebody else's to lose.",
      "social_circle_member.party_id":
        "Membership of a circle is a live relationship the member ends first.",
      "social_thread_participant.party_id":
        "Being in a thread is a live relationship the member ends first.",
      "tally_friend.party_id":
        "Being on the Tally friend list is a live relationship the member ends first.",
    },
  },
  {
    parent: "core_party",
    role: "attribution",
    onDelete: "SET NULL",
    enforcedBy: "fk",
    references: {
      "core_content_item.creator_party_id":
        "Who captured the bytes. The bytes outlive the attribution — a photo does not disappear because the photographer was purged.",
      "core_entity_revision.actor_party_id":
        "Who made this revision. The revision is the history; the name on it is attribution and may go.",
      "core_event.organizer_party_id":
        "Who convened the event. The event survives unattributed rather than blocking a purge (#916, D1).",
      "core_tag.tagged_by_party_id":
        "Who asserted the tag. An owner-asserted tag that loses its asserter becomes a machine-shaped row, which the preferred-assertion reader already knows how to read.",
      "media_face_region.party_id":
        "WHO the face is. Forgetting a person leaves the region as an unnamed face rather than deleting the photo's geometry (#711).",
    },
  },
  {
    parent: "core_party",
    role: "owned-child",
    onDelete: "NO ACTION",
    enforcedBy: "sweep",
    references: {
      "core_party_identifier.party_id":
        "An identifier is a fact ABOUT this person and says nothing without them. The engine does not cascade it: `purgePartyRow` deletes it first, so the enforcement is the sweep's, not the key's.",
      "people_important_date.party_id":
        "A birthday is a fact ABOUT this person. Enforced by the sweep, like the identifier above.",
    },
  },
  {
    parent: "core_party",
    role: "owned-child",
    onDelete: "CASCADE",
    enforcedBy: "fk",
    references: {
      "social_contact_channel.party_id":
        "A way to REACH someone is a fact about them and goes with them — the one party reference the engine cascades.",
    },
  },
  {
    parent: "core_content_item",
    role: "derived",
    onDelete: "CASCADE",
    enforcedBy: "fk",
    references: {
      "blob_custody_state.content_id":
        "Where the bytes are kept is observation about them, recomputable from the stores.",
      "core_content_derivative.content_id":
        "A thumbnail, preview or extracted text is recomputable from the original.",
      "core_content_text.content_id":
        "Decoded body text, recomputable from the bytes.",
    },
  },
  {
    parent: "core_content_item",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "fk",
    references: {
      "core_attachment.content_id":
        "An attachment RENTS the bytes; the rental holds them alive.",
      "core_collection.cover_content_id":
        "A collection's cover rents the bytes it shows.",
      "core_party.avatar_content_id":
        "An avatar rents the bytes it is a picture of.",
      "knowledge_note.body_content_id":
        "A note's body rents the bytes it decodes from.",
      "media_asset.content_id": "A photo rents the bytes it is a picture of.",
      "social_message.body_content_id":
        "A message body rents the bytes it decodes from.",
    },
  },
  {
    parent: "core_content_item",
    role: "owned-child",
    onDelete: "CASCADE",
    enforcedBy: "fk",
    references: {
      "core_content_representation.content_id":
        "An owner's READING of the bytes has no meaning once the bytes are gone (#996, R20(b)).",
    },
  },
  {
    parent: "core_content_item",
    role: "participation",
    onDelete: "NO ACTION",
    enforcedBy: "sweep",
    references: {
      "core_document.current_content_id":
        "A document's head rents the bytes it currently is; the sweep walks past the head deliberately (#352).",
    },
  },
  {
    parent: "core_content_item",
    role: "attribution",
    onDelete: "SET NULL",
    enforcedBy: "fk",
    references: {
      "core_entity_revision.content_id":
        "A revision names the content that became current at that moment. History survives the bytes it named.",
    },
  },
];

export const DELETION_ROLES: readonly ReferenceDeletionRole[] =
  DELETION_ROLE_GROUPS.flatMap((group) =>
    Object.entries(group.references).map(([reference, why]) => {
      const [table, column] = reference.split(".");
      return {
        table: table!,
        column: column!,
        parent: group.parent,
        role: group.role,
        onDelete: group.onDelete,
        enforcedBy: group.enforcedBy,
        why,
      };
    })
  );

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
