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
  return {
    folders: concepts
      .filter((row) => scalar(row, 'concept_id') !== scalar(root ?? {}, 'concept_id'))
      .map((row) => ({
        id: scalar<string>(row, 'concept_id')!,
        name: scalar<string>(row, 'pref_label') ?? 'Folder',
        ...(scalar<string>(row, 'broader_concept_id') &&
        scalar(row, 'broader_concept_id') !== scalar(root ?? {}, 'concept_id')
          ? { parentId: scalar<string>(row, 'broader_concept_id') }
          : {}),
      })),
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
