/**
 * A BOUNDED recent window (#262): documents arrive newest-filed-first via their
 * folders-scheme tags, never a whole-table pull. Identity is the core.document
 * wrapper (#352), not the content item it points at, and every decoration is
 * `in`-bounded by the same window.
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
import { inList, readPages } from "../../_shared/paged-reads.ts";
import {
  ownerKey,
  readRepresentations,
} from "../../_shared/representation-reads.ts";
import { conceptTaxonomyReads } from "../../_shared/taxonomy-reads.ts";
import {
  readCustodyByContent,
  readLabelsByDocument,
  readSharesByDocument,
} from "./_shared.ts";
import type { ConceptRow, SchemeRow, TagRow } from "./_shared.ts";
import { readOriginsByDocument } from "./document-origins.ts";

const DOCUMENT_TARGET_TYPE = "core.document";

interface DocumentRow {
  document_id: string;
  current_content_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  purge_at?: string | null;
}
interface ContentRow {
  content_id: string;
  byte_size?: number | null;
  content_uri?: string | null;
}

export default async function driveHandler({ input, ctx }: HandlerArgs) {
  const window = Math.min(Math.max(Number(input?.limit) || 200, 20), 2000);
  try {
    // Owner-curated and small, so unbounded; they bound the rest.
    const [concepts, schemes] = await Promise.all(conceptTaxonomyReads(ctx));
    const conceptRows = concepts as unknown as ConceptRow[];
    const schemeRows = schemes as unknown as SchemeRow[];

    const scheme = findScheme(schemeRows, FOLDER_SCHEME_URI);
    const schemeConcepts = conceptsInScheme(conceptRows, scheme);
    const root = findConcept(schemeConcepts, scheme, ROOT_FOLDER_NOTATION);
    const rootFolderId = root?.concept_id ?? null;

    const folders = schemeConcepts
      .filter((c) => c.concept_id !== rootFolderId)
      .map((c) => ({
        folder_id: c.concept_id,
        name: c.pref_label,
        parent_id:
          c.broader_concept_id == null || c.broader_concept_id === rootFolderId
            ? null
            : c.broader_concept_id,
      }))
      .toSorted((a, b) => String(a.name).localeCompare(String(b.name)));

    // A DELIVERED copy carries no folders-scheme tag, so the tag window below
    // cannot see it: its subscription lineage is the second door in (#903).
    //
    // READ BEFORE THE FOLDERS-SCHEME GATE: the scheme is created on first use,
    // so a member who has never filed a document of their own has none — and
    // returning early there told someone who HAD received one that nothing
    // arrived, which is the exact claim this door exists to prevent.
    const originByDoc = await readOriginsByDocument({
      ctx,
      limit: window,
    });

    // An `in` filter with an empty array throws; no scheme, no filed documents.
    const folderConceptIds = schemeConcepts.map((c) => c.concept_id);
    // THE DRIVE'S WINDOW IS A PAGE (#996 wave 4, R8). This is the read that
    // DISCOVERS the rows; everything below joins over what it returned.
    const conceptIn =
      folderConceptIds.length === 0
        ? null
        : inList("concept_id", folderConceptIds);
    const tagPage = conceptIn
      ? await ctx.vault.page<TagRow>({
          query: {
            name: "docs.drive.filed",
            select: "tag_id, target_id, concept_id, target_type, tagged_at",
            from: "core_tag",
            where: `target_type = ? AND ${conceptIn.sql}`,
            bind: [DOCUMENT_TARGET_TYPE, ...conceptIn.bind],
            order: {
              sortColumn: "tagged_at",
              pkColumn: "tag_id",
              descending: true,
            },
          },
          limit: window,
        })
      : { rows: [] as TagRow[] };
    const tagRows = tagPage.rows;

    const folderByDoc = new Map<string, string>();
    for (const t of tagRows) folderByDoc.set(t.target_id, t.concept_id);
    const windowedIds = [
      ...new Set([...folderByDoc.keys(), ...(originByDoc?.keys() ?? [])]),
    ];
    if (windowedIds.length === 0) {
      return {
        folders,
        documents: [],
        root_folder_id: rootFolderId,
        truncated: false,
        window,
        shared_from_known: originByDoc !== null,
      };
    }

    // Starred is a flags-scheme tag (#274): no concept, never starred.
    const starredConcept = findSchemeConcept(
      schemeRows,
      conceptRows,
      FLAGS_SCHEME_URI,
      STARRED_NOTATION
    );

    // A share denial returns `null`, not an error: the drive still answers
    // while those scopes park for approval (#821).
    const windowedIn = inList("document_id", windowedIds);
    const starredIn = inList("target_id", windowedIds);
    const [documentRows, starTagRows, tagsByDoc, sharesByDoc] =
      await Promise.all([
        // Bounded by the window's own ids, and walked to the end of that set.
        readPages<DocumentRow>(ctx, {
          name: "docs.drive.documents",
          select:
            "document_id, current_content_id, title, created_at, updated_at, deleted_at, purge_at",
          from: "core_document",
          where: windowedIn.sql,
          bind: windowedIn.bind,
          order: {
            sortColumn: "document_id",
            pkColumn: "document_id",
            descending: false,
          },
        }),
        starredConcept
          ? readPages<TagRow>(ctx, {
              name: "docs.drive.starred",
              select: "tag_id, target_id, concept_id",
              from: "core_tag",
              where: `concept_id = ? AND target_type = ? AND ${starredIn.sql}`,
              bind: [
                starredConcept.concept_id,
                DOCUMENT_TARGET_TYPE,
                ...starredIn.bind,
              ],
              order: {
                sortColumn: "tag_id",
                pkColumn: "tag_id",
                descending: false,
              },
            })
          : Promise.resolve([] as TagRow[]),
        readLabelsByDocument({
          ctx,
          documentIds: windowedIds,
          schemes: schemeRows,
          concepts: conceptRows,
        }),
        readSharesByDocument({
          ctx,
          documentIds: windowedIds,
          folderByDoc,
          folderConcepts: schemeConcepts,
        }),
      ]);
    const starredIds = new Set(starTagRows.map((t) => t.target_id));

    // Bounded by the wrappers' current_content_id set (#352).
    const contentIds = [
      ...new Set(documentRows.map((d) => d.current_content_id)),
    ];
    const [contentRows, custodyByContent, representations] = await Promise.all([
      contentIds.length > 0
        ? readPages<ContentRow>(ctx, {
            name: "docs.drive.contents",
            select: "content_id, byte_size, content_uri",
            from: "core_content_item",
            where: inList("content_id", contentIds).sql,
            bind: inList("content_id", contentIds).bind,
            order: {
              sortColumn: "content_id",
              pkColumn: "content_id",
              descending: false,
            },
          })
        : Promise.resolve([] as ContentRow[]),
      readCustodyByContent({ ctx, contentIds }),
      // The byte row carries no media type since #996 (R20(b)) — THIS
      // document's representation says what it reads those bytes as.
      readRepresentations({ ctx, contentIds }),
    ]);
    const contentById = new Map(contentRows.map((c) => [c.content_id, c]));

    // Blob bytes (#296) serve as same-origin URLs so Range and caching work;
    // data: URIs pass through.
    const srcOf = (c: ContentRow | undefined) =>
      typeof c?.content_uri === "string" && c.content_uri.startsWith("blob:")
        ? `/centraid/_vault/blobs/${c.content_id}`
        : c?.content_uri;
    const posterOf = (c: ContentRow | undefined) =>
      typeof c?.content_uri === "string" && c.content_uri.startsWith("blob:")
        ? `/centraid/_vault/blobs/${c.content_id}?variant=poster`
        : null;

    const documents = documentRows
      .map((d) => {
        const conceptId = folderByDoc.get(d.document_id);
        const c = contentById.get(d.current_content_id);
        return {
          document_id: d.document_id,
          content_id: d.current_content_id,
          title: d.title,
          media_type:
            representations.byOwner.get(
              ownerKey(DOCUMENT_TARGET_TYPE, d.document_id)
            ) ?? null,
          byte_size: c?.byte_size ?? null,
          content_uri: srcOf(c),
          poster_uri: posterOf(c),
          created_at: d.created_at,
          updated_at: d.updated_at,
          folder_id:
            conceptId === undefined || conceptId === rootFolderId
              ? null
              : conceptId,
          starred: starredIds.has(d.document_id),
          trashed: d.deleted_at != null,
          purge_at: d.purge_at ?? null,
          tags: tagsByDoc.get(d.document_id) ?? [],
          custody_state: custodyByContent.get(d.current_content_id) ?? null,
          // `null` is "reads denied"; `[]` is "shared with nobody".
          shared_with:
            sharesByDoc === null
              ? null
              : (sharesByDoc.get(d.document_id) ?? []),
          shared_from: originByDoc?.get(d.document_id) ?? null,
        };
      })
      .toSorted((a, b) =>
        String(b.created_at).localeCompare(String(a.created_at))
      );

    // THE PAGE ANSWERS THIS, NOT A GUESS AT IT (#996 wave 4). `length >= window`
    // cannot tell a window that filled exactly from one that ran out; a cursor
    // exists or it does not, and it is also where to carry on from.
    const truncated = "next" in tagPage && tagPage.next !== undefined;
    return {
      folders,
      documents,
      root_folder_id: rootFolderId,
      truncated,
      window,
      // ABSENT IS NOT EMPTY: a denied read is told, not drawn.
      shared_from_known: originByDoc !== null,
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      folders: [],
      documents: [],
      root_folder_id: null,
      vaultDenied: { code: e.code, message: e.message },
    };
  }
}
