import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { registerTagCommands } from './tags.js';
import { registerTaskCommands } from './tasks.js';
import { registerKnowledgeCommands } from './knowledge.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
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

test('tag_item creates a shared Tags scheme + concept and records the edge', () => {
  const taskId = addTask('File taxes');
  const out = invoke('core.tag_item', {
    subject_type: 'schedule.task',
    subject_id: taskId,
    label: 'Urgent',
  });
  expect(out.status).toBe('executed');
  const output = (out as { output: { tag_id: string; concept_id: string; notation: string } }).output;
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
  const first = invoke('core.tag_item', { subject_type: 'schedule.task', subject_id: taskId, label: 'urgent' });
  const second = invoke('core.tag_item', { subject_type: 'schedule.task', subject_id: taskId, label: 'URGENT  ' });
  expect(first.status).toBe('executed');
  expect(second.status).toBe('executed');
  const firstId = (first as { output: { tag_id: string } }).output.tag_id;
  const secondId = (second as { output: { tag_id: string } }).output.tag_id;
  expect(secondId).toBe(firstId);
  const count = db.vault.prepare('SELECT count(*) AS n FROM core_tag').get() as { n: number };
  expect(count.n).toBe(1);
});

test('the same label tags both a task and a note under one shared concept', () => {
  const taskId = addTask('File taxes');
  const noteId = addNote('Tax notes');
  const onTask = invoke('core.tag_item', { subject_type: 'schedule.task', subject_id: taskId, label: 'finance' });
  const onNote = invoke('core.tag_item', { subject_type: 'knowledge.note', subject_id: noteId, label: 'finance' });
  expect(onTask.status).toBe('executed');
  expect(onNote.status).toBe('executed');
  const taskConcept = (onTask as { output: { concept_id: string } }).output.concept_id;
  const noteConcept = (onNote as { output: { concept_id: string } }).output.concept_id;
  expect(noteConcept).toBe(taskConcept);
});

test('tag_item refuses an unknown subject type and a missing subject', () => {
  const badType = invoke('core.tag_item', { subject_type: 'core.event', subject_id: 'x', label: 'a' });
  expect(badType.status).toBe('failed');
  const missing = invoke('core.tag_item', { subject_type: 'schedule.task', subject_id: 'ghost', label: 'a' });
  expect(missing.status).toBe('failed');
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
  const tagRow = db.vault.prepare('SELECT count(*) AS n FROM core_tag WHERE tag_id = ?').get(tagId) as {
    n: number;
  };
  expect(tagRow.n).toBe(0);
  const concept = db.vault
    .prepare('SELECT pref_label FROM core_concept WHERE concept_id = ?')
    .get(conceptId);
  expect(concept).toEqual({ pref_label: 'unmistakably-unique-label' });
});

test('untag_item on an unknown tag is refused', () => {
  const out = invoke('core.untag_item', { tag_id: 'ghost' });
  expect(out.status).toBe('failed');
});
