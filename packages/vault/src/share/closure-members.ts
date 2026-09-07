/*
 * THE CLOSURE PREDICATE, WITH MEMBERSHIP AS EXPLICIT STATE (#996, R10).
 *
 * A grant's closure is a SET OF ROWS — `(physical table, primary key)` — and
 * this module is the one place that says which. Two questions it answers that
 * a composed shape could not:
 *
 *   - WHICH ROWS ARE IN SCOPE RIGHT NOW. `readShareClosure` already walks the
 *     graph a share needs, so the member set is derived from ITS result rather
 *     than from a second walk that could disagree with the snapshot the same
 *     subscriber bootstraps from. One walk, two readings.
 *   - WHICH ROWS WERE IN SCOPE LAST TIME. `share_subscription_member`, on the
 *     ORIGIN. An existing photograph added to a shared album writes exactly
 *     ONE log row — the collection entry — while four rows enter the
 *     audience's copy, so the log alone can never say what entered. The
 *     difference between the two sets can.
 *
 * DERIVED ROWS ARE NOT MEMBERS, BY TABLE (R10, and R20(b) is what makes it a
 * table rule): `core_content_derivative` holds the generated caption, the OCR
 * text, the transcript, the embedding and the thumbnail, and every one of them
 * is the RECEIVING vault's job under the recipient's own egress answers (R18).
 * Excluding the table by name rather than the rows by variant is what makes
 * "no vault-private reference can leak" true by construction instead of true
 * until someone adds a variant.
 */

import type { DatabaseSync } from "node:sqlite";

import { encodeWireValue } from "@centraid/core/protocol";

import { primaryKeyOf } from "../replica/log.js";
import type { WireClosure, WireRow } from "./closure.js";

/**
 * Tables whose rows are DERIVED and therefore never members of a closure. A
 * table, not a predicate over rows: see the header.
 */
export const SHARE_DERIVED_TABLES: readonly string[] = [
  "core_content_derivative",
  // The decoded text of some bytes, written by `setRepresentation` on the
  // vault that holds them. The audience decodes its own copy.
  "core_content_text",
];

export interface ShareMemberRow {
  /** Physical table, as `replica_log` names it. */
  readonly table: string;
  /** `replica_log.pk_json`: the key values in declared order, JSON-encoded. */
  readonly pk: string;
}

export type ShareMemberSet = Map<string, ShareMemberRow>;

/** `table` and `pk` joined by a separator neither half can contain. */
export function memberKey(table: string, pk: string): string {
  return `${table} ${pk}`;
}

/**
 * The log's own key for one row of one table, so a member row and a log row
 * join by string equality and a composite key needs no second column.
 */
export function memberPrimaryKey(
  vault: DatabaseSync,
  table: string,
  row: object
): string {
  const values = row as Readonly<Record<string, unknown>>;
  return JSON.stringify(
    primaryKeyOf(vault, table).map((column) => encodeWireValue(values[column]))
  );
}

/** The owner half of every representation a closure's rows can carry. */
const REPRESENTATION_OWNERS: readonly {
  readonly ownerType: string;
  readonly of: (closure: WireClosure) => readonly string[];
}[] = [
  {
    ownerType: "media.asset",
    of: (closure) => closure.rows.mediaAssets.map((row) => row.asset_id),
  },
  {
    ownerType: "core.document",
    of: (closure) => closure.rows.documents.map((row) => row.document_id),
  },
  {
    // Bytes no wrapper claims yet own their own reading
    // (`UNCLAIMED_OWNER_TYPE`), and that row is authored, not generated.
    ownerType: "core.content_item",
    of: (closure) => closure.rows.contentItems.map((row) => row.content_id),
  },
];

function add(
  into: ShareMemberSet,
  vault: DatabaseSync,
  table: string,
  row: object
): void {
  if (SHARE_DERIVED_TABLES.includes(table)) return;
  const pk = memberPrimaryKey(vault, table, row);
  into.set(memberKey(table, pk), { table, pk });
}

/**
 * The representation rows the closure's owners hold. AUTHORED metadata under
 * R20(b) — an owner saying what its bytes are — so unlike a caption it IS a
 * member, which is what lets it enter and leave with the row it describes.
 */
function addRepresentations(
  into: ShareMemberSet,
  vault: DatabaseSync,
  closure: WireClosure
): void {
  const read = vault.prepare(
    `SELECT representation_id FROM core_content_representation
      WHERE owner_type = ? AND owner_id = ?`
  );
  for (const owner of REPRESENTATION_OWNERS)
    for (const ownerId of owner.of(closure)) {
      const row = read.get(owner.ownerType, ownerId) as
        | { representation_id: string }
        | undefined;
      if (row)
        add(into, vault, "core_content_representation", {
          representation_id: row.representation_id,
        });
    }
}

/**
 * Every row a closure puts in scope, keyed the way the log keys it.
 *
 * READ-ONLY over the origin, and a pure function of the closure plus the
 * representation rows its owners hold — so the same closure that bootstraps a
 * new subscriber and the member set the diff runs against cannot disagree.
 */
export function shareClosureMembers(
  origin: DatabaseSync,
  closure: WireClosure
): ShareMemberSet {
  const members: ShareMemberSet = new Map();
  const put = (table: string, row: object): void =>
    add(members, origin, table, row);
  const many = (table: string, rows: readonly WireRow[]): void => {
    for (const row of rows) put(table, row);
  };
  for (const row of closure.rows.contentItems) put("core_content_item", row);
  for (const row of closure.rows.mediaAssets) put("media_asset", row);
  for (const row of closure.rows.documents) put("core_document", row);
  for (const collection of closure.rows.collections) {
    put("core_collection", collection.row);
    many("core_collection_entry", collection.entries);
  }
  for (const folder of closure.rows.docsFolders) {
    put("core_concept_scheme", folder.scheme);
    many("core_concept", folder.folders);
    many("core_tag", folder.tags);
  }
  many("locker_item", closure.rows.lockerItems);
  for (const group of closure.rows.tallyGroups) {
    put("tally_group", group.group);
    put("social_circle", group.circle);
    many("social_circle_member", group.members);
    many("core_party", group.parties);
    many("tally_expense", group.expenses);
    many("tally_expense_split", group.splits);
    many("tally_expense_payer", group.payers);
    many("tally_settlement", group.settlements);
    many("tally_recurring_expense", group.recurring);
    many("tally_recurring_expense_split", group.recurringSplits);
    many("tally_recurring_exception", group.exceptions);
    many("tally_receipt", group.receipts);
    many("tally_receipt_line", group.lineItems);
    many("tally_receipt_line_allocation", group.lineAllocations);
  }
  addRepresentations(members, origin, closure);
  return members;
}

// ---------------------------------------------------------------------------
// THE STORED SET, on the origin.

export interface StoredShareMember extends ShareMemberRow {
  readonly enteredSeq: number;
}

/** What the origin last served for one grant. */
export function readShareMembers(
  origin: DatabaseSync,
  authorityId: string
): Map<string, StoredShareMember> {
  const rows = origin
    .prepare(
      `SELECT table_name, pk, entered_seq FROM share_subscription_member
        WHERE authority_id = ? ORDER BY table_name, pk`
    )
    .all(authorityId) as unknown as {
    table_name: string;
    pk: string;
    entered_seq: number;
  }[];
  return new Map(
    rows.map((row) => [
      memberKey(row.table_name, row.pk),
      { table: row.table_name, pk: row.pk, enteredSeq: row.entered_seq },
    ])
  );
}

/**
 * Replace one grant's stored membership, inside the caller's transaction. A
 * retained row KEEPS its `entered_seq` — that is the whole point of the
 * column: a re-entered row must be distinguishable from one the audience has
 * held since the subscription began, or a reconnect after retention expiry
 * cannot tell an idempotent re-send from a real enter.
 */
export function writeShareMembers(
  origin: DatabaseSync,
  input: { authorityId: string; members: ShareMemberSet; enteredSeq: number }
): void {
  const held = readShareMembers(origin, input.authorityId);
  origin
    .prepare("DELETE FROM share_subscription_member WHERE authority_id = ?")
    .run(input.authorityId);
  const write = origin.prepare(
    `INSERT INTO share_subscription_member
       (authority_id, table_name, pk, entered_seq)
     VALUES (?, ?, ?, ?)`
  );
  for (const [key, member] of input.members)
    write.run(
      input.authorityId,
      member.table,
      member.pk,
      held.get(key)?.enteredSeq ?? input.enteredSeq
    );
}

/**
 * Which live grants claim this row — the reverse question the index exists
 * for, asked by the purge sweep and by every leave output.
 */
export function shareGrantsClaimingRow(
  origin: DatabaseSync,
  table: string,
  pk: string
): string[] {
  return (
    origin
      .prepare(
        `SELECT authority_id FROM share_subscription_member
          WHERE table_name = ? AND pk = ? ORDER BY authority_id`
      )
      .all(table, pk) as unknown as { authority_id: string }[]
  ).map((row) => row.authority_id);
}
