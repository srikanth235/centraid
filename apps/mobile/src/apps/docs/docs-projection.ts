// The drive, projected from the phone's replica rows (#821) — the same joins
// the web `drive` query runs gateway-side, re-expressed pure and testable here.
// Nothing is fabricated: every field is a replica fact or `null` where the
// replica cannot say ("unknown" ≠ "shared with nobody"). No react-native or
// replica imports beyond the provenance readers (docs-projection.test.ts).

import { DAY_MS } from "@centraid/blueprints/apps/_shared/format-kit";
import {
  canRender,
  fmtBytes,
  fmtDate,
  typeMeta,
} from "@centraid/blueprints/apps/docs/format";
import type {
  DocTag,
  DriveDoc,
  Folder,
  SortKey,
} from "@centraid/blueprints/apps/docs/types";
import { rowStateMark } from "@centraid/blueprints/apps/docs/view-copy";
import type { RowStateMark } from "@centraid/blueprints/apps/docs/view-copy";

import { rowCanWrite, rowScopeLabels } from "../../kit/replica/row-provenance";
import {
  DOCUMENT_TARGET_TYPE,
  FLAGS_SCHEME_URI,
  FOLDER_SCHEME_URI,
  num,
  str,
  TAGS_SCHEME_URI,
} from "./docs-projection-rows";
import type { EntityRow } from "./docs-projection-rows";
import { originsByDocument, sharesByDocument } from "./docs-projection-shares";
import type {
  OriginEntityRows,
  ShareEntityRows,
} from "./docs-projection-shares";

// The sharing half lives next door (`docs-projection-shares.ts`) but is one
// projection to every caller, so its names are re-exported here rather than
// making each importer know which half a type came from.
export {
  originsByDocument,
  sharesByDocument,
  type OriginEntityRows,
  type ShareEntityRows,
} from "./docs-projection-shares";
export { type EntityRow } from "./docs-projection-rows";

/** A drive row plus the phone-only facts: a folder tag pointing at a gone
 *  concept (§4.3), and the DOCUMENT row's provenance/pending stamps (#880). */
export type MobileDriveDoc = DriveDoc & {
  folderGone: boolean;
  canWrite: boolean;
  scopeLabels: readonly string[];
  raw: EntityRow;
};

export interface DriveEntityRows {
  documents: readonly EntityRow[];
  contents: readonly EntityRow[];
  tags: readonly EntityRow[];
  concepts: readonly EntityRow[];
  schemes: readonly EntityRow[];
  custody: readonly EntityRow[];
  /** `null` when any share read was denied/failed — every row then carries
   *  `shared_with: null`, as the web query ships too. */
  shares: ShareEntityRows | null;
  /** `null` when the placement-origin read was denied/failed. Distinct from
   *  an empty list: the Shared shelf must never draw "nothing was shared with
   *  you" over a read that never answered. */
  origins: OriginEntityRows | null;
}

export interface DriveProjection {
  documents: MobileDriveDoc[];
  folders: Folder[];
  rootFolderId: string | null;
  /** Active (untrashed) documents at the drive's top level — Unfiled. */
  unfiledCount: number;
  /** Whether the placement-origin read ANSWERED. False means the Shared shelf
   *  knows nothing, which is not the same as knowing the set is empty. */
  sharedFromKnown: boolean;
}

/**
 * The whole projection: folders from the folders scheme (root = unfiled),
 * one folder tag per document, starred/labels from flags/tags schemes,
 * content join, custody by content id, commons-shares join.
 */
export function projectDrive(rows: DriveEntityRows): DriveProjection {
  const schemeByUri = new Map(
    rows.schemes.flatMap((scheme) => {
      const uri = str(scheme, "uri");
      const id = str(scheme, "scheme_id");
      return uri && id ? [[uri, id] as const] : [];
    })
  );
  const foldersSchemeId = schemeByUri.get(FOLDER_SCHEME_URI) ?? null;
  const flagsSchemeId = schemeByUri.get(FLAGS_SCHEME_URI) ?? null;
  const tagsSchemeId = schemeByUri.get(TAGS_SCHEME_URI) ?? null;

  const folderConcepts = rows.concepts.filter(
    (concept) => str(concept, "scheme_id") === foldersSchemeId
  );
  const rootFolderId =
    folderConcepts.flatMap((concept) =>
      str(concept, "notation") === "root"
        ? [str(concept, "concept_id") ?? ""]
        : []
    )[0] ?? null;
  const folders: Folder[] = folderConcepts
    .flatMap((concept) => {
      const id = str(concept, "concept_id");
      if (!id || id === rootFolderId) return [];
      const broader = str(concept, "broader_concept_id");
      return [
        {
          folder_id: id,
          name: str(concept, "pref_label") ?? "Folder",
          parent_id: broader === rootFolderId ? null : broader,
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const folderConceptIds = new Set(
    folderConcepts.flatMap((concept) => {
      const id = str(concept, "concept_id");
      return id ? [id] : [];
    })
  );
  const liveConceptIds = new Set(
    rows.concepts.flatMap((concept) => {
      const id = str(concept, "concept_id");
      return id ? [id] : [];
    })
  );
  const starredConceptId =
    rows.concepts.flatMap((concept) =>
      str(concept, "scheme_id") === flagsSchemeId &&
      str(concept, "notation") === "starred"
        ? [str(concept, "concept_id") ?? ""]
        : []
    )[0] ?? null;
  const labelByConcept = new Map(
    rows.concepts.flatMap((concept) => {
      if (str(concept, "scheme_id") !== tagsSchemeId) return [];
      const id = str(concept, "concept_id");
      const label = str(concept, "pref_label") ?? str(concept, "notation");
      return id && label ? [[id, label] as const] : [];
    })
  );

  // One pass over tag edges, by concept scheme.
  const folderByDoc = new Map<string, string>();
  const orphanTagDocs = new Set<string>();
  const starredDocs = new Set<string>();
  const labelsByDoc = new Map<string, DocTag[]>();
  for (const tag of rows.tags) {
    if (str(tag, "target_type") !== DOCUMENT_TARGET_TYPE) continue;
    const docId = str(tag, "target_id");
    const conceptId = str(tag, "concept_id");
    const tagId = str(tag, "tag_id");
    if (!docId || !conceptId) continue;
    if (folderConceptIds.has(conceptId)) {
      folderByDoc.set(docId, conceptId);
    } else if (conceptId === starredConceptId) {
      starredDocs.add(docId);
    } else if (labelByConcept.has(conceptId)) {
      const entry: DocTag = {
        tag_id: tagId ?? "",
        label: labelByConcept.get(conceptId) ?? "",
      };
      const list = labelsByDoc.get(docId);
      if (list) list.push(entry);
      else labelsByDoc.set(docId, [entry]);
    } else if (!liveConceptIds.has(conceptId)) {
      // Nothing on the other end — the named folder/scheme was deleted.
      // Only claimed when the doc has NO live folder tag (below).
      orphanTagDocs.add(docId);
    }
  }

  const contentById = new Map(
    rows.contents.flatMap((content) => {
      const id = str(content, "content_id");
      return id ? [[id, content] as const] : [];
    })
  );
  const custodyByContent = new Map(
    rows.custody.flatMap((row) => {
      const id = str(row, "content_id");
      const state = str(row, "custody_state");
      return id && state ? [[id, state] as const] : [];
    })
  );

  const documentIds = rows.documents.flatMap((doc) => {
    const id = str(doc, "document_id");
    return id ? [id] : [];
  });
  const sharesByDoc =
    rows.shares === null
      ? null
      : sharesByDocument(rows.shares, {
          documentIds,
          folderByDoc,
          folderConcepts,
        });
  const originByDoc =
    rows.origins === null ? null : originsByDocument(rows.origins);

  const documents: MobileDriveDoc[] = rows.documents
    .flatMap((doc) => {
      const id = str(doc, "document_id");
      const contentId = str(doc, "current_content_id");
      if (!id || !contentId) return [];
      const content = contentById.get(contentId);
      const folderConcept = folderByDoc.get(id) ?? null;
      const contentUri = content ? str(content, "content_uri") : null;
      return [
        {
          document_id: id,
          content_id: contentId,
          title: str(doc, "title") ?? "Untitled document",
          media_type: content ? str(content, "media_type") : null,
          byte_size: content ? num(content, "byte_size") : null,
          ...(contentUri ? { content_uri: contentUri } : {}),
          poster_uri: null,
          created_at: str(doc, "created_at") ?? "",
          updated_at: str(doc, "updated_at") ?? "",
          folder_id: folderConcept === rootFolderId ? null : folderConcept,
          starred: starredDocs.has(id),
          trashed: str(doc, "deleted_at") !== null,
          purge_at: str(doc, "purge_at"),
          tags: labelsByDoc.get(id) ?? [],
          custody_state: custodyByContent.get(contentId) ?? null,
          shared_with:
            sharesByDoc === null ? null : (sharesByDoc.get(id) ?? []),
          shared_from: originByDoc?.get(id) ?? null,
          folderGone: folderConcept === null && orphanTagDocs.has(id),
          canWrite: rowCanWrite(doc),
          scopeLabels: rowScopeLabels(doc),
          raw: doc,
        },
      ];
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  const unfiledCount = documents.filter(
    (doc) => !doc.trashed && doc.folder_id === null && !doc.folderGone
  ).length;

  return {
    documents,
    folders,
    rootFolderId,
    unfiledCount,
    sharedFromKnown: originByDoc !== null,
  };
}

// Shares — the same bounded join `queries/_shared.ts` runs gateway-side.
// `null` never leaves this function.

// The row's one state slot (§4.1) — the shared ladder, fed with phone facts.

/** Days until purge, or `null` when the vault never asserted one — the slot
 *  stays blank rather than printing a number nobody computed. */
export function purgeDaysLeft(
  purgeAt: string | null | undefined,
  now: number = Date.now()
): number | null {
  if (!purgeAt) return null;
  const stamp = Date.parse(purgeAt);
  if (Number.isNaN(stamp)) return null;
  return Math.max(0, Math.ceil((stamp - now) / DAY_MS));
}

/** POSITIVELY elsewhere? Only `remote-only`/`missing` say so; unswept
 *  (`null`) custody is unknown — never invent a refusal over unknown. */
export function bytesOnDevice(doc: Pick<DriveDoc, "custody_state">): boolean {
  return doc.custody_state !== "remote-only" && doc.custody_state !== "missing";
}

/**
 * State slot precedence: cannot render → trash countdown → remote-only
 * (offline) → custody mark. The ladder is the shared `rowStateMark`
 * (view-copy.ts), so web and phone cannot disagree.
 */
export function docRowState(
  doc: Pick<
    DriveDoc,
    "media_type" | "title" | "trashed" | "purge_at" | "custody_state"
  >,
  { offline, now }: { offline: boolean; now?: number }
): RowStateMark | null {
  return rowStateMark({
    cannotRender: !canRender(doc),
    inTrash: doc.trashed,
    purgeInDays: purgeDaysLeft(doc.purge_at, now),
    offline,
    bytesOnDevice: bytesOnDevice(doc),
    deviceOnly: doc.custody_state === "local-only",
  });
}

/** The row's second line, split so the state rung can keep its own colour. */
export interface RowMeta {
  /** The state slot's TEXT rung, leading the line; `null` when there is none. */
  lead: string | null;
  /** That rung is consequential (`--net`) and must not be drawn as chrome. */
  leadNet: boolean;
  /** Kind, size and date — the facts, in the handoff's order. */
  rest: string;
}

/**
 * The row's SECOND LINE — the kind, the size and the date.
 *
 * The v12 handoff withheld these on the phone as COLUMNS ("a 390px canvas
 * cannot carry five columns and a title"), and the row carried that forward as
 * a blanket absence. The reasoning does not survive the shape actually drawn
 * here: a stacked sub-line is not a column. Without it every row is a bare
 * title, which is precisely how a drive of a few thousand documents stops
 * being readable — two documents named alike become indistinguishable without
 * opening one, and a kind this seat cannot render announces itself only after
 * the tap that fails.
 *
 * The state slot's TEXT rung LEADS this line instead of holding a column of
 * its own: "cannot be shown" is a fact about the document and belongs beside
 * its kind, and folding it in returns that width to the title. GLYPH rungs
 * (the device mark) stay on the trailing edge — a glyph is not prose and
 * cannot join a sentence. The ladder still yields at most one mark, so the
 * row still shows at most one state.
 */
export function docRowMeta(
  doc: Pick<
    DriveDoc,
    "media_type" | "title" | "byte_size" | "updated_at" | "created_at"
  >,
  mark: RowStateMark | null
): RowMeta {
  const parts = [typeMeta(doc.media_type, doc.title).name];
  // `fmtBytes` answers an em dash where the replica has no byte count. A dash
  // sitting between two real facts reads as a value, so the segment is dropped
  // rather than printed as an absence nobody asked about.
  const size = fmtBytes(doc.byte_size);
  if (size !== "—") parts.push(size);
  const date = fmtDate(doc.updated_at || doc.created_at);
  if (date) parts.push(date);
  return {
    lead: mark?.kind === "text" ? mark.text : null,
    leadNet: mark?.kind === "text" && mark.net === true,
    rest: parts.join(" · "),
  };
}

// Sort (§4.1's remembered orders)

export function sortDocuments<T extends DriveDoc>(
  docs: readonly T[],
  key: SortKey,
  dir: 1 | -1
): T[] {
  const compare = (a: T, b: T): number => {
    switch (key) {
      case "name":
        return a.title.localeCompare(b.title);
      case "size":
        return (a.byte_size ?? 0) - (b.byte_size ?? 0);
      case "kind":
        return typeMeta(a.media_type, a.title).name.localeCompare(
          typeMeta(b.media_type, b.title).name
        );
      case "changed":
      case "owner":
        // No `owner` order on the phone — one vault — so both keys share
        // changed-newest.
        return (a.updated_at || a.created_at).localeCompare(
          b.updated_at || b.created_at
        );
    }
  };
  return [...docs].sort((a, b) => dir * compare(a, b));
}

/** The kind's mark as a kit `Icon` name — the same registry the web's
 *  `KIND_ICONS` binds, so a kind wears one shape everywhere. */
export function kindIconName(doc: {
  media_type?: string | null;
  title?: string | null;
}): string {
  const { glyph } = typeMeta(doc.media_type, doc.title);
  switch (glyph) {
    case "image":
      return "Image";
    case "sheet":
      return "Table";
    case "media":
      return "Music";
    case "doc":
    case "other":
      return "FileText";
  }
}
