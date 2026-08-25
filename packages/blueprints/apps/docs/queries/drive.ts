/**
 * The drive as a bounded recent window: folders are SKOS concepts in the
 * owner's folders scheme (uri https://centraid.dev/schemes/folders, whose
 * 'root' concept is the drive's top level), and a document is a core.document
 * wrapper (#352) carrying exactly one folders-scheme tag — identity is
 * the wrapper, never the content item it currently points at. Vault data has
 * no upper bound (#262), so documents arrive newest-filed-first via
 * their tags (caller-sized, default 200) — never a whole-table content pull;
 * anything older is reachable through the FTS search query or by growing the
 * window (`truncated` tells the UI to offer that). Trashed documents
 * (deleted_at set) keep their tag so a restore lands them back where they
 * were; they ride the same window with trashed=true and their purge date.
 * Starred is a flags-scheme tag on the wrapper (#274), decorated from
 * one bounded read over the windowed ids — the same star a favorited photo
 * carries. Each row's media_type/byte_size come from a join to whichever
 * content item is currently canonical (current_content_id) — older versions
 * are a separate read (the history query), never shipped here. Everything
 * comes from the vault; this app holds no rows of its own.
 *
 * Two more bounded joins live in ./_shared.ts, since search.ts needs the
 * identical pair (#352): `tags` (free-form
 * labels over the shared "Tags" scheme, core.tag_item/untag_item) and
 * `custody_state` (the blob custody projection, local-only/replicated/
 * remote-only/missing/absent) keyed off each row's current_content_id.
 * A third is `shared_with` (#821): the live commons grants over each
 * document and over the folders above it — decoration over the same window,
 * `null` where the share reads are denied rather than a failed drive.
 */

import {
  readCustodyByContent,
  readLabelsByDocument,
  readSharesByDocument,
} from "./_shared.ts";
import type { ConceptRow, SchemeRow, TagRow } from "./_shared.ts";

const FOLDER_SCHEME_URI = "https://centraid.dev/schemes/folders";
const FLAGS_SCHEME_URI = "https://centraid.dev/schemes/flags";
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
    // Structural reads first: concepts and schemes are owner-curated and
    // small, so they stay unbounded — and they bound everything below.
    const [concepts, schemes] = await Promise.all([
      ctx.vault.read({ entity: "core.concept", purpose }),
      ctx.vault.read({ entity: "core.concept_scheme", purpose }),
    ]);
    const conceptRows = (concepts.rows ?? []) as unknown as ConceptRow[];
    const schemeRows = (schemes.rows ?? []) as unknown as SchemeRow[];

    const scheme = schemeRows.find((s) => s.uri === FOLDER_SCHEME_URI);
    const schemeConcepts = conceptRows.filter(
      (c) => scheme && c.scheme_id === scheme.scheme_id
    );
    const root = schemeConcepts.find((c) => c.notation === "root");
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

    // A document is a wrapper tagged with a folders-scheme concept, so the
    // tags ARE the drive's index: one per document, newest filed first. An
    // `in` filter with an empty array throws — no folders scheme yet means
    // an empty drive, not an error.
    const folderConceptIds = schemeConcepts.map((c) => c.concept_id);
    if (folderConceptIds.length === 0) {
      return {
        folders,
        documents: [],
        root_folder_id: rootFolderId,
        truncated: false,
        window,
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
    if (folderByDoc.size === 0) {
      return {
        folders,
        documents: [],
        root_folder_id: rootFolderId,
        truncated: false,
        window,
      };
    }

    // Starred is a flags-scheme tag on the wrapper (#274) — one
    // bounded read over the windowed ids. No scheme or concept yet just
    // means nothing has ever been starred.
    const flagsScheme = schemeRows.find((s) => s.uri === FLAGS_SCHEME_URI);
    const starredConcept = flagsScheme
      ? conceptRows.find(
          (c) =>
            c.scheme_id === flagsScheme.scheme_id && c.notation === "starred"
        )
      : undefined;

    // The wrapper join is `in`-bounded by the windowed tags — only the
    // documents in the window ever ride the RPC, never every wrapper in the
    // vault. Free-form labels (#352) ride the same window.
    // Shares (#821) ride the same window: the grants over these
    // documents and over the folders above them, decorating rows that were
    // already selected. A denial comes back as `null` rather than an error —
    // the scopes are new, so on an existing vault they park for approval and
    // the drive must still answer (./_shared.ts).
    const windowedIds = [...folderByDoc.keys()];
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

    // The current content join is bounded by the windowed wrappers' own
    // current_content_id set — media_type/byte_size come from whichever
    // content item is canonical right now, never the whole content table.
    // Custody (#352) rides the same content id set.
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

    // Blob-backed bytes (#296) leave the row as `blob:` addresses —
    // the client gets same-origin serve URLs (Range, immutable caching, and
    // iframe-able PDF previews); inline data: URIs pass through.
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
          // The current content item's id — blob/preview URLs and the
          // version-history "is this the current one?" comparison both key
          // off it, but selection/details/quick-look identity is the
          // document_id above, which never changes across an edit.
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
          tags: tagsByDoc.get(d.document_id) ?? [],
          custody_state: custodyByContent.get(d.current_content_id) ?? null,
          // `null` is "the share reads were denied", which the rail words
          // differently from `[]`, "shared with nobody".
          shared_with:
            sharesByDoc === null
              ? null
              : (sharesByDoc.get(d.document_id) ?? []),
        };
      })
      .toSorted((a, b) =>
        String(b.created_at).localeCompare(String(a.created_at))
      );

    // A full window means there may be older documents beyond it — the UI
    // offers "Show more" (a re-read with a larger window) and search.
    const truncated = tagRows.length >= window;
    return {
      folders,
      documents,
      root_folder_id: rootFolderId,
      truncated,
      window,
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
