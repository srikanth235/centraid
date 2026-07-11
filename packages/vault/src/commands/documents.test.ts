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

function addDocument(input: Record<string, unknown>): { documentId: string; contentId: string } {
  const outcome = invoke('core.add_document', input);
  expect(outcome.status).toBe('executed');
  const output = (outcome as { output: { document_id: string; content_id: string } }).output;
  return { documentId: output.document_id, contentId: output.content_id };
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
function filedUnder(documentId: string): { concept_id: string; notation: string } | undefined {
  return db.vault
    .prepare(
      `SELECT c.concept_id, c.notation FROM core_tag t
         JOIN core_concept c ON c.concept_id = t.concept_id
         JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
        WHERE t.target_type = 'core.document' AND t.target_id = ? AND s.uri = ?`,
    )
    .get(documentId, FOLDER_SCHEME_URI) as { concept_id: string; notation: string } | undefined;
}

/**
 * Walk a document's version chain oldest-first via the `revises` links.
 * Guards against revisiting a content id: restoring an old version gives it
 * a NEW outgoing edge (rule R3), which can cycle the graph back through
 * content already walked (documents.ts's target_in_chain precondition
 * carries the same note) — a plain linked-list walk without this guard
 * hangs forever the moment a document is restored more than once removed.
 */
function versionChain(documentId: string): string[] {
  const head = db.vault
    .prepare('SELECT current_content_id FROM core_document WHERE document_id = ?')
    .get(documentId) as { current_content_id: string };
  const chain: string[] = [head.current_content_id];
  const seen = new Set<string>([head.current_content_id]);
  let cur = head.current_content_id;
  for (;;) {
    const next = db.vault
      .prepare(
        `SELECT l.to_id FROM core_link l
           JOIN core_concept c ON c.concept_id = l.relation_concept_id
          WHERE l.from_type = 'core.content_item' AND l.from_id = ?
            AND l.to_type = 'core.content_item' AND l.valid_to IS NULL AND c.notation = 'revises'
          ORDER BY l.valid_from DESC LIMIT 1`,
      )
      .get(cur) as { to_id: string } | undefined;
    if (!next || seen.has(next.to_id)) break;
    chain.push(next.to_id);
    seen.add(next.to_id);
    cur = next.to_id;
  }
  return chain.toReversed();
}

test('add_document mints a document wrapping a canonical content item', () => {
  const { documentId, contentId } = addDocument({ data_uri: PDF, title: 'Rental agreement.pdf' });
  const doc = db.vault
    .prepare('SELECT title, current_content_id, deleted_at FROM core_document WHERE document_id = ?')
    .get(documentId) as { title: string; current_content_id: string; deleted_at: string | null };
  expect(doc).toMatchObject({
    title: 'Rental agreement.pdf',
    current_content_id: contentId,
    deleted_at: null,
  });
  const content = db.vault
    .prepare('SELECT media_type, deleted_at FROM core_content_item WHERE content_id = ?')
    .get(contentId);
  expect(content).toMatchObject({ media_type: 'application/pdf', deleted_at: null });
  expect(filedUnder(documentId)?.notation).toBe('root');
});

test('two documents may share identical bytes (dedup is on content, not identity)', () => {
  const a = addDocument({ data_uri: PDF, title: 'Original.pdf' });
  const b = addDocument({ data_uri: PDF, title: 'Copy.pdf' });
  expect(b.documentId).not.toBe(a.documentId);
  expect(b.contentId).toBe(a.contentId); // same bytes, deduped content item
  const docs = db.vault
    .prepare('SELECT count(*) AS n FROM core_document WHERE current_content_id = ?')
    .get(a.contentId) as { n: number };
  expect(docs.n).toBe(2);
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
  const { documentId } = addDocument({ data_uri: PDF, title: 'Form 16.pdf', folder_id: y2026 });
  expect(filedUnder(documentId)?.concept_id).toBe(y2026);
});

test('move_document re-files exactly once; omitting the folder returns to root', () => {
  const folder = createFolder('Receipts');
  const { documentId } = addDocument({ data_uri: PDF, title: 'Invoice.pdf' });
  expect(invoke('core.move_document', { document_id: documentId, folder_id: folder }).status).toBe(
    'executed',
  );
  expect(filedUnder(documentId)?.concept_id).toBe(folder);
  expect(invoke('core.move_document', { document_id: documentId }).status).toBe('executed');
  expect(filedUnder(documentId)?.notation).toBe('root');
  const tags = db.vault
    .prepare(`SELECT count(*) AS n FROM core_tag WHERE target_id = ?`)
    .get(documentId) as { n: number };
  expect(tags.n).toBe(1);
});

test('rename_document updates the document title, not the raw content item', () => {
  const { documentId, contentId } = addDocument({ data_uri: PDF, title: 'Untitled.pdf' });
  expect(
    invoke('core.rename_document', { document_id: documentId, title: 'Lease 2026.pdf' }).status,
  ).toBe('executed');
  const doc = db.vault
    .prepare('SELECT title FROM core_document WHERE document_id = ?')
    .get(documentId) as { title: string };
  expect(doc.title).toBe('Lease 2026.pdf');
  // The underlying content item never carried the document's title.
  const content = db.vault
    .prepare('SELECT title FROM core_content_item WHERE content_id = ?')
    .get(contentId) as { title: string | null };
  expect(content.title).toBe('Untitled.pdf');
});

test('trash then restore round-trips; content is untouched while the document lives', () => {
  const { documentId, contentId } = addDocument({ data_uri: PDF, title: 'Draft.pdf' });
  const trashed = invoke('core.trash_document', { document_id: documentId });
  expect(trashed.status).toBe('executed');
  let doc = db.vault
    .prepare('SELECT deleted_at, purge_at FROM core_document WHERE document_id = ?')
    .get(documentId) as { deleted_at: string | null; purge_at: string | null };
  expect(doc.deleted_at).not.toBeNull();
  expect(doc.purge_at).not.toBeNull();
  // Retention stance (issue #352): the wrapper trashes, the bytes stay live.
  const content = db.vault
    .prepare('SELECT deleted_at FROM core_content_item WHERE content_id = ?')
    .get(contentId) as { deleted_at: string | null };
  expect(content.deleted_at).toBeNull();
  // A trashed document no longer renames or moves.
  expect(invoke('core.rename_document', { document_id: documentId, title: 'x' }).status).toBe(
    'failed',
  );
  expect(invoke('core.restore_document', { document_id: documentId }).status).toBe('executed');
  doc = db.vault
    .prepare('SELECT deleted_at, purge_at FROM core_document WHERE document_id = ?')
    .get(documentId) as { deleted_at: string | null; purge_at: string | null };
  expect(doc.deleted_at).toBeNull();
  expect(doc.purge_at).toBeNull();
});

test('re-uploading identical bytes mints a brand-new document; the trashed one stays trashed', () => {
  const first = addDocument({ data_uri: PDF, title: 'Draft.pdf' });
  invoke('core.trash_document', { document_id: first.documentId });
  const second = addDocument({ data_uri: PDF, title: 'Final.pdf' });
  expect(second.documentId).not.toBe(first.documentId);
  expect(second.contentId).toBe(first.contentId); // bytes still dedup
  const firstRow = db.vault
    .prepare('SELECT deleted_at FROM core_document WHERE document_id = ?')
    .get(first.documentId) as { deleted_at: string | null };
  expect(firstRow.deleted_at).not.toBeNull(); // untouched by the re-upload
});

test('delete_folder refuses non-empty folders (documents or subfolders), root is untouchable', () => {
  const folder = createFolder('Keep');
  const { documentId } = addDocument({ data_uri: PDF, title: 'Kept.pdf', folder_id: folder });
  let outcome = invoke('core.delete_folder', { folder_id: folder });
  expect(outcome.status).toBe('failed');
  if (outcome.status === 'failed') expect(outcome.predicate).toContain('folder_is_empty');
  invoke('core.move_document', { document_id: documentId });
  outcome = invoke('core.delete_folder', { folder_id: folder });
  expect(outcome.status).toBe('executed');
  const root = filedUnder(documentId);
  expect(root?.notation).toBe('root');
  expect(invoke('core.delete_folder', { folder_id: root?.concept_id ?? '' }).status).toBe('failed');
  expect(invoke('core.rename_folder', { folder_id: root?.concept_id ?? '', name: 'x' }).status).toBe(
    'failed',
  );
});

/** Count of starred flags-scheme tags on a document (issue #274/#352). */
function starCount(documentId: string): number {
  const row = db.vault
    .prepare(
      `SELECT count(*) AS n FROM core_tag t
         JOIN core_concept c ON c.concept_id = t.concept_id
         JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
        WHERE t.target_type = 'core.document' AND t.target_id = ?
          AND s.uri = 'https://centraid.dev/schemes/flags' AND c.notation = 'starred'`,
    )
    .get(documentId) as { n: number };
  return row.n;
}

test('star/unstar are idempotent single tags; the concept carries the Favorite altLabel', () => {
  const { documentId } = addDocument({ data_uri: PDF, title: 'Lease.pdf' });
  expect(invoke('core.star_document', { document_id: documentId }).status).toBe('executed');
  expect(invoke('core.star_document', { document_id: documentId }).status).toBe('executed');
  expect(starCount(documentId)).toBe(1);
  const concept = db.vault
    .prepare(
      `SELECT c.pref_label, c.alt_labels_json FROM core_concept c
         JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
        WHERE s.uri = 'https://centraid.dev/schemes/flags' AND c.notation = 'starred'`,
    )
    .get() as { pref_label: string; alt_labels_json: string };
  expect(concept.pref_label).toBe('Starred');
  expect(JSON.parse(concept.alt_labels_json)).toContain('Favorite');
  expect(invoke('core.unstar_document', { document_id: documentId }).status).toBe('executed');
  expect(invoke('core.unstar_document', { document_id: documentId }).status).toBe('executed');
  expect(starCount(documentId)).toBe(0);
});

test('a trashed document refuses star changes but keeps its star through restore', () => {
  const { documentId } = addDocument({ data_uri: PDF, title: 'Taxes.pdf' });
  expect(invoke('core.star_document', { document_id: documentId }).status).toBe('executed');
  expect(invoke('core.trash_document', { document_id: documentId }).status).toBe('executed');
  const whileTrashed = invoke('core.unstar_document', { document_id: documentId });
  expect(whileTrashed.status).toBe('failed');
  if (whileTrashed.status === 'failed') expect(whileTrashed.predicate).toContain('document_exists');
  expect(starCount(documentId)).toBe(1);
  expect(invoke('core.restore_document', { document_id: documentId }).status).toBe('executed');
  expect(starCount(documentId)).toBe(1);
});

test('edit_document mints a new revision, records the revises link, and the chain is walkable', () => {
  const { documentId, contentId: v1 } = addDocument({
    data_uri: 'data:text/plain;charset=utf-8,version%20one',
    title: 'Notes.txt',
  });
  const e1 = invoke('core.edit_document', { document_id: documentId, body_text: 'version two' });
  expect(e1.status).toBe('executed');
  const v2 = (e1 as { output: { content_id: string } }).output.content_id;
  expect(v2).not.toBe(v1);
  const e2 = invoke('core.edit_document', {
    document_id: documentId,
    body_text: 'version three',
    title: 'Notes (renamed).txt',
  });
  expect(e2.status).toBe('executed');
  const v3 = (e2 as { output: { content_id: string } }).output.content_id;
  expect(v3).not.toBe(v2);
  const doc = db.vault
    .prepare('SELECT title, current_content_id FROM core_document WHERE document_id = ?')
    .get(documentId) as { title: string; current_content_id: string };
  expect(doc).toMatchObject({ title: 'Notes (renamed).txt', current_content_id: v3 });
  expect(versionChain(documentId)).toEqual([v1, v2, v3]);
});

test('edit_document is refused for non-text-editable current content', () => {
  const { documentId } = addDocument({ data_uri: SCAN, title: 'Scan.png' });
  const outcome = invoke('core.edit_document', { document_id: documentId, body_text: 'nope' });
  expect(outcome.status).toBe('failed');
  if (outcome.status === 'failed') expect(outcome.predicate).toContain('current_content_is_text');
});

test('edit_document with identical bytes (dedup) is a no-op on the chain', () => {
  const { documentId, contentId } = addDocument({
    data_uri: 'data:text/plain;charset=utf-8,same%20text',
    title: 'Same.txt',
  });
  const outcome = invoke('core.edit_document', { document_id: documentId, body_text: 'same text' });
  expect(outcome.status).toBe('executed');
  expect((outcome as { output: { content_id: string } }).output.content_id).toBe(contentId);
  expect(versionChain(documentId)).toEqual([contentId]);
});

test('replace_document_content swaps in new binary bytes and records the revision', () => {
  const { documentId, contentId: v1 } = addDocument({ data_uri: PDF, title: 'Scan.pdf' });
  const outcome = invoke('core.replace_document_content', {
    document_id: documentId,
    data_uri: SCAN,
    title: 'Scan (rescanned).pdf',
  });
  expect(outcome.status).toBe('executed');
  const v2 = (outcome as { output: { content_id: string } }).output.content_id;
  expect(v2).not.toBe(v1);
  const doc = db.vault
    .prepare('SELECT title, current_content_id FROM core_document WHERE document_id = ?')
    .get(documentId) as { title: string; current_content_id: string };
  expect(doc).toMatchObject({ title: 'Scan (rescanned).pdf', current_content_id: v2 });
  expect(versionChain(documentId)).toEqual([v1, v2]);
});

test('restore_document_version repoints current_content_id and appends forward, never rewriting history', () => {
  const { documentId, contentId: v1 } = addDocument({
    data_uri: 'data:text/plain;charset=utf-8,v1',
    title: 'Doc.txt',
  });
  const v2 = (
    invoke('core.edit_document', { document_id: documentId, body_text: 'v2' }) as {
      output: { content_id: string };
    }
  ).output.content_id;
  const v3 = (
    invoke('core.edit_document', { document_id: documentId, body_text: 'v3' }) as {
      output: { content_id: string };
    }
  ).output.content_id;
  const restore = invoke('core.restore_document_version', { document_id: documentId, content_id: v1 });
  expect(restore.status).toBe('executed');
  const doc = db.vault
    .prepare('SELECT current_content_id FROM core_document WHERE document_id = ?')
    .get(documentId) as { current_content_id: string };
  expect(doc.current_content_id).toBe(v1);
  // History never rewrites: the ORIGINAL v2->v1 and v3->v2 links are still
  // live, untouched, exactly as the edits wrote them — the restore only
  // APPENDS a new v1->v3 link (rule R3). This is the strongest proof: raw
  // link rows, not a convenience walk.
  const liveRevisesEdges = db.vault
    .prepare(
      `SELECT l.from_id, l.to_id FROM core_link l
         JOIN core_concept c ON c.concept_id = l.relation_concept_id
        WHERE c.notation = 'revises' AND l.valid_to IS NULL
        ORDER BY l.valid_from ASC`,
    )
    .all() as { from_id: string; to_id: string }[];
  expect(liveRevisesEdges).toEqual([
    { from_id: v2, to_id: v1 },
    { from_id: v3, to_id: v2 },
    { from_id: v1, to_id: v3 },
  ]);
  // The restore reuses v1's own identity (content is deduped bytes) as the
  // new HEAD, which cycles the graph back through v3 and v2 — v1 now
  // legitimately appears at two points in true history (root, then
  // restored-to). A content-id walk can only show one node once, so the
  // convenience chain below collapses to v1's LATEST position; the raw
  // edges above are the ground truth for "never rewrites".
  expect(versionChain(documentId)).toEqual([v2, v3, v1]);
});

test('restore_document_version refuses a content id outside the chain, or the current one', () => {
  const { documentId, contentId } = addDocument({
    data_uri: 'data:text/plain;charset=utf-8,v1',
    title: 'Doc.txt',
  });
  const other = addDocument({ data_uri: 'data:text/plain;charset=utf-8,unrelated', title: 'Other' });
  const outsider = invoke('core.restore_document_version', {
    document_id: documentId,
    content_id: other.contentId,
  });
  expect(outsider.status).toBe('failed');
  if (outsider.status === 'failed') expect(outsider.predicate).toContain('target_in_chain');
  const self = invoke('core.restore_document_version', {
    document_id: documentId,
    content_id: contentId,
  });
  expect(self.status).toBe('failed');
  if (self.status === 'failed') expect(self.predicate).toContain('not_already_current');
});

test('trash + purge of a document with a version chain releases every exclusively-owned revision', () => {
  const { documentId, contentId: v1 } = addDocument({
    data_uri: 'data:text/plain;charset=utf-8,v1',
    title: 'Doc.txt',
  });
  const v2 = (
    invoke('core.edit_document', { document_id: documentId, body_text: 'v2' }) as {
      output: { content_id: string };
    }
  ).output.content_id;
  invoke('core.trash_document', { document_id: documentId });
  db.vault
    .prepare('UPDATE core_document SET purge_at = ? WHERE document_id = ?')
    .run('2000-01-01T00:00:00.000Z', documentId);
  const swept = gw.sweep(owner);
  expect(swept.documentsPurged).toBe(1);
  expect(db.vault.prepare('SELECT 1 FROM core_document WHERE document_id = ?').get(documentId)).toBe(
    undefined,
  );
  for (const id of [v1, v2]) {
    expect(db.vault.prepare('SELECT 1 FROM core_content_item WHERE content_id = ?').get(id)).toBe(
      undefined,
    );
  }
});

test('purge protects a superseded revision still shared with a live document', () => {
  const { documentId, contentId: shared } = addDocument({
    data_uri: 'data:text/plain;charset=utf-8,shared%20text',
    title: 'A.txt',
  });
  // B starts on the SAME bytes as A's first version, then moves on — so
  // `shared` is now v1 of A's live current AND v1 of B's (dead) history.
  const other = addDocument({ data_uri: 'data:text/plain;charset=utf-8,shared%20text', title: 'B.txt' });
  expect(other.contentId).toBe(shared);
  invoke('core.edit_document', { document_id: other.documentId, body_text: 'B moved on' });
  invoke('core.trash_document', { document_id: other.documentId });
  db.vault
    .prepare('UPDATE core_document SET purge_at = ? WHERE document_id = ?')
    .run('2000-01-01T00:00:00.000Z', other.documentId);
  gw.sweep(owner);
  // B is gone, but the shared bytes survive — A (still live) is their current.
  expect(db.vault.prepare('SELECT 1 FROM core_document WHERE document_id = ?').get(other.documentId)).toBe(
    undefined,
  );
  expect(db.vault.prepare('SELECT 1 FROM core_content_item WHERE content_id = ?').get(shared)).toBeTruthy();
  const stillCurrent = db.vault
    .prepare('SELECT current_content_id FROM core_document WHERE document_id = ?')
    .get(documentId) as { current_content_id: string };
  expect(stillCurrent.current_content_id).toBe(shared);
});

test('trash_document refuses on an unknown or already-trashed document', () => {
  const { documentId } = addDocument({ data_uri: PDF, title: 'Once.pdf' });
  expect(invoke('core.trash_document', { document_id: documentId }).status).toBe('executed');
  const again = invoke('core.trash_document', { document_id: documentId });
  expect(again.status).toBe('failed');
  if (again.status === 'failed') expect(again.predicate).toContain('document_exists');
});
