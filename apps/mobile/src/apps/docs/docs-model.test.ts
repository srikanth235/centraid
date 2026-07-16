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
