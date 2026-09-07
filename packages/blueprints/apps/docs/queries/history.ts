/**
 * Document version chain (#352, re-cut by #996 R20(a)): `core.entity_revision`
 * is the durable history and the ONLY one. Walk the document's OCCURRENCES
 * from `current_revision_id` through `parent_revision_id` — each names the
 * content that became current at that moment, so a document that returns to
 * bytes it already held reads as two versions rather than one node a
 * content-keyed walk had to collapse. Dates are the occurrence's own
 * `recorded_at`.
 *
 * The `revises` `core.link` chain this replaced was a SECOND history mechanism
 * beside the table [#916] ruled the only one, and it keyed a version by its
 * content id — which is why two documents with identical bytes used to share
 * one history.
 */

import { inList, readPages } from "../../_shared/paged-reads.ts";
import {
  ownerKey,
  readRepresentations,
} from "../../_shared/representation-reads.ts";

// Caps a malformed chain; a well-formed one terminates on a null parent.
const MAX_CHAIN_STEPS = 500;

interface DocumentRow {
  document_id: string;
  current_content_id: string;
  current_revision_id?: string | null;
  created_at: string;
}
interface RevisionRow {
  revision_id: string;
  content_id?: string | null;
  parent_revision_id?: string | null;
  recorded_at: string;
}
interface ContentRow {
  content_id: string;
  byte_size?: number | null;
  content_uri?: string | null;
  created_at?: string;
}

export default async function historyHandler({ input, ctx }: HandlerArgs) {
  const documentId = String(input?.document_id ?? "");
  if (!documentId) return { versions: [] };
  try {
    // ONE ROW, ASKED FOR AS ONE ROW (#996 wave 4). A page's window is part of
    // its type, so the document read says `limit: 1` and means it.
    const docPage = await ctx.vault.page<DocumentRow>({
      query: {
        name: "docs.history.document",
        select:
          "document_id, current_content_id, current_revision_id, created_at",
        from: "core_document",
        where: "document_id = ?",
        bind: [documentId],
        order: {
          sortColumn: "document_id",
          pkColumn: "document_id",
          descending: false,
        },
      },
      limit: 1,
    });
    const doc = docPage.rows[0];
    if (!doc) return { versions: [] };

    // Every occurrence of THIS document, newest first. One read: the chain is
    // walked in memory over ids the same read returned, so a long history
    // costs one round trip rather than one per version.
    const revisions = await ctx.vault.page<RevisionRow>({
      query: {
        name: "docs.history.revisions",
        select: "revision_id, content_id, parent_revision_id, recorded_at",
        from: "core_entity_revision",
        where: "entity_type = ? AND entity_id = ?",
        bind: ["core.document", documentId],
        order: {
          sortColumn: "recorded_at",
          pkColumn: "revision_id",
          descending: true,
        },
      },
      limit: MAX_CHAIN_STEPS,
    });
    const byId = new Map(revisions.rows.map((row) => [row.revision_id, row]));
    const chainIds: string[] = [];
    const assertedAtOf = new Map<string, string>();
    const seen = new Set<string>();
    let at = doc.current_revision_id ?? null;
    for (let step = 0; at != null && step < MAX_CHAIN_STEPS; step += 1) {
      if (seen.has(at)) break;
      seen.add(at);
      const revision = byId.get(at);
      if (!revision?.content_id) break;
      chainIds.push(revision.content_id);
      // A content id can appear twice; the date shown is the occurrence's.
      if (!assertedAtOf.has(revision.content_id))
        assertedAtOf.set(revision.content_id, revision.recorded_at);
      at = revision.parent_revision_id ?? null;
    }
    // A document minted before its wrapper carried a pointer still has one
    // version: the bytes it is currently made of. Honest absence, not a hole.
    if (chainIds.length === 0) chainIds.push(doc.current_content_id);

    const contentIn = inList("content_id", chainIds);
    const [contentRows, representations] = await Promise.all([
      // Bounded by the chain the walk above produced, so it is walked to the
      // end of that set rather than taking one window of it.
      readPages<ContentRow>(ctx, {
        name: "docs.history.contents",
        select: "content_id, byte_size, content_uri, created_at",
        from: "core_content_item",
        where: contentIn.sql,
        bind: contentIn.bind,
        order: {
          sortColumn: "content_id",
          pkColumn: "content_id",
          descending: false,
        },
      }),
      // Bytes carry no media type since #996 (R20(b)). A SUPERSEDED version
      // has no representation of its own — the document's moved with the head
      // — and an edit never changes the format, so the head's answer covers
      // the whole chain.
      readRepresentations({ ctx, contentIds: chainIds }),
    ]);
    const documentMediaType =
      representations.byOwner.get(ownerKey("core.document", doc.document_id)) ??
      null;
    const contentById = new Map(contentRows.map((c) => [c.content_id, c]));

    const srcOf = (c: ContentRow | undefined) =>
      typeof c?.content_uri === "string" && c.content_uri.startsWith("blob:")
        ? `/centraid/_vault/blobs/${c.content_id}`
        : c?.content_uri;
    const posterOf = (c: ContentRow | undefined) =>
      typeof c?.content_uri === "string" && c.content_uri.startsWith("blob:")
        ? `/centraid/_vault/blobs/${c.content_id}?variant=poster`
        : null;

    const versions = chainIds.map((id, i) => {
      const c = contentById.get(id);
      return {
        content_id: id,
        media_type: representations.byContent.get(id) ?? documentMediaType,
        byte_size: c?.byte_size ?? null,
        content_uri: srcOf(c),
        poster_uri: posterOf(c),
        current: i === 0,
        // The occurrence's own instant; a pre-#996 document with no
        // occurrence falls back to the content's mint, then the document's.
        asserted_at: assertedAtOf.get(id) ?? c?.created_at ?? doc.created_at,
      };
    });

    return { versions };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { versions: [], vaultDenied: { code: e.code, message: e.message } };
  }
}
