import type { DatabaseSync } from "node:sqlite";

import { decodeDataUri } from "../blob/mint.js";

export const INLINE_BODY_BUDGET_BYTES = 64 * 1024;

export class InlineBodyTooLargeError extends Error {
  readonly code = "INLINE_BODY_TOO_LARGE";
  constructor(
    readonly byteSize: number,
    readonly budgetBytes: number,
    readonly mediaType: string
  ) {
    super(
      `inline ${mediaType} body is ${byteSize} bytes, over the ${budgetBytes}-byte inline budget — ` +
        "text bodies cannot redirect to blob storage (the search index reads them in-transaction), " +
        "so this one is refused rather than silently bloating the vault"
    );
    this.name = "InlineBodyTooLargeError";
  }
}

export function assertTextBodyWithinBudget(
  bodyText: string,
  mediaType: string,
  budgetBytes: number = INLINE_BODY_BUDGET_BYTES
): void {
  const byteSize = Buffer.byteLength(bodyText, "utf8");
  if (byteSize > budgetBytes)
    throw new InlineBodyTooLargeError(byteSize, budgetBytes, mediaType);
}

export function assertInlineDataUriWithinBudget(
  dataUri: string,
  budgetBytes: number = INLINE_BODY_BUDGET_BYTES
): void {
  const { mediaType, bytes } = decodeDataUri(dataUri);
  if (mediaType.startsWith("text/") && bytes.length > budgetBytes) {
    throw new InlineBodyTooLargeError(bytes.length, budgetBytes, mediaType);
  }
}

export interface InlineBodyViolationEntry {
  entity: string;
  count: number;
  bytes: number;
}

export interface InlineBodyViolationScan {
  budgetBytes: number;
  total: { count: number; bytes: number };
  byEntity: InlineBodyViolationEntry[];
}

export function scanInlineBodyViolations(
  vault: DatabaseSync,
  budgetBytes: number = INLINE_BODY_BUDGET_BYTES
): InlineBodyViolationScan {
  const rows = vault
    .prepare(
      `SELECT content_id, byte_size FROM core_content_item
        WHERE content_uri LIKE 'data:%' AND byte_size > ? AND deleted_at IS NULL`
    )
    .all(budgetBytes) as { content_id: string; byte_size: number }[];
  if (rows.length === 0) {
    return { budgetBytes, total: { count: 0, bytes: 0 }, byEntity: [] };
  }
  const byContent = new Map(rows.map((r) => [r.content_id, r.byte_size]));
  const attributed = new Set<string>();
  const byEntity = new Map<string, { count: number; bytes: number }>();
  const add = (entity: string, contentId: string): void => {
    const size = byContent.get(contentId);
    if (size === undefined || attributed.has(contentId)) return;
    attributed.add(contentId);
    const acc = byEntity.get(entity) ?? { count: 0, bytes: 0 };
    acc.count += 1;
    acc.bytes += size;
    byEntity.set(entity, acc);
  };
  const ids = [...byContent.keys()];
  const placeholders = ids.map(() => "?").join(", ");
  for (const [entity, table, column] of [
    ["knowledge.note", "knowledge_note", "body_content_id"],
    ["social.message", "social_message", "body_content_id"],
    ["core.document", "core_document", "current_content_id"],
  ] as const) {
    const hits = vault
      .prepare(
        `SELECT DISTINCT ${column} AS content_id FROM ${table} WHERE ${column} IN (${placeholders})`
      )
      .all(...ids) as { content_id: string }[];
    for (const h of hits) add(entity, h.content_id);
  }
  for (const contentId of ids) {
    if (!attributed.has(contentId)) add("core.content_item", contentId);
  }
  const total = [...byEntity.values()].reduce(
    (acc, v) => ({ count: acc.count + v.count, bytes: acc.bytes + v.bytes }),
    { count: 0, bytes: 0 }
  );
  return {
    budgetBytes,
    total,
    byEntity: [...byEntity.entries()]
      .map(([entity, v]) => ({ entity, ...v }))
      .sort((a, b) => b.bytes - a.bytes),
  };
}
