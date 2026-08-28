// The drive, projected from the phone's replica rows (#821) — the same joins
// the web `drive` query runs gateway-side, re-expressed pure and testable here.
// Nothing is fabricated: every field is a replica fact or `null` where the
// replica cannot say ("unknown" ≠ "shared with nobody"). No react-native or
// replica imports beyond the provenance readers (docs-projection.test.ts).

import { canRender, typeMeta } from "@centraid/blueprints/apps/docs/format";
import type {
  DocTag,
  DriveDoc,
  Folder,
  SharedMember,
  SharedWith,
  SortKey,
} from "@centraid/blueprints/apps/docs/types";
import { rowStateMark } from "@centraid/blueprints/apps/docs/view-copy";
import type { RowStateMark } from "@centraid/blueprints/apps/docs/view-copy";

import { rowCanWrite, rowScopeLabels } from "../../kit/replica/row-provenance";

/** One replica row, as `useReplicaQuery` hands it over. */
export type EntityRow = Readonly<Record<string, unknown>>;

const FOLDER_SCHEME_URI = "https://centraid.dev/schemes/folders";
const FLAGS_SCHEME_URI = "https://centraid.dev/schemes/flags";
const TAGS_SCHEME_URI = "centraid:tags:v1";
const DOCUMENT_TARGET_TYPE = "core.document";
const FOLDER_CONTAINER_TYPE = "docs.folder";

const str = (row: EntityRow, key: string): string | null => {
  const value = row[key];
  return typeof value === "string" ? value : null;
};
const num = (row: EntityRow, key: string): number | null => {
  const value = row[key];
  return typeof value === "number" ? value : null;
};

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
}

export interface ShareEntityRows {
  grants: readonly EntityRow[];
  circles: readonly EntityRow[];
  members: readonly EntityRow[];
  states: readonly EntityRow[];
  parties: readonly EntityRow[];
}

export interface DriveProjection {
  documents: MobileDriveDoc[];
  folders: Folder[];
  rootFolderId: string | null;
  /** Active (untrashed) documents at the drive's top level — Unfiled. */
  unfiledCount: number;
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

  return { documents, folders, rootFolderId, unfiledCount };
}

// Shares — the same bounded join `queries/_shared.ts` runs gateway-side.
// `null` never leaves this function.

function folderChain(
  conceptId: string | null,
  parentOf: Map<string, string | null>
): string[] {
  const chain: string[] = [];
  let at = conceptId ?? undefined;
  while (at && !chain.includes(at) && chain.length < 64) {
    chain.push(at);
    at = parentOf.get(at) ?? undefined;
  }
  return chain;
}

function shareLabel(
  implicit: boolean,
  circleName: string | null,
  memberLabels: readonly string[]
): string {
  if (!implicit && circleName) return circleName;
  if (memberLabels.length === 0) return circleName ?? "a circle";
  const shown = memberLabels.slice(0, 2).join(" and ");
  const rest = memberLabels.length - 2;
  return rest > 0 ? `${shown} +${rest}` : shown;
}

export function sharesByDocument(
  rows: ShareEntityRows,
  {
    documentIds,
    folderByDoc,
    folderConcepts,
  }: {
    documentIds: readonly string[];
    folderByDoc: ReadonlyMap<string, string>;
    folderConcepts: readonly EntityRow[];
  }
): Map<string, SharedWith[]> {
  const parentOf = new Map<string, string | null>(
    folderConcepts.flatMap((concept) => {
      const id = str(concept, "concept_id");
      return id ? [[id, str(concept, "broader_concept_id")] as const] : [];
    })
  );
  const chainByDoc = new Map(
    documentIds.map(
      (id) => [id, folderChain(folderByDoc.get(id) ?? null, parentOf)] as const
    )
  );

  const grants = rows.grants.filter(
    (grant) =>
      str(grant, "plane") === "commons" &&
      str(grant, "revoked_at") === null &&
      (str(grant, "container_type") === DOCUMENT_TARGET_TYPE ||
        str(grant, "container_type") === FOLDER_CONTAINER_TYPE)
  );
  if (grants.length === 0) return new Map();

  const circleById = new Map(
    rows.circles.flatMap((circle) => {
      const id = str(circle, "circle_id");
      return id ? [[id, circle] as const] : [];
    })
  );
  const membersByCircle = new Map<string, EntityRow[]>();
  for (const member of rows.members) {
    const circleId = str(member, "circle_id");
    if (!circleId) continue;
    const list = membersByCircle.get(circleId);
    if (list) list.push(member);
    else membersByCircle.set(circleId, [member]);
  }
  const statusByGrantParty = new Map(
    rows.states.flatMap((state) => {
      const grantId = str(state, "grant_id");
      const partyId = str(state, "party_id");
      const status = str(state, "status");
      return grantId && partyId && status
        ? [[`${grantId} ${partyId}`, status] as const]
        : [];
    })
  );
  const nameByParty = new Map(
    rows.parties.flatMap((party) => {
      const id = str(party, "party_id");
      return id ? [[id, str(party, "display_name")] as const] : [];
    })
  );

  const entryByGrant = new Map<string, SharedWith>();
  for (const grant of grants) {
    const grantId = str(grant, "grant_id");
    const circleId = str(grant, "circle_id");
    const containerId = str(grant, "container_id");
    if (!grantId || !circleId || !containerId) continue;
    const roster: SharedMember[] = (membersByCircle.get(circleId) ?? [])
      .flatMap((member) => {
        const partyId = str(member, "party_id");
        if (!partyId) return [];
        const status =
          statusByGrantParty.get(`${grantId} ${partyId}`) ?? "invited";
        if (status === "refused") return [];
        const capability = str(member, "capability");
        return [
          {
            party_id: partyId,
            label: nameByParty.get(partyId) ?? "Someone",
            capability: capability === "read+write" ? "read+write" : "read",
            status: status === "current" ? "current" : "invited",
          } satisfies SharedMember,
        ];
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    const circle = circleById.get(circleId);
    entryByGrant.set(grantId, {
      grant_id: grantId,
      circle_id: circleId,
      label: shareLabel(
        Number(grant["implicit_circle"] ?? 0) === 1,
        circle ? str(circle, "name") : null,
        roster.map((member) => member.label)
      ),
      via:
        str(grant, "container_type") === DOCUMENT_TARGET_TYPE
          ? "document"
          : "folder",
      container_id: containerId,
      members: roster,
      member_count: roster.length,
      pending_count: roster.filter((member) => member.status === "invited")
        .length,
    });
  }

  const byDocument = new Map<string, SharedWith[]>();
  for (const documentId of documentIds) {
    const chain = chainByDoc.get(documentId) ?? [];
    const entries = grants
      .flatMap((grant) => {
        const grantId = str(grant, "grant_id");
        const entry = grantId ? entryByGrant.get(grantId) : undefined;
        if (!entry) return [];
        const reaches =
          entry.via === "document"
            ? entry.container_id === documentId
            : chain.includes(entry.container_id);
        return reaches ? [entry] : [];
      })
      .sort(
        (a, b) =>
          (a.via === "document" ? 0 : 1) - (b.via === "document" ? 0 : 1) ||
          a.label.localeCompare(b.label)
      );
    if (entries.length > 0) byDocument.set(documentId, entries);
  }
  return byDocument;
}

// The row's one state slot (§4.1) — the shared ladder, fed with phone facts.

const DAY_MS = 86_400_000;

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
