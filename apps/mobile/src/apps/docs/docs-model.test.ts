import { expect, test } from 'vitest';
import { buildDrive } from './docs-model';

test('native Docs joins wrappers, folders, current content and shared star tags', () => {
  const drive = buildDrive(
    [
      {
        document_id: 'd1',
        current_content_id: 'c1',
        title: 'Lease',
        created_at: '2026-01-01',
        updated_at: '2026-02-01',
        deleted_at: null,
      },
    ],
    [{ content_id: 'c1', media_type: 'application/pdf', byte_size: 42 }],
    [
      { target_id: 'd1', concept_id: 'folder' },
      { target_id: 'd1', concept_id: 'star' },
    ],
    [
      { concept_id: 'root', scheme_id: 'folders', notation: 'root' },
      {
        concept_id: 'folder',
        scheme_id: 'folders',
        pref_label: 'Home',
        broader_concept_id: 'root',
      },
      { concept_id: 'star', scheme_id: 'flags', notation: 'starred' },
    ],
    [
      { scheme_id: 'folders', uri: 'https://centraid.dev/schemes/folders' },
      { scheme_id: 'flags', uri: 'https://centraid.dev/schemes/flags' },
    ],
    [{ content_id: 'c1', state: 'replicated' }],
  );
  expect(drive.folders).toEqual([{ id: 'folder', name: 'Home' }]);
  expect(drive.documents[0]).toMatchObject({
    title: 'Lease',
    folderId: 'folder',
    starred: true,
    mediaType: 'application/pdf',
    custody: 'replicated',
  });
});

test('native Docs reparents a dangling or cyclic folder to root so nothing is lost', () => {
  const drive = buildDrive(
    [
      {
        document_id: 'd1',
        current_content_id: 'c1',
        title: 'Orphaned',
        created_at: '2026-01-01',
        updated_at: '2026-02-01',
        deleted_at: null,
      },
    ],
    [{ content_id: 'c1', media_type: 'application/pdf', byte_size: 10 }],
    [{ target_id: 'd1', concept_id: 'a' }],
    [
      { concept_id: 'root', scheme_id: 'folders', notation: 'root' },
      // Dangling parent — 'ghost' is not a folder concept.
      { concept_id: 'a', scheme_id: 'folders', pref_label: 'Orphan', broader_concept_id: 'ghost' },
      // A two-node cycle: b ↔ c.
      { concept_id: 'b', scheme_id: 'folders', pref_label: 'B', broader_concept_id: 'c' },
      { concept_id: 'c', scheme_id: 'folders', pref_label: 'C', broader_concept_id: 'b' },
    ],
    [{ scheme_id: 'folders', uri: 'https://centraid.dev/schemes/folders' }],
    [],
  );
  const byId = new Map(drive.folders.map((folder) => [folder.id, folder]));
  // The dangling folder is promoted to root (reachable), not stranded.
  expect(byId.get('a')).toEqual({ id: 'a', name: 'Orphan' });
  // The cycle is broken: exactly one node becomes a root, the other hangs off it.
  const b = byId.get('b')!;
  const c = byId.get('c')!;
  const roots = [b, c].filter((folder) => !folder.parentId);
  expect(roots).toHaveLength(1);
  // And the orphaned folder's document still surfaces under it.
  expect(drive.documents[0]).toMatchObject({ id: 'd1', folderId: 'a' });
});
