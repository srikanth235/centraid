/**
 * Document search as a vault projection: FTS5 matches `core.document`
 * (#352), hits join folder tags/custody exactly like drive.ts (factored into
 * ./_shared.ts, `shared_with` #821 included), trashed rows never match, and
 * a match must carry a folders-scheme tag. Consent denial renders as the
 * ask-the-owner state.
 */

import {
  FLAGS_SCHEME_URI,
  FOLDER_SCHEME_URI,
  ROOT_FOLDER_NOTATION,
  STARRED_NOTATION,
  conceptsInScheme,
  findConcept,
  findScheme,
  findSchemeConcept,
} from "../../_shared/concept-scheme-kit.ts";
import { conceptTaxonomyReads } from "../../_shared/taxonomy-reads.ts";
import {
  readCustodyByContent,
  readLabelsByDocument,
  readSharesByDocument,
} from "./_shared.ts";
import type { ConceptRow, SchemeRow, TagRow } from "./_shared.ts";

const DOCUMENT_TARGET_TYPE = "core.document";

interface SearchHit {
  document_id: string;
  current_content_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  purge_at?: string | null;
  _snippet?: string;
}
interface ContentRow {
  content_id: string;
  media_type?: string | null;
  byte_size?: number | null;
  content_uri?: string | null;
}

export default async function searchHandler({ input, ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  const term = String(input?.term ?? "").trim();
  if (!term) return { documents: [] };
  try {
    const matches = await ctx.vault.search({
      entity: "core.document",
      query: term,
      limit: 100,
      purpose,
    });
    const hits = (matches.rows ?? []) as unknown as SearchHit[];
    if (hits.length === 0) return { documents: [] };
    const documentIds = hits.map((d) => d.document_id);
    const [tags, concepts, schemes] = await Promise.all([
      ctx.vault.read({
        acceptTruncation: true,
        entity: "core.tag",
        where: [
          { column: "target_type", op: "eq", value: DOCUMENT_TARGET_TYPE },
          { column: "target_id", op: "in", value: documentIds },
        ],
        purpose,
      }),
      ...conceptTaxonomyReads(ctx.vault, purpose),
    ]);
    const tagRows = (tags.rows ?? []) as unknown as TagRow[];
    const conceptRows = (concepts.rows ?? []) as unknown as ConceptRow[];
    const schemeRows = (schemes.rows ?? []) as unknown as SchemeRow[];
    // Free-form labels (#352) reuse ./_shared.ts's helper; a small bounded
    // read over the same matched ids.
    const tagsByDoc = await readLabelsByDocument({
      ctx,
      purpose,
      documentIds,
      schemes: schemeRows,
      concepts: conceptRows,
    });

    const scheme = findScheme(schemeRows, FOLDER_SCHEME_URI);
    const schemeConcepts = conceptsInScheme(conceptRows, scheme);
    const rootFolderId =
      findConcept(schemeConcepts, scheme, ROOT_FOLDER_NOTATION)?.concept_id ??
      null;

    // A document is a wrapper tagged with a folders-scheme concept.
    const folderConceptIds = new Set(schemeConcepts.map((c) => c.concept_id));
    const folderByDoc = new Map<string, string>();
    for (const t of tagRows) {
      if (folderConceptIds.has(t.concept_id))
        folderByDoc.set(t.target_id, t.concept_id);
    }

    // Starred rides the tag read already in hand (#274).
    const starredConceptId =
      findSchemeConcept(
        schemeRows,
        conceptRows,
        FLAGS_SCHEME_URI,
        STARRED_NOTATION
      )?.concept_id ?? null;
    const starredIds = new Set(
      tagRows
        .filter(
          (t) => starredConceptId != null && t.concept_id === starredConceptId
        )
        .map((t) => t.target_id)
    );

    // Bounded by the matched wrappers' current_content_id set, custody too.
    const contentIds = [...new Set(hits.map((d) => d.current_content_id))];
    const [contents, custodyByContent, sharesByDoc] = await Promise.all([
      contentIds.length > 0
        ? ctx.vault.read({
            acceptTruncation: true,
            entity: "core.content_item",
            where: [{ column: "content_id", op: "in", value: contentIds }],
            purpose,
          })
        : { rows: [] as Record<string, unknown>[] },
      readCustodyByContent({ ctx, purpose, contentIds }),
      // Shares (#821) bounded by matched documents; same join drive.ts makes.
      readSharesByDocument({
        ctx,
        purpose,
        documentIds: [...folderByDoc.keys()],
        folderByDoc,
        folderConcepts: schemeConcepts,
      }),
    ]);
    const contentById = new Map(
      ((contents.rows ?? []) as unknown as ContentRow[]).map((c) => [
        c.content_id,
        c,
      ])
    );

    // Blob-backed bytes serve as same-origin URLs (#296).
    const srcOf = (c: ContentRow | undefined) =>
      typeof c?.content_uri === "string" && c.content_uri.startsWith("blob:")
        ? `/centraid/_vault/blobs/${c.content_id}`
        : c?.content_uri;
    const posterOf = (c: ContentRow | undefined) =>
      typeof c?.content_uri === "string" && c.content_uri.startsWith("blob:")
        ? `/centraid/_vault/blobs/${c.content_id}?variant=poster`
        : null;

    // Vault order is rank order (best match first) — keep it.
    const documents = hits
      .filter((d) => folderByDoc.has(d.document_id))
      .map((d) => {
        const conceptId = folderByDoc.get(d.document_id);
        const c = contentById.get(d.current_content_id);
        return {
          document_id: d.document_id,
          content_id: d.current_content_id,
          title: d.title,
          media_type: c?.media_type ?? null,
          byte_size: c?.byte_size ?? null,
          content_uri: srcOf(c),
          poster_uri: posterOf(c),
          created_at: d.created_at,
          updated_at: d.updated_at,
          folder_id: conceptId === rootFolderId ? null : conceptId,
          starred: starredIds.has(d.document_id),
          trashed: d.deleted_at != null,
          purge_at: d.purge_at ?? null,
          snippet: typeof d._snippet === "string" ? d._snippet : "",
          tags: tagsByDoc.get(d.document_id) ?? [],
          custody_state: custodyByContent.get(d.current_content_id) ?? null,
          shared_with:
            sharesByDoc === null
              ? null
              : (sharesByDoc.get(d.document_id) ?? []),
        };
      });
    return { documents };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { documents: [], vaultDenied: { code: e.code, message: e.message } };
  }
}
