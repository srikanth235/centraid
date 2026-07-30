import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { VaultShareError } from "../errors.js";
import {
  sealAad,
  sealedColumnsOf,
  sealValue,
  stampSealKeyFingerprint,
  unsealValue,
} from "../schema/sealed.js";
import type {
  CollectionClosure,
  ContentItemRow,
  DerivativeRow,
  ProjectionResult,
  ShareClosure,
  ShareableItemType,
  TallyGroupClosure,
} from "./closure.js";

type FreeId = (
  db: DatabaseSync,
  table: string,
  column: string,
  preferred: string
) => string;
type ReadClosure = (
  db: DatabaseSync,
  itemType: ShareableItemType,
  itemId: string
) => ShareClosure;
type ProjectClosure = (
  db: DatabaseSync,
  closure: ShareClosure,
  keys?: { origin: Buffer; audience: Buffer }
) => ProjectionResult;

const COLLECTION_ENTRY_TYPES = new Set<ShareableItemType>([
  "media.media_asset",
  "core.document",
  "core.content_item",
]);

export function readCollectionClosure(
  origin: DatabaseSync,
  itemId: string,
  readClosure: ReadClosure
): ShareClosure {
  const row = one(origin, "core_collection", "collection_id", itemId);
  if (!row)
    throw new VaultShareError(
      `core.collection ${itemId} is not in the origin vault`
    );
  const entryRows = origin
    .prepare(
      "SELECT * FROM core_collection_entry WHERE collection_id = ? ORDER BY position"
    )
    .all(itemId) as Array<Record<string, unknown>>;
  const entries = entryRows.map((entry) => {
    const targetType = String(entry.target_type);
    if (!COLLECTION_ENTRY_TYPES.has(targetType as ShareableItemType)) {
      throw new VaultShareError(
        `collection entry type ${targetType} cannot cross a vault boundary`
      );
    }
    return {
      row: entry,
      closure: readClosure(
        origin,
        targetType as ShareableItemType,
        String(entry.target_id)
      ),
    };
  });
  return {
    itemType: "core.collection",
    itemId,
    contentItem: null,
    derivatives: [],
    mediaAsset: null,
    document: null,
    collection: { row, entries },
    lockerItem: null,
    tallyGroup: null,
    shas: [...new Set(entries.flatMap((entry) => entry.closure.shas))],
  };
}

export function readTallyGroupClosure(
  origin: DatabaseSync,
  itemId: string
): ShareClosure {
  const group = one(origin, "tally_group", "group_id", itemId);
  if (!group)
    throw new VaultShareError(
      `tally.group ${itemId} is not in the origin vault`
    );
  const circleId = String(group.circle_id);
  const circle = one(origin, "social_circle", "circle_id", circleId);
  if (!circle)
    throw new VaultShareError(`Tally group ${itemId} has no audience circle`);
  const members = rows(origin, "social_circle_member", "circle_id", circleId);
  const expenses = rows(origin, "tally_expense", "group_id", itemId);
  const splits = expenses.flatMap((expense) =>
    rows(
      origin,
      "tally_expense_split",
      "expense_id",
      String(expense.expense_id)
    )
  );
  const settlements = rows(origin, "tally_settlement", "group_id", itemId);
  const recurring = rows(origin, "tally_recurring_expense", "group_id", itemId);
  const exceptions = recurring.flatMap(
    (template) =>
      origin
        .prepare(
          `SELECT * FROM schedule_recurrence_exception
            WHERE target_type = 'tally.recurring_expense' AND target_id = ?`
        )
        .all(String(template.template_id)) as Array<Record<string, unknown>>
  );
  const receipts = expenses.flatMap((expense) =>
    rows(
      origin,
      "tally_expense_receipt",
      "expense_id",
      String(expense.expense_id)
    )
  );
  const lineItems = receipts.flatMap((receipt) =>
    rows(
      origin,
      "tally_expense_line_item",
      "receipt_id",
      String(receipt.receipt_id)
    )
  );
  const lineAllocations = lineItems.flatMap((line) =>
    rows(
      origin,
      "tally_expense_line_allocation",
      "line_item_id",
      String(line.line_item_id)
    )
  );
  const receiptContentItems: ContentItemRow[] = [];
  const receiptDerivatives: Array<{
    contentId: string;
    rows: DerivativeRow[];
  }> = [];
  const shas = new Set<string>();
  for (const receipt of receipts) {
    const contentId = String(receipt.content_id);
    const content = origin
      .prepare(
        `SELECT content_id, media_type, content_uri, sha256, byte_size, title,
                language, deleted_at, purge_at, created_at
           FROM core_content_item WHERE content_id = ?`
      )
      .get(contentId) as ContentItemRow | undefined;
    if (!content) continue;
    receiptContentItems.push(content);
    if (
      typeof content.content_uri === "string" &&
      content.content_uri.startsWith("blob:")
    ) {
      shas.add(content.sha256);
    }
    const derivatives = origin
      .prepare(
        `SELECT derivative_id, variant, sha256, media_type, byte_size,
                text_content, created_at
           FROM core_content_derivative WHERE content_id = ? ORDER BY variant`
      )
      .all(contentId) as unknown as DerivativeRow[];
    receiptDerivatives.push({ contentId, rows: derivatives });
    for (const derivative of derivatives) {
      if (derivative.sha256 !== null) shas.add(derivative.sha256);
    }
  }
  const partyIds = new Set<string>([
    ...members.map((row) => String(row.party_id)),
    ...expenses.map((row) => String(row.paid_by)),
    ...splits.map((row) => String(row.party_id)),
    ...settlements.flatMap((row) => [
      String(row.from_party),
      String(row.to_party),
    ]),
    ...recurring.map((row) => String(row.paid_by)),
    ...lineAllocations.map((row) => String(row.party_id)),
  ]);
  const parties = [...partyIds].flatMap((partyId) => {
    const party = one(origin, "core_party", "party_id", partyId);
    return party ? [party] : [];
  });
  return {
    itemType: "tally.group",
    itemId,
    contentItem: null,
    derivatives: [],
    mediaAsset: null,
    document: null,
    collection: null,
    lockerItem: null,
    tallyGroup: {
      group,
      circle,
      members,
      parties,
      expenses,
      splits,
      settlements,
      recurring,
      exceptions,
      receipts,
      lineItems,
      lineAllocations,
      receiptContentItems,
      receiptDerivatives,
    },
    shas: [...shas],
  };
}

export function projectLockerItem(
  audience: DatabaseSync,
  originRow: Record<string, unknown>,
  originKey: Buffer,
  audienceKey: Buffer,
  freeId: FreeId
): ProjectionResult {
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
      originKey,
      sealAad("locker_item", column, originId),
      value
    );
    projected[column] = sealValue(
      audienceKey,
      sealAad("locker_item", column, itemId),
      plaintext
    );
  }
  insert(audience, "locker_item", projected);
  stampSealKeyFingerprint(audience, audienceKey);
  return { itemId, deduped: false };
}

export function projectCollection(
  audience: DatabaseSync,
  closure: CollectionClosure,
  keys: { origin: Buffer; audience: Buffer } | undefined,
  projectClosure: ProjectClosure,
  freeId: FreeId
): ProjectionResult {
  const originId = String(closure.row.collection_id);
  if (one(audience, "core_collection", "collection_id", originId))
    return { itemId: originId, deduped: true };
  const itemId = freeId(audience, "core_collection", "collection_id", originId);
  const owner = audience
    .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
    .get() as { owner_party_id: string };
  const projectedEntries = closure.entries.map((entry) => ({
    source: entry,
    result: projectClosure(audience, entry.closure, keys),
  }));
  let coverContentId: string | null = null;
  const originCover = nullableString(closure.row.cover_content_id);
  if (originCover) {
    // Map the origin cover to the audience-side content id. After sha256
    // dedupe, that id may differ from the origin content_id — inserting the
    // origin id fails the cover_content_id foreign key.
    const cover = projectedEntries.find(
      ({ source }) =>
        source.closure.contentItem?.content_id === originCover ||
        source.closure.mediaAsset?.content_id === originCover
    );
    coverContentId = cover?.result.contentId ?? null;
  }
  insert(audience, "core_collection", {
    ...closure.row,
    collection_id: itemId,
    owner_party_id: owner.owner_party_id,
    cover_content_id: coverContentId,
    parent_collection_id: null,
  });
  for (const { source, result } of projectedEntries) {
    insert(audience, "core_collection_entry", {
      ...source.row,
      entry_id: freeId(
        audience,
        "core_collection_entry",
        "entry_id",
        String(source.row.entry_id)
      ),
      collection_id: itemId,
      target_id: result.itemId,
    });
  }
  return { itemId, deduped: false };
}

export function projectTallyGroup(
  audience: DatabaseSync,
  closure: TallyGroupClosure,
  freeId: FreeId
): ProjectionResult {
  const originId = String(closure.group.group_id);
  if (one(audience, "tally_group", "group_id", originId))
    return { itemId: originId, deduped: true };
  const partyIds = new Map<string, string>();
  for (const party of closure.parties) {
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
  const owner = audience
    .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
    .get() as { owner_party_id: string };
  const circleId = freeId(
    audience,
    "social_circle",
    "circle_id",
    String(closure.circle.circle_id)
  );
  insert(audience, "social_circle", {
    ...closure.circle,
    circle_id: circleId,
    owner_party_id: owner.owner_party_id,
    name: uniqueCircleName(audience, String(closure.circle.name)),
  });
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
  for (const settlement of closure.settlements)
    insert(audience, "tally_settlement", {
      ...settlement,
      group_id: groupId,
      from_party: mappedParty(partyIds, settlement.from_party),
      to_party: mappedParty(partyIds, settlement.to_party),
      txn_id: null,
    });
  for (const recurring of closure.recurring) {
    const splits = JSON.parse(String(recurring.splits_json)) as Array<
      Record<string, unknown>
    >;
    insert(audience, "tally_recurring_expense", {
      ...recurring,
      group_id: groupId,
      paid_by: mappedParty(partyIds, recurring.paid_by),
      splits_json: JSON.stringify(
        splits.map((split) => ({
          ...split,
          party_id: mappedParty(partyIds, split.party_id),
        }))
      ),
    });
  }
  for (const exception of closure.exceptions)
    insert(audience, "schedule_recurrence_exception", exception);

  // Project receipt bytes + OCR structure so the audience ledger reconciles.
  const contentIdMap = new Map<string, string>();
  for (const content of closure.receiptContentItems) {
    const existing = audience
      .prepare("SELECT content_id FROM core_content_item WHERE sha256 = ?")
      .get(content.sha256) as { content_id: string } | undefined;
    if (existing) {
      contentIdMap.set(content.content_id, existing.content_id);
      continue;
    }
    const contentId = freeId(
      audience,
      "core_content_item",
      "content_id",
      content.content_id
    );
    contentIdMap.set(content.content_id, contentId);
    insert(audience, "core_content_item", {
      ...content,
      content_id: contentId,
      creator_party_id: null,
      origin_device_id: null,
    });
  }
  for (const pack of closure.receiptDerivatives) {
    const audienceContentId = contentIdMap.get(pack.contentId);
    if (!audienceContentId) continue;
    for (const derivative of pack.rows) {
      if (
        one(
          audience,
          "core_content_derivative",
          "derivative_id",
          String(derivative.derivative_id)
        )
      ) {
        continue;
      }
      insert(audience, "core_content_derivative", {
        ...derivative,
        content_id: audienceContentId,
      });
    }
  }
  for (const receipt of closure.receipts) {
    const originContentId = String(receipt.content_id);
    const audienceContentId = contentIdMap.get(originContentId);
    if (!audienceContentId) continue;
    insert(audience, "tally_expense_receipt", {
      ...receipt,
      content_id: audienceContentId,
    });
  }
  for (const line of closure.lineItems)
    insert(audience, "tally_expense_line_item", line);
  for (const allocation of closure.lineAllocations)
    insert(audience, "tally_expense_line_allocation", {
      ...allocation,
      party_id: mappedParty(partyIds, allocation.party_id),
    });
  return { itemId: groupId, deduped: false };
}

function mappedParty(ids: Map<string, string>, value: unknown): string {
  const originId = String(value);
  const mapped = ids.get(originId);
  if (!mapped) throw new VaultShareError(`Tally party ${originId} is missing`);
  return mapped;
}

function uniqueCircleName(db: DatabaseSync, preferred: string): string {
  const owner = db
    .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
    .get() as { owner_party_id: string };
  const held = db
    .prepare(
      "SELECT 1 FROM social_circle WHERE owner_party_id = ? AND name = ?"
    )
    .get(owner.owner_party_id, preferred);
  return held ? `${preferred} (shared)` : preferred;
}

function one(
  db: DatabaseSync,
  table: string,
  column: string,
  value: string
): Record<string, unknown> | undefined {
  return db
    .prepare(`SELECT * FROM "${table}" WHERE "${column}" = ?`)
    .get(value) as Record<string, unknown> | undefined;
}

function rows(
  db: DatabaseSync,
  table: string,
  column: string,
  value: string
): Array<Record<string, unknown>> {
  return db
    .prepare(`SELECT * FROM "${table}" WHERE "${column}" = ?`)
    .all(value) as Array<Record<string, unknown>>;
}

function insert(
  db: DatabaseSync,
  table: string,
  row: Record<string, unknown>
): void {
  const entries = Object.entries(row);
  const columns = entries.map(([column]) => `"${column}"`).join(", ");
  const slots = entries.map(() => "?").join(", ");
  db.prepare(`INSERT INTO "${table}" (${columns}) VALUES (${slots})`).run(
    ...(entries.map(([, value]) => value) as SQLInputValue[])
  );
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
