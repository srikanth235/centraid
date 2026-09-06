// Version chain over THIS DEVICE'S replica (#821), re-cut by #996 (R20(a)).
//
// The chain is the document's own REVISION OCCURRENCES, walked from
// `current_revision_id` through `parent_revision_id`. Each occurrence names the
// content that became current at that moment, so a document restored to bytes
// it already held reads as an extra version rather than a node the walk has to
// collapse. Dates are the occurrence's own `recorded_at`.
//
// It was a `revises` `core.link` walk that first had to resolve a concept out
// of two more replicated tables — three reads and a taxonomy lookup to answer
// "what did this used to say". No provenance on this replica — withhold rather
// than guess. No diff.

import type { EntityRow } from "./docs-projection";

const MAX_CHAIN_STEPS = 500;

const str = (row: EntityRow, key: string): string | null => {
  const value = row[key];
  return typeof value === "string" ? value : null;
};
const num = (row: EntityRow, key: string): number | null => {
  const value = row[key];
  return typeof value === "number" ? value : null;
};

export interface MobileVersionEntry {
  /** 1 is the original; the current version is `versionCount`. */
  n: number;
  content_id: string;
  media_type: string | null;
  byte_size: number | null;
  current: boolean;
  /** The occurrence's own instant; a document with none dates from its mint. */
  asserted_at: string;
}

export interface VersionChain {
  entries: MobileVersionEntry[];
  versionCount: number;
  currentContentId: string;
}

export interface VersionChainRows {
  document: EntityRow | undefined;
  revisions: readonly EntityRow[];
  contents: readonly EntityRow[];
  /** The document's reading of its bytes (#996, ruling R20(b)). A SUPERSEDED
   *  version has no representation of its own — the document's moved with the
   *  head — and an edit changes the words, never the format. */
  representations: readonly EntityRow[];
}

export function projectVersionChain(
  rows: VersionChainRows
): VersionChain | null {
  const doc = rows.document;
  if (!doc) return null;
  const currentContentId = str(doc, "current_content_id");
  if (!currentContentId) return null;
  const documentId = str(doc, "document_id");

  const revisionById = new Map(
    rows.revisions.flatMap((revision) => {
      // The replica carries every entity's revisions; this walk is one
      // document's, so the rows are filtered before they are indexed.
      if (str(revision, "entity_type") !== "core.document") return [];
      if (documentId !== null && str(revision, "entity_id") !== documentId)
        return [];
      const id = str(revision, "revision_id");
      return id ? [[id, revision] as const] : [];
    })
  );

  const chainIds: string[] = [];
  const assertedAtOf = new Map<string, string>();
  const seen = new Set<string>();
  let at = str(doc, "current_revision_id");
  for (let step = 0; at !== null && step < MAX_CHAIN_STEPS; step += 1) {
    if (seen.has(at)) break;
    seen.add(at);
    const revision = revisionById.get(at);
    if (!revision) break;
    const contentId = str(revision, "content_id");
    if (contentId === null) break;
    chainIds.push(contentId);
    // A content id can appear twice; the date shown is that occurrence's.
    if (!assertedAtOf.has(contentId))
      assertedAtOf.set(contentId, str(revision, "recorded_at") ?? "");
    at = str(revision, "parent_revision_id");
  }
  // A document minted before the wrapper carried a pointer still has one
  // version: the bytes it is currently made of.
  if (chainIds.length === 0) chainIds.push(currentContentId);

  const contentById = new Map(
    rows.contents.flatMap((content) => {
      const id = str(content, "content_id");
      return id ? [[id, content] as const] : [];
    })
  );

  const mediaTypeByContent = new Map<string, string>();
  let documentMediaType: string | null = null;
  for (const representation of rows.representations) {
    const mediaType = str(representation, "media_type");
    const contentId = str(representation, "content_id");
    if (!mediaType) continue;
    if (contentId) mediaTypeByContent.set(contentId, mediaType);
    if (
      str(representation, "owner_type") === "core.document" &&
      str(representation, "owner_id") === documentId
    )
      documentMediaType = mediaType;
  }

  const count = chainIds.length;
  const entries = chainIds.map((id, index): MobileVersionEntry => {
    const content = contentById.get(id);
    return {
      n: count - index,
      content_id: id,
      media_type: mediaTypeByContent.get(id) ?? documentMediaType,
      byte_size: content ? num(content, "byte_size") : null,
      current: index === 0,
      asserted_at:
        assertedAtOf.get(id) ||
        (content ? str(content, "created_at") : null) ||
        str(doc, "created_at") ||
        "",
    };
  });

  return { entries, versionCount: count, currentContentId };
}
