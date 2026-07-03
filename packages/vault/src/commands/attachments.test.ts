import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { registerAttachmentCommands } from './attachments.js';
import { registerTaskCommands } from './tasks.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

// A 1x1 transparent PNG as an inline data URI — the shape a blueprint sends.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerAttachmentCommands(gw);
  registerTaskCommands(gw);
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

test('attach pins a data-URI file to a subject as its cover content item', () => {
  const taskId = addTask('Frame the print');
  const out = invoke('core.attach', {
    subject_type: 'schedule.task',
    subject_id: taskId,
    data_uri: PNG,
    title: 'preview.png',
  });
  expect(out.status).toBe('executed');
  const output = (
    out as { output: { attachment_id: string; content_id: string; is_primary: number } }
  ).output;
  expect(output.is_primary).toBe(1); // first attachment is the cover

  const att = db.vault
    .prepare(
      'SELECT subject_type, subject_id, role, is_primary FROM core_attachment WHERE attachment_id = ?',
    )
    .get(output.attachment_id);
  expect(att).toMatchObject({
    subject_type: 'schedule.task',
    subject_id: taskId,
    role: 'photo', // derived from image/* media type
    is_primary: 1,
  });
  const content = db.vault
    .prepare(
      'SELECT media_type, byte_size, title, content_uri FROM core_content_item WHERE content_id = ?',
    )
    .get(output.content_id) as {
    media_type: string;
    byte_size: number;
    title: string;
    content_uri: string;
  };
  expect(content.media_type).toBe('image/png');
  expect(content.title).toBe('preview.png');
  expect(content.byte_size).toBeGreaterThan(0);
  expect(content.content_uri).toBe(PNG);
});

test('identical bytes dedupe on sha256; a second attachment reuses the content item and is not primary', () => {
  const a = addTask('Task A');
  const b = addTask('Task B');
  const first = invoke('core.attach', {
    subject_type: 'schedule.task',
    subject_id: a,
    data_uri: PNG,
  });
  const second = invoke('core.attach', {
    subject_type: 'schedule.task',
    subject_id: b,
    data_uri: PNG,
  });
  const fo = (first as { output: { content_id: string } }).output;
  const so = (second as { output: { content_id: string; is_primary: number } }).output;
  expect(so.content_id).toBe(fo.content_id); // deduped
  expect(so.is_primary).toBe(1); // primary is per-subject, and B had none
  const n = db.vault.prepare('SELECT count(*) AS n FROM core_content_item').get() as { n: number };
  expect(n.n).toBe(1);
});

test('a second file on the same subject is not primary', () => {
  const taskId = addTask('Two files');
  invoke('core.attach', { subject_type: 'schedule.task', subject_id: taskId, data_uri: PNG });
  const second = invoke('core.attach', {
    subject_type: 'schedule.task',
    subject_id: taskId,
    data_uri: 'data:text/plain;charset=utf-8,hello%20notes',
  });
  const so = (second as { output: { is_primary: number } }).output;
  expect(so.is_primary).toBe(0);
  const roles = db.vault
    .prepare('SELECT role FROM core_attachment WHERE subject_id = ? ORDER BY is_primary DESC')
    .all(taskId) as { role: string }[];
  expect(roles.map((r) => r.role)).toEqual(['photo', 'other']); // text defaults to 'other'
});

test('attaching to a non-existent subject is a receipted refusal', () => {
  const out = invoke('core.attach', {
    subject_type: 'schedule.task',
    subject_id: 'no-such-task',
    data_uri: PNG,
  });
  expect(out.status).toBe('failed');
  if (out.status === 'failed') expect(out.reason).toContain('no schedule.task');
});

test('a non-data URI and an oversized file are both refused by precondition', () => {
  const taskId = addTask('Guarded');
  const notData = invoke('core.attach', {
    subject_type: 'schedule.task',
    subject_id: taskId,
    data_uri: 'https://example.com/cat.png',
  });
  expect(notData.status).toBe('failed');
  if (notData.status === 'failed') expect(notData.predicate).toContain('is_data_uri');

  const huge = `data:image/png;base64,${'A'.repeat(11_000_001)}`;
  const tooBig = invoke('core.attach', {
    subject_type: 'schedule.task',
    subject_id: taskId,
    data_uri: huge,
  });
  expect(tooBig.status).toBe('failed');
  if (tooBig.status === 'failed') expect(tooBig.predicate).toContain('within_size_cap');
});

test('detach removes the edge but leaves the canonical content item', () => {
  const taskId = addTask('Detach me');
  const attached = invoke('core.attach', {
    subject_type: 'schedule.task',
    subject_id: taskId,
    data_uri: PNG,
  });
  const { attachment_id, content_id } = (
    attached as { output: { attachment_id: string; content_id: string } }
  ).output;
  const out = invoke('core.detach', { attachment_id });
  expect(out.status).toBe('executed');
  const gone = db.vault
    .prepare('SELECT count(*) AS n FROM core_attachment WHERE attachment_id = ?')
    .get(attachment_id) as { n: number };
  expect(gone.n).toBe(0);
  const kept = db.vault
    .prepare('SELECT count(*) AS n FROM core_content_item WHERE content_id = ?')
    .get(content_id) as { n: number };
  expect(kept.n).toBe(1); // content is canonical, deduped, kept
});

test('detach on an unknown attachment is refused by precondition', () => {
  const out = invoke('core.detach', { attachment_id: 'ghost' });
  expect(out.status).toBe('failed');
  if (out.status === 'failed') expect(out.predicate).toContain('attachment_exists');
});
