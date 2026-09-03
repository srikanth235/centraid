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
import {
  readCustodyByContent,
  readLabelsByDocument,
  readOriginsByDocument,
  readSharesByDocument,
} from "./_shared.ts";
import type { ConceptRow, SchemeRow, TagRow } from "./_shared.ts";

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
  media_type?: string | null;
  byte_size?: number | null;
  content_uri?: string | null;
}

export default async function driveHandler({ input, ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  const window = Math.min(Math.max(Number(input?.limit) || 200, 20), 2000);
  try {
    const [concepts, schemes] = await Promise.all([
      ctx.vault.read({ entity: "core.concept", purpose }),
      ctx.vault.read({ entity: "core.concept_scheme", purpose }),
    ]);
    const conceptRows = (concepts.rows ?? []) as unknown as ConceptRow[];
    const schemeRows = (schemes.rows ?? []) as unknown as SchemeRow[];

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

    const folderConceptIds = schemeConcepts.map((c) => c.concept_id);
    if (folderConceptIds.length === 0) {
      return {
        folders,
        documents: [],
        root_folder_id: rootFolderId,
        truncated: false,
        window,
        shared_from_known: true,
      };
    }
    const tags = await ctx.vault.read({
      entity: "core.tag",
      where: [
        { column: "target_type", op: "eq", value: DOCUMENT_TARGET_TYPE },
        { column: "concept_id", op: "in", value: folderConceptIds },
      ],
      orderBy: { column: "tagged_at", dir: "desc" },
      limit: window,
      purpose,
    });
    const tagRows = (tags.rows ?? []) as unknown as TagRow[];

    const folderByDoc = new Map<string, string>();
    for (const t of tagRows) folderByDoc.set(t.target_id, t.concept_id);

    const originByDoc = await readOriginsByDocument({
      ctx,
      purpose,
      limit: window,
    });
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

    const starredConcept = findSchemeConcept(
      schemeRows,
      conceptRows,
      FLAGS_SCHEME_URI,
      STARRED_NOTATION
    );

    const [documentsRes, starTags, tagsByDoc, sharesByDoc] = await Promise.all([
      ctx.vault.read({
        entity: "core.document",
        where: [{ column: "document_id", op: "in", value: windowedIds }],
        purpose,
      }),
      starredConcept
        ? ctx.vault.read({
            entity: "core.tag",
            where: [
              {
                column: "concept_id",
                op: "eq",
                value: starredConcept.concept_id,
              },
              { column: "target_type", op: "eq", value: DOCUMENT_TARGET_TYPE },
              { column: "target_id", op: "in", value: windowedIds },
            ],
            purpose,
          })
        : { rows: [] as Record<string, unknown>[] },
      readLabelsByDocument({
        ctx,
        purpose,
        documentIds: windowedIds,
        schemes: schemeRows,
        concepts: conceptRows,
      }),
      readSharesByDocument({
        ctx,
        purpose,
        documentIds: windowedIds,
        folderByDoc,
        folderConcepts: schemeConcepts,
      }),
    ]);
    const starredIds = new Set(
      ((starTags.rows ?? []) as unknown as TagRow[]).map((t) => t.target_id)
    );

    const documentRows = (documentsRes.rows ?? []) as unknown as DocumentRow[];
    const contentIds = [
      ...new Set(documentRows.map((d) => d.current_content_id)),
    ];
    const [contents, custodyByContent] = await Promise.all([
      contentIds.length > 0
        ? ctx.vault.read({
            entity: "core.content_item",
            where: [{ column: "content_id", op: "in", value: contentIds }],
            purpose,
          })
        : { rows: [] as Record<string, unknown>[] },
      readCustodyByContent({ ctx, purpose, contentIds }),
    ]);
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

    const documents = documentRows
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
          folder_id:
            conceptId === undefined || conceptId === rootFolderId
              ? null
              : conceptId,
          starred: starredIds.has(d.document_id),
          trashed: d.deleted_at != null,
          purge_at: d.purge_at ?? null,
          tags: tagsByDoc.get(d.document_id) ?? [],
          custody_state: custodyByContent.get(d.current_content_id) ?? null,
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

    const truncated = tagRows.length >= window;
    return {
      folders,
      documents,
      root_folder_id: rootFolderId,
      truncated,
      window,
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
