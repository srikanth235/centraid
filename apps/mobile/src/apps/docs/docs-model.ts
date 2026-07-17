import type { ReplicaRow } from '@centraid/client/replica/native';

export interface NativeFolder {
  id: string;
  name: string;
  parentId?: string;
}
export interface NativeDocument {
  id: string;
  contentId: string;
  title: string;
  mediaType: string;
  byteSize: number;
  modifiedAt: string;
  folderId?: string;
  starred: boolean;
  trashed: boolean;
  custody?: string;
}

const scalar = <T>(row: ReplicaRow, key: string): T | undefined => row[key] as T | undefined;

export function buildDrive(
  documentRows: ReplicaRow[],
  contentRows: ReplicaRow[],
  tagRows: ReplicaRow[],
  conceptRows: ReplicaRow[],
  schemeRows: ReplicaRow[],
  custodyRows: ReplicaRow[],
): { folders: NativeFolder[]; documents: NativeDocument[] } {
  const folderScheme = schemeRows.find(
    (row) => scalar(row, 'uri') === 'https://centraid.dev/schemes/folders',
  );
  const flagScheme = schemeRows.find(
    (row) => scalar(row, 'uri') === 'https://centraid.dev/schemes/flags',
  );
  const concepts = conceptRows.filter(
    (row) => scalar(row, 'scheme_id') === scalar(folderScheme ?? {}, 'scheme_id'),
  );
  const root = concepts.find((row) => scalar(row, 'notation') === 'root');
  const starred = conceptRows.find(
    (row) =>
      scalar(row, 'scheme_id') === scalar(flagScheme ?? {}, 'scheme_id') &&
      scalar(row, 'notation') === 'starred',
  );
  const folderIds = new Set(
    concepts.map((row) => scalar<string>(row, 'concept_id')).filter(Boolean),
  );
  const folderByDocument = new Map<string, string>();
  const starredIds = new Set<string>();
  for (const tag of tagRows) {
    const target = scalar<string>(tag, 'target_id');
    const concept = scalar<string>(tag, 'concept_id');
    if (!target || !concept) continue;
    if (folderIds.has(concept)) folderByDocument.set(target, concept);
    if (concept === scalar(starred ?? {}, 'concept_id')) starredIds.add(target);
  }
  const contentById = new Map(contentRows.map((row) => [scalar<string>(row, 'content_id'), row]));
  const custodyByContent = new Map(
    custodyRows.map((row) => [scalar<string>(row, 'content_id'), scalar<string>(row, 'state')]),
  );
  const rootId = scalar<string>(root ?? {}, 'concept_id');
  const nonRoot = concepts.filter((row) => scalar(row, 'concept_id') !== rootId);
  const folderIdSet = new Set(
    nonRoot.map((row) => scalar<string>(row, 'concept_id')).filter(Boolean),
  );
  const folders: NativeFolder[] = nonRoot.map((row) => {
    const id = scalar<string>(row, 'concept_id')!;
    const broader = scalar<string>(row, 'broader_concept_id');
    // A parent is honored only when it resolves to another real folder; a
    // broader pointer to root, to nothing, or to a non-folder concept is not.
    const parentId =
      broader && broader !== rootId && folderIdSet.has(broader) ? broader : undefined;
    return parentId
      ? { id, name: scalar<string>(row, 'pref_label') ?? 'Folder', parentId }
      : { id, name: scalar<string>(row, 'pref_label') ?? 'Folder' };
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
      const id = scalar<string>(row, 'document_id')!;
      const contentId = scalar<string>(row, 'current_content_id')!;
      const content = contentById.get(contentId) ?? {};
      const folder = folderByDocument.get(id);
      return {
        id,
        contentId,
        title: scalar<string>(row, 'title') ?? scalar<string>(content, 'title') ?? 'Untitled',
        mediaType: scalar<string>(content, 'media_type') ?? 'application/octet-stream',
        byteSize: scalar<number>(content, 'byte_size') ?? 0,
        modifiedAt:
          scalar<string>(row, 'updated_at') ??
          scalar<string>(row, 'created_at') ??
          new Date(0).toISOString(),
        ...(folder && folder !== scalar(root ?? {}, 'concept_id') ? { folderId: folder } : {}),
        starred: starredIds.has(id),
        trashed: Boolean(scalar(row, 'deleted_at')),
        custody: custodyByContent.get(contentId),
      };
    }),
  };
}
