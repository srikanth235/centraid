import { tallyGroupNet } from "@centraid/blueprints";
import type { TallyBalanceData } from "@centraid/blueprints";
import type { VaultDb } from "@centraid/vault";

import type { Side } from "./peer-give.test-fixtures.js";

export function addKnownParty(steward: Side, member: Side, now: string): void {
  steward.vault.vault
    .prepare(
      `INSERT INTO core_party
         (party_id, kind, display_name, sort_name, birth_date,
          avatar_content_id, created_at, updated_at, ontology_version)
       VALUES (?, 'person', ?, ?, NULL, NULL, ?, ?, '1.4')
       ON CONFLICT(party_id) DO NOTHING`
    )
    .run(member.ownerPartyId, member.label, member.label, now, now);
}

/** Build the exact ground-fact shape consumed by Tally's shipped groupNet.
 * No balance row crosses Commons: every assertion calls the product fold over
 * the domain rows resident in that particular seat. */
export function localTallyNet(
  db: VaultDb,
  groupId: string
): Record<string, number> {
  const circle = db.vault
    .prepare("SELECT circle_id FROM tally_group WHERE group_id = ?")
    .get(groupId) as { circle_id: string };
  const memberIds = (
    db.vault
      .prepare(
        "SELECT party_id FROM social_circle_member WHERE circle_id = ? ORDER BY party_id"
      )
      .all(circle.circle_id) as { party_id: string }[]
  ).map((row) => row.party_id);
  const expenses = (
    db.vault
      .prepare(
        `SELECT expense_id, group_id, paid_by, amount_minor
           FROM tally_expense
          WHERE group_id = ? AND deleted_at IS NULL
          ORDER BY expense_id`
      )
      .all(groupId) as Array<{
      expense_id: string;
      group_id: string;
      paid_by: string;
      amount_minor: number;
    }>
  ).map((expense) => ({
    ...expense,
    splits: Object.fromEntries(
      (
        db.vault
          .prepare(
            `SELECT party_id, share_minor FROM tally_expense_split
              WHERE expense_id = ? ORDER BY party_id`
          )
          .all(expense.expense_id) as Array<{
          party_id: string;
          share_minor: number;
        }>
      ).map((split) => [split.party_id, split.share_minor])
    ),
    payers: Object.fromEntries(
      (
        db.vault
          .prepare(
            `SELECT party_id, paid_minor FROM tally_expense_payer
              WHERE expense_id = ? ORDER BY party_id`
          )
          .all(expense.expense_id) as Array<{
          party_id: string;
          paid_minor: number;
        }>
      ).map((payer) => [payer.party_id, payer.paid_minor])
    ),
  }));
  const settlements = db.vault
    .prepare(
      `SELECT from_party, to_party, amount_minor, group_id
         FROM tally_settlement WHERE group_id = ? AND deleted_at IS NULL`
    )
    .all(groupId) as Array<{
    group_id: string;
    from_party: string;
    to_party: string;
    amount_minor: number;
  }>;
  const facts = {
    membersByGroup: new Map([[groupId, memberIds]]),
    expenses,
    settlements,
  } satisfies TallyBalanceData;
  return Object.fromEntries(
    [...tallyGroupNet(facts, groupId)].toSorted(([a], [b]) =>
      a.localeCompare(b)
    )
  );
}

export function documentRows(
  db: VaultDb,
  folderId: string
): Array<{ document_id: string; title: string; sha256: string }> {
  return db.vault
    .prepare(
      `WITH RECURSIVE folders(concept_id) AS (
         SELECT ?
         UNION ALL
         SELECT child.concept_id FROM core_concept child
         JOIN folders parent ON child.broader_concept_id = parent.concept_id
       )
       SELECT d.document_id, d.title, content.sha256
         FROM core_tag tag
         JOIN folders ON folders.concept_id = tag.concept_id
         JOIN core_document d ON d.document_id = tag.target_id
         JOIN core_content_item content ON content.content_id = d.current_content_id
        WHERE tag.target_type = 'core.document' AND d.deleted_at IS NULL
        ORDER BY d.title, d.document_id`
    )
    .all(folderId) as Array<{
    document_id: string;
    title: string;
    sha256: string;
  }>;
}
