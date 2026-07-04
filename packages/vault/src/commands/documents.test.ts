import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { registerAttachmentCommands } from './attachments.js';
import { FOLDER_SCHEME_URI, registerDocumentCommands } from './documents.js';

const PDF = 'data:application/pdf;base64,JVBERi0xLjQKJcTl8uXrp/Og0MTGCg==';
const SCAN =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerDocumentCommands(gw);
  registerAttachmentCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

function invoke(command: string, input: Record<string, unknown>) {
  return gw.invoke(owner, { command, input, purpose: 'dpv:ServiceProvision' });
}

function addDocument(input: Record<string, unknown>): string {
  const outcome = invoke('core.add_document', input);
  expect(outcome.status).toBe('executed');
  return (outcome as { output: { content_id: string } }).output.content_id;
}

function createFolder(name: string, parent?: string): string {
  const outcome = invoke('core.create_folder', {
    name,
    ...(parent ? { parent_folder_id: parent } : {}),
  });
  expect(outcome.status).toBe('executed');
  return (outcome as { output: { folder_id: string } }).output.folder_id;
}

/** The folders-scheme concept a document is currently filed under. */
function filedUnder(contentId: string): { concept_id: string; notation: string } | undefined {
  return db.vault
    .prepare(
      `SELECT c.concept_id, c.notation FROM core_tag t
         JOIN core_concept c ON c.concept_id = t.concept_id
         JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
        WHERE t.target_type = 'core.content_item' AND t.target_id = ? AND s.uri = ?`,
    )
    .get(contentId, FOLDER_SCHEME_URI) as { concept_id: string; notation: string } | undefined;
}

test('add_document files into the lazily-created root and carries its title', () => {
  const contentId = addDocument({ data_uri: PDF, title: 'Rental agreement.pdf' });
  const content = db.vault
    .prepare('SELECT media_type, title, deleted_at FROM core_content_item WHERE content_id = ?')
    .get(contentId);
  expect(content).toMatchObject({
    media_type: 'application/pdf',
    title: 'Rental agreement.pdf',
    deleted_at: null,
  });
  expect(filedUnder(contentId)?.notation).toBe('root');
});

test('folders nest under root, refuse sibling name twins, and file documents', () => {
  const taxes = createFolder('Taxes');
  const y2026 = createFolder('2026', taxes);
  const twin = invoke('core.create_folder', { name: 'Taxes' });
  expect(twin.status).toBe('failed');
  if (twin.status === 'failed') expect(twin.predicate).toContain('name_unused_among_siblings');
  // Same name under a different parent is fine.
  expect(invoke('core.create_folder', { name: 'Taxes', parent_folder_id: y2026 }).status).toBe(
    'executed',
  );
  const contentId = addDocument({ data_uri: PDF, title: 'Form 16.pdf', folder_id: y2026 });
  expect(filedUnder(contentId)?.concept_id).toBe(y2026);
});

test('move_document re-files exactly once; omitting the folder returns to root', () => {
  const folder = createFolder('Receipts');
  const contentId = addDocument({ data_uri: PDF, title: 'Invoice.pdf' });
  expect(invoke('core.move_document', { content_id: contentId, folder_id: folder }).status).toBe(
    'executed',
  );
  expect(filedUnder(contentId)?.concept_id).toBe(folder);
  expect(invoke('core.move_document', { content_id: contentId }).status).toBe('executed');
  expect(filedUnder(contentId)?.notation).toBe('root');
  const tags = db.vault
    .prepare(`SELECT count(*) AS n FROM core_tag WHERE target_id = ?`)
    .get(contentId) as { n: number };
  expect(tags.n).toBe(1);
});

test('rename_document updates the canonical title', () => {
  const contentId = addDocument({ data_uri: PDF, title: 'Untitled.pdf' });
  expect(
    invoke('core.rename_document', { content_id: contentId, title: 'Lease 2026.pdf' }).status,
  ).toBe('executed');
  const content = db.vault
    .prepare('SELECT title FROM core_content_item WHERE content_id = ?')
    .get(contentId) as { title: string };
  expect(content.title).toBe('Lease 2026.pdf');
});

test('trash then restore round-trips; re-upload also restores and renames', () => {
  const contentId = addDocument({ data_uri: PDF, title: 'Draft.pdf' });
  const trashed = invoke('core.trash_document', { content_id: contentId });
  expect(trashed.status).toBe('executed');
  let row = db.vault
    .prepare('SELECT deleted_at, purge_at FROM core_content_item WHERE content_id = ?')
    .get(contentId) as { deleted_at: string | null; purge_at: string | null };
  expect(row.deleted_at).not.toBeNull();
  expect(row.purge_at).not.toBeNull();
  // A trashed document no longer renames or moves.
  expect(invoke('core.rename_document', { content_id: contentId, title: 'x' }).status).toBe(
    'failed',
  );
  expect(invoke('core.restore_document', { content_id: contentId }).status).toBe('executed');
  row = db.vault
    .prepare('SELECT deleted_at, purge_at FROM core_content_item WHERE content_id = ?')
    .get(contentId) as { deleted_at: string | null; purge_at: string | null };
  expect(row.deleted_at).toBeNull();
  expect(row.purge_at).toBeNull();
  // Trash again, re-upload the same bytes: dedup restores and renames.
  invoke('core.trash_document', { content_id: contentId });
  const again = addDocument({ data_uri: PDF, title: 'Final.pdf' });
  expect(again).toBe(contentId);
  const title = db.vault
    .prepare('SELECT title, deleted_at FROM core_content_item WHERE content_id = ?')
    .get(contentId) as { title: string; deleted_at: string | null };
  expect(title).toMatchObject({ title: 'Final.pdf', deleted_at: null });
});

test('trash_document refuses bytes another canonical row still rents', () => {
  const contentId = addDocument({ data_uri: SCAN, title: 'Warranty scan.png' });
  const attach = invoke('core.attach', {
    subject_type: 'core.party',
    subject_id: boot.ownerPartyId,
    data_uri: SCAN,
  });
  expect(attach.status).toBe('executed');
  const outcome = invoke('core.trash_document', { content_id: contentId });
  expect(outcome.status).toBe('failed');
  if (outcome.status === 'failed') expect(outcome.predicate).toContain('not_rented_elsewhere');
});

test('delete_folder refuses non-empty folders (documents or subfolders), root is untouchable', () => {
  const folder = createFolder('Keep');
  const contentId = addDocument({ data_uri: PDF, title: 'Kept.pdf', folder_id: folder });
  let outcome = invoke('core.delete_folder', { folder_id: folder });
  expect(outcome.status).toBe('failed');
  if (outcome.status === 'failed') expect(outcome.predicate).toContain('folder_is_empty');
  invoke('core.move_document', { content_id: contentId });
  outcome = invoke('core.delete_folder', { folder_id: folder });
  expect(outcome.status).toBe('executed');
  const root = filedUnder(contentId);
  expect(root?.notation).toBe('root');
  expect(invoke('core.delete_folder', { folder_id: root?.concept_id ?? '' }).status).toBe('failed');
  expect(
    invoke('core.rename_folder', { folder_id: root?.concept_id ?? '', name: 'x' }).status,
  ).toBe('failed');
});

/** Count of starred flags-scheme tags on a content item (issue #274). */
function starCount(contentId: string): number {
  const row = db.vault
    .prepare(
      `SELECT count(*) AS n FROM core_tag t
         JOIN core_concept c ON c.concept_id = t.concept_id
         JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
        WHERE t.target_type = 'core.content_item' AND t.target_id = ?
          AND s.uri = 'https://centraid.dev/schemes/flags' AND c.notation = 'starred'`,
    )
    .get(contentId) as { n: number };
  return row.n;
}

test('star/unstar are idempotent single tags; the concept carries the Favorite altLabel', () => {
  const contentId = addDocument({ data_uri: PDF, title: 'Lease.pdf' });
  expect(invoke('core.star_document', { content_id: contentId }).status).toBe('executed');
  expect(invoke('core.star_document', { content_id: contentId }).status).toBe('executed');
  expect(starCount(contentId)).toBe(1);
  // One judgment, one vocabulary: star and favorite are the same concept.
  const concept = db.vault
    .prepare(
      `SELECT c.pref_label, c.alt_labels_json FROM core_concept c
         JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
        WHERE s.uri = 'https://centraid.dev/schemes/flags' AND c.notation = 'starred'`,
    )
    .get() as { pref_label: string; alt_labels_json: string };
  expect(concept.pref_label).toBe('Starred');
  expect(JSON.parse(concept.alt_labels_json)).toContain('Favorite');
  expect(invoke('core.unstar_document', { content_id: contentId }).status).toBe('executed');
  expect(invoke('core.unstar_document', { content_id: contentId }).status).toBe('executed');
  expect(starCount(contentId)).toBe(0);
});

test('a trashed document refuses star changes but keeps its star through restore', () => {
  const contentId = addDocument({ data_uri: PDF, title: 'Taxes.pdf' });
  expect(invoke('core.star_document', { content_id: contentId }).status).toBe('executed');
  expect(invoke('core.trash_document', { content_id: contentId }).status).toBe('executed');
  const whileTrashed = invoke('core.unstar_document', { content_id: contentId });
  expect(whileTrashed.status).toBe('failed');
  if (whileTrashed.status === 'failed') expect(whileTrashed.predicate).toContain('document_exists');
  expect(starCount(contentId)).toBe(1);
  expect(invoke('core.restore_document', { content_id: contentId }).status).toBe('executed');
  expect(starCount(contentId)).toBe(1);
});
