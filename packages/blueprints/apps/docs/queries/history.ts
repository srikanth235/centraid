/**
 * A document's version chain (issue #352): never a command, since core.link
 * is already the durable history — this walks it. Starting at the wrapper's
 * current_content_id, each step follows the single live `revises` edge OUT
 * of the current content item (NEW -> OLD, the direction
 * commands/revisions.ts's recordRevision asserts) to the version it once
 * superseded, stopping at whichever content item has no such edge (the
 * original, never-revised upload) or a content id already visited — restoring
 * an old version gives it a NEW outgoing edge (rule R3: history only ever
 * grows forward), which can cycle the graph back through content already
 * walked once a document has been restored more than once, and the guard
 * keeps this walk terminating exactly the way documents.test.ts's own
 * versionChain helper and restore_document_version's target_in_chain
 * precondition (packages/vault/src/commands/documents.ts) both do.
 *
 * Ordering is honest, not naive: each entry's date is the ASSERTION time of
 * the edge that once made it current (or superseded it) — the revises link's
 * valid_from — not the content item's own created_at. A restored old version
 * reads as the newest entry even though its bytes predate everything below
 * it, exactly as the vault itself records it.
 */

// Mirrors packages/vault/src/commands/links.ts's RELATIONS_SCHEME_URI.
const RELATIONS_SCHEME_URI = 'urn:duaility:relations';
const REVISES_RELATION = 'revises';
// However long a document's real edit history runs, one walk step per
// version is still a bounded read per step — this just caps runaway growth
// (a document with more edits than this is not a realistic case today).
const MAX_CHAIN_STEPS = 500;

interface DocumentRow {
  document_id: string;
  current_content_id: string;
  created_at: string;
}
interface SchemeRow {
  scheme_id: string;
  uri: string;
}
interface ConceptRow {
  concept_id: string;
  scheme_id: string;
  notation?: string;
}
interface LinkRow {
  to_id: string;
  valid_from: string;
}
interface ContentRow {
  content_id: string;
  media_type?: string | null;
  byte_size?: number | null;
  content_uri?: string | null;
  created_at?: string;
}

export default async ({ input, ctx }: HandlerArgs) => {
  const purpose = 'dpv:ServiceProvision';
  const documentId = String(input?.document_id ?? '');
  if (!documentId) return { versions: [] };
  try {
    const docRes = await ctx.vault.read({
      entity: 'core.document',
      where: [{ column: 'document_id', op: 'eq', value: documentId }],
      limit: 1,
      purpose,
    });
    const doc = ((docRes.rows ?? []) as unknown as DocumentRow[])[0];
    if (!doc) return { versions: [] };

    const [schemes, concepts] = await Promise.all([
      ctx.vault.read({ entity: 'core.concept_scheme', purpose }),
      ctx.vault.read({ entity: 'core.concept', purpose }),
    ]);
    const relScheme = ((schemes.rows ?? []) as unknown as SchemeRow[]).find(
      (s) => s.uri === RELATIONS_SCHEME_URI,
    );
    const revisesConceptId = relScheme
      ? ((concepts.rows ?? []) as unknown as ConceptRow[]).find(
          (c) => c.scheme_id === relScheme.scheme_id && c.notation === REVISES_RELATION,
        )?.concept_id
      : undefined;

    // No `revises` concept yet means nothing has ever been edited/replaced/
    // restored in this vault — every document is its own one-entry history.
    const chainIds = [doc.current_content_id];
    const assertedAtOf = new Map<string, string>(); // content_id -> the outgoing edge's valid_from
    if (revisesConceptId) {
      const seen = new Set([doc.current_content_id]);
      let cur = doc.current_content_id;
      for (let step = 0; step < MAX_CHAIN_STEPS; step += 1) {
        const links = await ctx.vault.read({
          entity: 'core.link',
          where: [
            { column: 'from_type', op: 'eq', value: 'core.content_item' },
            { column: 'from_id', op: 'eq', value: cur },
            { column: 'to_type', op: 'eq', value: 'core.content_item' },
            { column: 'relation_concept_id', op: 'eq', value: revisesConceptId },
            { column: 'valid_to', op: 'is-null' },
          ],
          orderBy: { column: 'valid_from', dir: 'desc' },
          limit: 5,
          purpose,
        });
        const next = ((links.rows ?? []) as unknown as LinkRow[])[0];
        if (!next || seen.has(next.to_id)) break;
        assertedAtOf.set(cur, next.valid_from);
        chainIds.push(next.to_id);
        seen.add(next.to_id);
        cur = next.to_id;
      }
    }

    const contents = await ctx.vault.read({
      entity: 'core.content_item',
      where: [{ column: 'content_id', op: 'in', value: chainIds }],
      purpose,
    });
    const contentById = new Map(
      ((contents.rows ?? []) as unknown as ContentRow[]).map((c) => [c.content_id, c]),
    );

    const srcOf = (c: ContentRow | undefined) =>
      typeof c?.content_uri === 'string' && c.content_uri.startsWith('blob:')
        ? `/centraid/_vault/blobs/${c.content_id}`
        : c?.content_uri;
    const posterOf = (c: ContentRow | undefined) =>
      typeof c?.content_uri === 'string' && c.content_uri.startsWith('blob:')
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
        // The oldest entry (no outgoing edge — it was never a supersession)
        // dates from its own mint; every other entry dates from the moment
        // the edge above it was asserted.
        asserted_at: assertedAtOf.get(id) ?? c?.created_at ?? doc.created_at,
      };
    });

    return { versions };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { versions: [], vaultDenied: { code: e.code, message: e.message } };
  }
};
