// Every column renting a `core.content_item`'s bytes (#883): a missing entry
// is bytes reclaimed under a live row. `onlyLive` is the trash clamp;
// `documentHead` is the head the sweep walks past instead (#352).

export interface ContentReference {
  table: string;
  column: string;
  onlyLive?: string;
  documentHead?: true;
}

export const CONTENT_REFERENCES: readonly ContentReference[] = [
  { table: "core_attachment", column: "content_id" },
  { table: "core_party", column: "avatar_content_id" },
  {
    table: "knowledge_note",
    column: "body_content_id",
    onlyLive: "deleted_at IS NULL",
  },
  { table: "social_message", column: "body_content_id" },
  { table: "core_collection", column: "cover_content_id" },
  { table: "health_workout", column: "route_content_id" },
  { table: "consent_export_job", column: "artifact_content_id" },
  {
    table: "media_asset",
    column: "content_id",
    onlyLive: "deleted_at IS NULL",
  },
  {
    table: "core_document",
    column: "current_content_id",
    documentHead: true,
  },
];

export function contentReferenceExists(options: {
  idExpression: string;
  live: boolean;
  includeDocumentHead: boolean;
}): string[] {
  return CONTENT_REFERENCES.filter(
    (ref) => options.includeDocumentHead || ref.documentHead !== true
  ).map((ref) => {
    const clamp = options.live && ref.onlyLive ? ` AND ${ref.onlyLive}` : "";
    return `SELECT 1 FROM ${ref.table} WHERE ${ref.column} = ${options.idExpression}${clamp}`;
  });
}
