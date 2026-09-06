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
  media_type?: string | null;
  byte_size?: number | null;
  content_uri?: string | null;
  created_at?: string;
}

export default async function historyHandler({ input, ctx }: HandlerArgs) {
  const documentId = String(input?.document_id ?? "");
  if (!documentId) return { versions: [] };
  try {
    const docRes = await ctx.vault.read({
      entity: "core.document",
      where: [{ column: "document_id", op: "eq", value: documentId }],
      limit: 1,
    });
    const doc = ((docRes.rows ?? []) as unknown as DocumentRow[])[0];
    if (!doc) return { versions: [] };

    // Every occurrence of THIS document, newest first. One read: the chain is
    // walked in memory over ids the same read returned, so a long history
    // costs one round trip rather than one per version.
    const revisions = await ctx.vault.read({
      entity: "core.entity_revision",
      where: [
        { column: "entity_type", op: "eq", value: "core.document" },
        { column: "entity_id", op: "eq", value: documentId },
      ],
      orderBy: { column: "recorded_at", dir: "desc" },
      limit: MAX_CHAIN_STEPS,
    });
    const byId = new Map(
      ((revisions.rows ?? []) as unknown as RevisionRow[]).map((row) => [
        row.revision_id,
        row,
      ])
    );
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

    const contents = await ctx.vault.read({
      acceptTruncation: true,
      entity: "core.content_item",
      where: [{ column: "content_id", op: "in", value: chainIds }],
    });
    const contentById = new Map(
      ((contents.rows ?? []) as unknown as ContentRow[]).map((c) => [
        c.content_id,
        c,
      ])
    );

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
        media_type: c?.media_type ?? null,
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
