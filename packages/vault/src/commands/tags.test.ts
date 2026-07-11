import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { registerDocumentCommands } from './documents.js';
import { registerKnowledgeCommands } from './knowledge.js';
import { registerMediaCommands } from './media.js';
import { registerTagCommands } from './tags.js';
import { registerTaskCommands } from './tasks.js';

const PIXEL =
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
  registerMediaCommands(gw);
  registerTagCommands(gw);
  registerTaskCommands(gw);
  registerKnowledgeCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

function invoke(command: string, input: Record<string, unknown>) {
  return gw.invoke(owner, { command, input, purpose: 'dpv:ServiceProvision' });
}

function addTask(title: string): string {
  const out = invoke('schedule.add_task', { title });
  expect(out.status).toBe('executed');
  return (out as { output: { task_id: string } }).output.task_id;
}

function addNote(title: string): string {
  const out = invoke('knowledge.create_note', { title, body_text: 'body' });
  expect(out.status).toBe('executed');
  return (out as { output: { note_id: string } }).output.note_id;
}

function addDocument(): string {
  const outcome = invoke('core.add_document', {
    data_uri: 'data:text/plain;charset=utf-8,hello',
    title: 'Lease',
  });
  expect(outcome.status).toBe('executed');
  return (outcome as { output: { document_id: string } }).output.document_id;
}

function addAsset(): string {
  const outcome = invoke('media.add_asset', { data_uri: PIXEL });
  expect(outcome.status).toBe('executed');
  return (outcome as { output: { asset_id: string } }).output.asset_id;
}

test('tag_item creates a shared Tags scheme + concept and records the edge', () => {
  const taskId = addTask('File taxes');
  const out = invoke('core.tag_item', {
    subject_type: 'schedule.task',
    subject_id: taskId,
    label: 'Urgent',
  });
  expect(out.status).toBe('executed');
  const output = (out as { output: { tag_id: string; concept_id: string; notation: string } })
    .output;
  expect(output.notation).toBe('urgent');
  const scheme = db.vault
    .prepare('SELECT title FROM core_concept_scheme WHERE uri = ?')
    .get('centraid:tags:v1') as { title: string } | undefined;
  expect(scheme).toEqual({ title: 'Tags' });
  const concept = db.vault
    .prepare('SELECT pref_label, notation FROM core_concept WHERE concept_id = ?')
    .get(output.concept_id);
  expect(concept).toEqual({ pref_label: 'Urgent', notation: 'urgent' });
  const tag = db.vault
    .prepare('SELECT target_type, target_id, tagged_by_party_id FROM core_tag WHERE tag_id = ?')
    .get(output.tag_id);
  expect(tag).toMatchObject({ target_type: 'schedule.task', target_id: taskId });
});

test('tag_item on the same subject+label twice is idempotent, not a duplicate', () => {
  const taskId = addTask('File taxes');
  const first = invoke('core.tag_item', {
    subject_type: 'schedule.task',
    subject_id: taskId,
    label: 'urgent',
  });
  const second = invoke('core.tag_item', {
    subject_type: 'schedule.task',
    subject_id: taskId,
    label: 'URGENT  ',
  });
  expect(first.status).toBe('executed');
  expect(second.status).toBe('executed');
  const firstId = (first as { output: { tag_id: string } }).output.tag_id;
  const secondId = (second as { output: { tag_id: string } }).output.tag_id;
  expect(secondId).toBe(firstId);
  const count = db.vault.prepare('SELECT count(*) AS n FROM core_tag').get() as { n: number };
  expect(count.n).toBe(1);
});

test('the same label tags a task, a note, a document and a media asset under one shared concept', () => {
  const taskId = addTask('File taxes');
  const noteId = addNote('Tax notes');
  const documentId = addDocument();
  const assetId = addAsset();
  const onTask = invoke('core.tag_item', {
    subject_type: 'schedule.task',
    subject_id: taskId,
    label: 'finance',
  });
  const onNote = invoke('core.tag_item', {
    subject_type: 'knowledge.note',
    subject_id: noteId,
    label: 'finance',
  });
  const onDocument = invoke('core.tag_item', {
    subject_type: 'core.document',
    subject_id: documentId,
    label: 'finance',
  });
  const onAsset = invoke('core.tag_item', {
    subject_type: 'media.media_asset',
    subject_id: assetId,
    label: 'finance',
  });
  for (const out of [onTask, onNote, onDocument, onAsset]) expect(out.status).toBe('executed');
  const conceptIds = new Set(
    [onTask, onNote, onDocument, onAsset].map(
      (out) => (out as { output: { concept_id: string } }).output.concept_id,
    ),
  );
  expect(conceptIds.size).toBe(1);
});

test('tag_item refuses an unknown subject type and a missing subject', () => {
  const badType = invoke('core.tag_item', {
    subject_type: 'core.event',
    subject_id: 'x',
    label: 'a',
  });
  expect(badType.status).toBe('failed');
  const missing = invoke('core.tag_item', {
    subject_type: 'schedule.task',
    subject_id: 'ghost',
    label: 'a',
  });
  expect(missing.status).toBe('failed');
});

test('tag_item refuses a trashed document (live check applies to soft-deletable subjects)', () => {
  const documentId = addDocument();
  invoke('core.trash_document', { document_id: documentId });
  const trashed = invoke('core.tag_item', {
    subject_type: 'core.document',
    subject_id: documentId,
    label: 'Taxes',
  });
  expect(trashed.status).toBe('failed');
});

test('tagging is additive and multi-label on a document', () => {
  const documentId = addDocument();
  invoke('core.tag_item', {
    subject_type: 'core.document',
    subject_id: documentId,
    label: 'Taxes',
  });
  invoke('core.tag_item', {
    subject_type: 'core.document',
    subject_id: documentId,
    label: 'Important',
  });
  // Scoped to the Tags scheme — core.add_document also files one
  // folders-scheme tag on every document (documents.ts), a separate
  // single-tag mechanism this count must not conflate with.
  const count = db.vault
    .prepare(
      `SELECT count(*) AS n FROM core_tag t
         JOIN core_concept c ON c.concept_id = t.concept_id
         JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
        WHERE t.target_type = ? AND t.target_id = ? AND s.uri = 'centraid:tags:v1'`,
    )
    .get('core.document', documentId) as { n: number };
  expect(count.n).toBe(2);
});

test('untag_item removes the edge; the concept and scheme survive for other subjects', () => {
  const taskId = addTask('File taxes');
  const out = invoke('core.tag_item', {
    subject_type: 'schedule.task',
    subject_id: taskId,
    label: 'unmistakably-unique-label',
  });
  const { tag_id: tagId, concept_id: conceptId } = (
    out as { output: { tag_id: string; concept_id: string } }
  ).output;
  const removed = invoke('core.untag_item', { tag_id: tagId });
  expect(removed.status).toBe('executed');
  const tagRow = db.vault
    .prepare('SELECT count(*) AS n FROM core_tag WHERE tag_id = ?')
    .get(tagId) as {
    n: number;
  };
  expect(tagRow.n).toBe(0);
  const concept = db.vault
    .prepare('SELECT pref_label FROM core_concept WHERE concept_id = ?')
    .get(conceptId);
  expect(concept).toEqual({ pref_label: 'unmistakably-unique-label' });
});

test('untag_item removes exactly the named edge on a media asset, leaving others intact', () => {
  const assetId = addAsset();
  const trip = invoke('core.tag_item', {
    subject_type: 'media.media_asset',
    subject_id: assetId,
    label: 'Trip',
  });
  invoke('core.tag_item', {
    subject_type: 'media.media_asset',
    subject_id: assetId,
    label: 'Beach',
  });
  const tripTagId = (trip as { output: { tag_id: string } }).output.tag_id;
  const outcome = invoke('core.untag_item', { tag_id: tripTagId });
  expect(outcome.status).toBe('executed');
  const remaining = db.vault
    .prepare(
      `SELECT c.notation FROM core_tag t JOIN core_concept c ON c.concept_id = t.concept_id
        WHERE t.target_type = ? AND t.target_id = ?`,
    )
    .all('media.media_asset', assetId) as { notation: string }[];
  expect(remaining.map((r) => r.notation)).toEqual(['beach']);
});

test('untag_item on an unknown tag is refused', () => {
  const out = invoke('core.untag_item', { tag_id: 'ghost' });
  expect(out.status).toBe('failed');
});

test('labels are readable through the standard entity read path (no dedicated query needed)', () => {
  const documentId = addDocument();
  invoke('core.tag_item', {
    subject_type: 'core.document',
    subject_id: documentId,
    label: 'Taxes',
  });
  // The exact three-read pattern an app-plane query already uses for the
  // flags-scheme star (photos/queries/library.js) works verbatim for labels.
  const scheme = gw.read(owner, {
    entity: 'core.concept_scheme',
    where: [{ column: 'uri', op: 'eq', value: 'centraid:tags:v1' }],
    purpose: 'dpv:ServiceProvision',
  }).rows[0] as { scheme_id: string };
  const concepts = gw.read(owner, {
    entity: 'core.concept',
    where: [{ column: 'scheme_id', op: 'eq', value: scheme.scheme_id }],
    purpose: 'dpv:ServiceProvision',
  }).rows;
  const tags = gw.read(owner, {
    entity: 'core.tag',
    where: [
      { column: 'target_type', op: 'eq', value: 'core.document' },
      { column: 'target_id', op: 'eq', value: documentId },
    ],
    purpose: 'dpv:ServiceProvision',
  }).rows;
  const labelIds = new Set(tags.map((t) => t.concept_id));
  const labels = concepts.filter((c) => labelIds.has(c.concept_id)).map((c) => c.pref_label);
  expect(labels).toEqual(['Taxes']);
});
