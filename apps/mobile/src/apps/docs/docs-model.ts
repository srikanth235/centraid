import type { ReplicaRow } from "@centraid/client/replica/native";

export interface NativeFolder {
  id: string;
  name: string;
  parentId?: string;
}
export interface NativeDocument {
  id: string;
  rawId?: string;
  contentId: string;
  title: string;
  mediaType: string;
  byteSize: number;
  modifiedAt: string;
  folderId?: string;
  starred: boolean;
  trashed: boolean;
  custody?: string;
  sha256?: string;
  sourceVaultId?: string;
  scopeIds?: string[];
  scopeLabels?: string[];
  canWrite?: boolean;
}

const scalar = <T>(row: ReplicaRow, key: string): T | undefined =>
  row[key] as T | undefined;

export function buildDrive(
  documentRows: ReplicaRow[],
  contentRows: ReplicaRow[],
  tagRows: ReplicaRow[],
  conceptRows: ReplicaRow[],
  schemeRows: ReplicaRow[],
  custodyRows: ReplicaRow[]
): { folders: NativeFolder[]; documents: NativeDocument[] } {
  const scopeIds = new Set(
    documentRows.map(scopeOf).filter((value): value is string => Boolean(value))
  );
  if (scopeIds.size === 0) {
    return buildScopeDrive(
      documentRows,
      contentRows,
      tagRows,
      conceptRows,
      schemeRows,
      custodyRows
    );
  }
  const folders: NativeFolder[] = [];
  const documents: NativeDocument[] = [];
  for (const scopeId of scopeIds) {
    const within = (row: ReplicaRow): boolean => scopeOf(row) === scopeId;
    const drive = buildScopeDrive(
      documentRows.filter(within),
      contentRows.filter(within),
      tagRows.filter(within),
      conceptRows.filter(within),
      schemeRows.filter(within),
      custodyRows.filter(within)
    );
    folders.push(
      ...drive.folders.map((folder) => ({
        ...folder,
        id: scoped(scopeId, folder.id),
        ...(folder.parentId
          ? { parentId: scoped(scopeId, folder.parentId) }
          : {}),
      }))
    );
    for (const document of drive.documents) {
      const source = documentRows.find(
        (row) => scalar(row, "document_id") === document.id && within(row)
      );
      const content = contentRows.find(
        (row) => scalar(row, "content_id") === document.contentId && within(row)
      );
      documents.push({
        ...document,
        rawId: document.id,
        id: scoped(scopeId, document.id),
        ...(document.folderId
          ? { folderId: scoped(scopeId, document.folderId) }
          : {}),
        sha256: scalar<string>(content ?? {}, "sha256"),
        sourceVaultId: scopeId,
        scopeIds: scalar<string[]>(source ?? {}, "__centraidScopeIds") ?? [
          scopeId,
        ],
        scopeLabels: [
          scalar<string>(source ?? {}, "__centraidScopeLabel") ?? "Vault",
        ],
        canWrite: scalar<boolean>(source ?? {}, "__centraidCanWrite") ?? false,
      });
    }
  }
  const deduped = new Map<string, NativeDocument>();
  for (const document of documents) {
    const key = document.sha256
      ? `sha:${document.sha256}`
      : `id:${document.id}`;
    const held = deduped.get(key);
    if (!held) {
      deduped.set(key, document);
      continue;
    }
    const canonical =
      held.canWrite === true || document.canWrite !== true ? held : document;
    canonical.scopeIds = unique([
      ...(held.scopeIds ?? []),
      ...(document.scopeIds ?? []),
    ]);
    canonical.scopeLabels = unique([
      ...(held.scopeLabels ?? []),
      ...(document.scopeLabels ?? []),
    ]);
    canonical.canWrite = held.canWrite === true || document.canWrite === true;
    deduped.set(key, canonical);
  }
  return { folders, documents: [...deduped.values()] };
}

function buildScopeDrive(
  documentRows: ReplicaRow[],
  contentRows: ReplicaRow[],
  tagRows: ReplicaRow[],
  conceptRows: ReplicaRow[],
  schemeRows: ReplicaRow[],
  custodyRows: ReplicaRow[]
): { folders: NativeFolder[]; documents: NativeDocument[] } {
  const folderScheme = schemeRows.find(
    (row) => scalar(row, "uri") === "https://centraid.dev/schemes/folders"
  );
  const flagScheme = schemeRows.find(
    (row) => scalar(row, "uri") === "https://centraid.dev/schemes/flags"
  );
  const concepts = conceptRows.filter(
    (row) =>
      scalar(row, "scheme_id") === scalar(folderScheme ?? {}, "scheme_id")
  );
  const root = concepts.find((row) => scalar(row, "notation") === "root");
  const starred = conceptRows.find(
    (row) =>
      scalar(row, "scheme_id") === scalar(flagScheme ?? {}, "scheme_id") &&
      scalar(row, "notation") === "starred"
  );
  const folderIds = new Set(
    concepts.map((row) => scalar<string>(row, "concept_id")).filter(Boolean)
  );
  const folderByDocument = new Map<string, string>();
  const starredIds = new Set<string>();
  for (const tag of tagRows) {
    const target = scalar<string>(tag, "target_id");
    const concept = scalar<string>(tag, "concept_id");
    if (!target || !concept) continue;
    if (folderIds.has(concept)) folderByDocument.set(target, concept);
    if (concept === scalar(starred ?? {}, "concept_id")) starredIds.add(target);
  }
  const contentById = new Map(
    contentRows.map((row) => [scalar<string>(row, "content_id"), row])
  );
  const custodyByContent = new Map(
    custodyRows.map((row) => [
      scalar<string>(row, "content_id"),
      scalar<string>(row, "state"),
    ])
  );
  const rootId = scalar<string>(root ?? {}, "concept_id");
  const nonRoot = concepts.filter(
    (row) => scalar(row, "concept_id") !== rootId
  );
  const folderIdSet = new Set(
    nonRoot.map((row) => scalar<string>(row, "concept_id")).filter(Boolean)
  );
  const folders: NativeFolder[] = nonRoot.map((row) => {
    const id = scalar<string>(row, "concept_id")!;
    const broader = scalar<string>(row, "broader_concept_id");
    // A parent is honored only when it resolves to another real folder; a
    // broader pointer to root, to nothing, or to a non-folder concept is not.
    const parentId =
      broader && broader !== rootId && folderIdSet.has(broader)
        ? broader
        : undefined;
    return parentId
      ? { id, name: scalar<string>(row, "pref_label") ?? "Folder", parentId }
      : { id, name: scalar<string>(row, "pref_label") ?? "Folder" };
  });
  // Orphan/cycle guard: a folder whose parent chain dangles or loops would
  // never reach the root and would drag its documents out of view with it.
  // Promote any such folder to the root so it stays reachable.
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  for (const folder of folders) {
    const seen = new Set<string>();
    let cursor: NativeFolder | undefined = folder;
    while (cursor?.parentId) {
      if (seen.has(cursor.id)) {
        delete folder.parentId;
        break;
      }
      seen.add(cursor.id);
      cursor = folderById.get(cursor.parentId);
      if (!cursor) {
        delete folder.parentId;
        break;
      }
    }
  }
  return {
    folders,
    documents: documentRows.map((row) => {
      const id = scalar<string>(row, "document_id")!;
      const contentId = scalar<string>(row, "current_content_id")!;
      const content = contentById.get(contentId) ?? {};
      const folder = folderByDocument.get(id);
      return {
        id,
        contentId,
        title:
          scalar<string>(row, "title") ??
          scalar<string>(content, "title") ??
          "Untitled",
        mediaType:
          scalar<string>(content, "media_type") ?? "application/octet-stream",
        byteSize: scalar<number>(content, "byte_size") ?? 0,
        modifiedAt:
          scalar<string>(row, "updated_at") ??
          scalar<string>(row, "created_at") ??
          new Date(0).toISOString(),
        ...(folder && folder !== scalar(root ?? {}, "concept_id")
          ? { folderId: folder }
          : {}),
        starred: starredIds.has(id),
        trashed: Boolean(scalar(row, "deleted_at")),
        custody: custodyByContent.get(contentId),
      };
    }),
  };
}

function scopeOf(row: ReplicaRow): string | undefined {
  return scalar<string>(row, "__centraidScopeId");
}

function scoped(scopeId: string, id: string): string {
  return `${scopeId}:${id}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
