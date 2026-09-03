// The audience-side projection of the two household items whose closure is a
// sub-graph rather than a document: a Locker item and a Tally group (issue
// #726 split of household.ts).
//
// Both run inside the ONE audience-vault transaction `projectShareClosure`
// opens; neither touches the origin.

import type { DatabaseSync } from "node:sqlite";

import { VaultShareError } from "../errors.js";
import {
  sealAad,
  sealedColumnsOf,
  sealValue,
  stampSealKeyFingerprint,
  unsealValue,
} from "../schema/sealed.js";
import type { WireRow, WireTallyGroup } from "./closure.js";
import { freeId, insert, one } from "./sql.js";

/** What a projected row became in the audience vault. */
export interface ProjectedRow {
  itemId: string;
  deduped: boolean;
}

/**
 * Re-seal a Locker item under the AUDIENCE vault's DEK. The AAD binds the row
 * id, so a re-keyed row must be re-sealed under its new id — which needs both
 * keys, and so works only in the local composition.
 */
export function projectLockerItem(
  audience: DatabaseSync,
  originRow: WireRow,
  keys: { origin: Buffer; audience: Buffer }
): ProjectedRow {
  const originId = String(originRow.item_id);
  const existing = one(audience, "locker_item", "item_id", originId);
  if (existing) return { itemId: originId, deduped: true };
  const itemId = freeId(audience, "locker_item", "item_id", originId);
  const projected: Record<string, unknown> = {
    ...originRow,
    item_id: itemId,
    connection_id: null,
  };
  for (const column of sealedColumnsOf("locker.item")) {
    const value = originRow[column];
    if (typeof value !== "string") continue;
    const plaintext = unsealValue(
      keys.origin,
      sealAad("locker_item", column, originId),
      value
    );
    projected[column] = sealValue(
      keys.audience,
      sealAad("locker_item", column, itemId),
      plaintext
    );
  }
  insert(audience, "locker_item", projected);
  stampSealKeyFingerprint(audience, keys.audience);
  return { itemId, deduped: false };
}

/**
 * `audienceContentId` maps an origin receipt's content item onto the row the
 * shared content pool already projected; a receipt whose content never crossed
 * is skipped rather than inserted against a dangling FK.
 */
export function projectTallyGroup(
  audience: DatabaseSync,
  closure: WireTallyGroup,
  audienceContentId: (originContentId: string) => string | undefined
): ProjectedRow {
  const originId = String(closure.group.group_id);
  if (one(audience, "tally_group", "group_id", originId))
    return { itemId: originId, deduped: true };
  const partyIds = projectParties(audience, closure.parties);
  const circleId = projectCircle(audience, closure);
  for (const member of closure.members) {
    const partyId = partyIds.get(String(member.party_id));
    if (!partyId) continue;
    insert(audience, "social_circle_member", {
      ...member,
      member_id: freeId(
        audience,
        "social_circle_member",
        "member_id",
        String(member.member_id)
      ),
      circle_id: circleId,
      party_id: partyId,
    });
  }
  const groupId = freeId(audience, "tally_group", "group_id", originId);
  insert(audience, "tally_group", {
    ...closure.group,
    group_id: groupId,
    circle_id: circleId,
  });
  projectLedger(audience, closure, groupId, partyIds);
  projectReceipts(audience, closure, partyIds, audienceContentId);
  return { itemId: groupId, deduped: false };
}

/**
 * Adopted where the audience knows the id. The avatar is dropped: it names a
 * content item that was never in this closure.
 */
function projectParties(
  audience: DatabaseSync,
  parties: WireRow[]
): Map<string, string> {
  const partyIds = new Map<string, string>();
  for (const party of parties) {
    const originPartyId = String(party.party_id);
    const existing = one(audience, "core_party", "party_id", originPartyId);
    const partyId = existing
      ? originPartyId
      : freeId(audience, "core_party", "party_id", originPartyId);
    partyIds.set(originPartyId, partyId);
    if (!existing)
      insert(audience, "core_party", {
        ...party,
        party_id: partyId,
        avatar_content_id: null,
      });
  }
  return partyIds;
}

/** Re-owned by the audience and named without collision. */
function projectCircle(
  audience: DatabaseSync,
  closure: WireTallyGroup
): string {
  const owner = ownerPartyId(audience);
  const circleId = freeId(
    audience,
    "social_circle",
    "circle_id",
    String(closure.circle.circle_id)
  );
  const preferred = String(closure.circle.name);
  const held = audience
    .prepare(
      "SELECT 1 FROM social_circle WHERE owner_party_id = ? AND name = ?"
    )
    .get(owner, preferred);
  insert(audience, "social_circle", {
    ...closure.circle,
    circle_id: circleId,
    owner_party_id: owner,
    name: held ? `${preferred} (shared)` : preferred,
  });
  return circleId;
}

/** Expenses, splits, settlements and the recurring templates behind them. */
function projectLedger(
  audience: DatabaseSync,
  closure: WireTallyGroup,
  groupId: string,
  partyIds: Map<string, string>
): void {
  for (const expense of closure.expenses)
    insert(audience, "tally_expense", {
      ...expense,
      group_id: groupId,
      paid_by: mappedParty(partyIds, expense.paid_by),
      txn_id: null,
    });
  for (const split of closure.splits)
    insert(audience, "tally_expense_split", {
      ...split,
      party_id: mappedParty(partyIds, split.party_id),
    });
  for (const payer of closure.payers)
    insert(audience, "tally_expense_payer", {
      ...payer,
      party_id: mappedParty(partyIds, payer.party_id),
    });
  for (const settlement of closure.settlements)
    insert(audience, "tally_settlement", {
      ...settlement,
      group_id: groupId,
      from_party: mappedParty(partyIds, settlement.from_party),
      to_party: mappedParty(partyIds, settlement.to_party),
      txn_id: null,
    });
  for (const recurring of closure.recurring)
    insert(audience, "tally_recurring_expense", {
      ...recurring,
      group_id: groupId,
      paid_by: mappedParty(partyIds, recurring.paid_by),
    });
  for (const split of closure.recurringSplits)
    insert(audience, "tally_recurring_expense_split", {
      ...split,
      party_id: mappedParty(partyIds, split.party_id),
    });
  for (const exception of closure.exceptions)
    insert(audience, "schedule_recurrence_exception", exception);
}

/** Receipts and their OCR structure, so the audience ledger reconciles. */
function projectReceipts(
  audience: DatabaseSync,
  closure: WireTallyGroup,
  partyIds: Map<string, string>,
  audienceContentId: (originContentId: string) => string | undefined
): void {
  // A receipt crosses as the attachment it is (#883).
  const crossed = new Set<string>();
  for (const receipt of closure.receipts) {
    const contentId = audienceContentId(String(receipt.content_id));
    if (!contentId) continue;
    insert(audience, "core_attachment", { ...receipt, content_id: contentId });
    crossed.add(String(receipt.attachment_id));
  }
  // A line whose receipt did NOT cross keeps its typed amounts and loses only
  // the photo pointer, which would otherwise name an attachment this vault
  // does not hold.
  for (const line of closure.lineItems)
    insert(audience, "tally_expense_line_item", {
      ...line,
      receipt_id:
        line.receipt_id != null && crossed.has(String(line.receipt_id))
          ? line.receipt_id
          : null,
    });
  for (const allocation of closure.lineAllocations)
    insert(audience, "tally_expense_line_allocation", {
      ...allocation,
      party_id: mappedParty(partyIds, allocation.party_id),
    });
}

function mappedParty(ids: Map<string, string>, value: unknown): string {
  const originId = String(value);
  const mapped = ids.get(originId);
  if (!mapped) throw new VaultShareError(`Tally party ${originId} is missing`);
  return mapped;
}

/** Every re-owned row points here. */
export function ownerPartyId(db: DatabaseSync): string {
  const owner = db
    .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
    .get() as { self_party_id: string };
  return owner.self_party_id;
}
