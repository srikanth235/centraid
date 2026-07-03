import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { registerTaskCommands } from './tasks.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerTaskCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

function addTask(input: Record<string, unknown>): string {
  const outcome = gw.invoke(owner, {
    command: 'schedule.add_task',
    input,
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('executed');
  return (outcome as { output: { task_id: string } }).output.task_id;
}

test('add_task creates an open VTODO with defaults and provenance', () => {
  const taskId = addTask({ title: 'File the GST return', due_at: '2026-07-20', priority: 1 });
  const row = db.vault.prepare('SELECT * FROM schedule_task WHERE task_id = ?').get(taskId);
  expect(row).toMatchObject({
    title: 'File the GST return',
    status: 'needs-action',
    priority: 1,
    due_at: '2026-07-20',
    completed_at: null,
    owner_party_id: boot.ownerPartyId,
  });
  const prov = db.journal
    .prepare(
      `SELECT count(*) AS n FROM consent_provenance
        WHERE entity_type='schedule.task' AND entity_id=? AND prov_activity='command.schedule.add_task'`,
    )
    .get(taskId) as { n: number };
  expect(prov.n).toBe(1);
});

test('add_task nests one level: subtask of a subtask is refused', () => {
  const parent = addTask({ title: 'Plan the trip' });
  const child = addTask({ title: 'Book flights', parent_task_id: parent });
  const grandchild = gw.invoke(owner, {
    command: 'schedule.add_task',
    input: { title: 'Pick seats', parent_task_id: child },
    purpose: 'dpv:ServiceProvision',
  });
  expect(grandchild.status).toBe('failed');
  if (grandchild.status === 'failed')
    expect(grandchild.predicate).toContain('parent_open_and_top_level');
});

test('add_task under a missing or closed parent is refused', () => {
  const missing = gw.invoke(owner, {
    command: 'schedule.add_task',
    input: { title: 'Orphan', parent_task_id: 'no-such-task' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(missing.status).toBe('failed');
  const parent = addTask({ title: 'Done project' });
  gw.invoke(owner, {
    command: 'schedule.set_task_status',
    input: { task_id: parent, status: 'completed' },
    purpose: 'dpv:ServiceProvision',
  });
  const late = gw.invoke(owner, {
    command: 'schedule.add_task',
    input: { title: 'Too late', parent_task_id: parent },
    purpose: 'dpv:ServiceProvision',
  });
  expect(late.status).toBe('failed');
});

test('set_task_status completes with a stamp and reopening clears it', () => {
  const taskId = addTask({ title: 'Water the plants' });
  const done = gw.invoke(owner, {
    command: 'schedule.set_task_status',
    input: { task_id: taskId, status: 'completed' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(done.status).toBe('executed');
  let row = db.vault
    .prepare('SELECT status, completed_at FROM schedule_task WHERE task_id = ?')
    .get(taskId) as { status: string; completed_at: string | null };
  expect(row.status).toBe('completed');
  expect(row.completed_at).not.toBeNull();

  const reopened = gw.invoke(owner, {
    command: 'schedule.set_task_status',
    input: { task_id: taskId, status: 'needs-action' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(reopened.status).toBe('executed');
  row = db.vault
    .prepare('SELECT status, completed_at FROM schedule_task WHERE task_id = ?')
    .get(taskId) as { status: string; completed_at: string | null };
  expect(row).toMatchObject({ status: 'needs-action', completed_at: null });
});

test('set_task_status on an unknown task is refused by precondition', () => {
  const outcome = gw.invoke(owner, {
    command: 'schedule.set_task_status',
    input: { task_id: 'ghost', status: 'completed' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('failed');
  if (outcome.status === 'failed') expect(outcome.predicate).toContain('task_exists');
});

test('edit_task updates only the fields sent and reads them back', () => {
  const taskId = addTask({ title: 'Draft the proposal', due_at: '2026-07-10', priority: 5 });
  const outcome = gw.invoke(owner, {
    command: 'schedule.edit_task',
    input: { task_id: taskId, title: 'Draft + send the proposal', priority: 1, effort_min: 90 },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('executed');
  const row = db.vault.prepare('SELECT * FROM schedule_task WHERE task_id = ?').get(taskId);
  expect(row).toMatchObject({
    title: 'Draft + send the proposal',
    priority: 1,
    effort_min: 90,
    due_at: '2026-07-10', // untouched
  });
});

test('edit_task clear_due removes the date; sending due_at with clear_due is refused', () => {
  const taskId = addTask({ title: 'Someday item', due_at: '2026-08-01' });
  const cleared = gw.invoke(owner, {
    command: 'schedule.edit_task',
    input: { task_id: taskId, clear_due: true },
    purpose: 'dpv:ServiceProvision',
  });
  expect(cleared.status).toBe('executed');
  const row = db.vault
    .prepare('SELECT due_at FROM schedule_task WHERE task_id = ?')
    .get(taskId) as { due_at: string | null };
  expect(row.due_at).toBeNull();

  const both = gw.invoke(owner, {
    command: 'schedule.edit_task',
    input: { task_id: taskId, due_at: '2026-08-02', clear_due: true },
    purpose: 'dpv:ServiceProvision',
  });
  expect(both.status).toBe('failed');
  if (both.status === 'failed') expect(both.predicate).toContain('due_set_and_clear_are_exclusive');
});

test('description rides add_task, edit_task sets it, clear_description removes it', () => {
  const taskId = addTask({ title: 'Book flights', description: 'Window seat if possible' });
  let row = db.vault
    .prepare('SELECT description FROM schedule_task WHERE task_id = ?')
    .get(taskId) as { description: string | null };
  expect(row.description).toBe('Window seat if possible');

  const edited = gw.invoke(owner, {
    command: 'schedule.edit_task',
    input: { task_id: taskId, description: 'Aisle seat, actually' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(edited.status).toBe('executed');

  // Editing an unrelated field leaves the note alone.
  const titled = gw.invoke(owner, {
    command: 'schedule.edit_task',
    input: { task_id: taskId, title: 'Book flights to Goa' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(titled.status).toBe('executed');
  row = db.vault.prepare('SELECT description FROM schedule_task WHERE task_id = ?').get(taskId) as {
    description: string | null;
  };
  expect(row.description).toBe('Aisle seat, actually');

  const cleared = gw.invoke(owner, {
    command: 'schedule.edit_task',
    input: { task_id: taskId, clear_description: true },
    purpose: 'dpv:ServiceProvision',
  });
  expect(cleared.status).toBe('executed');
  row = db.vault.prepare('SELECT description FROM schedule_task WHERE task_id = ?').get(taskId) as {
    description: string | null;
  };
  expect(row.description).toBeNull();

  // Set and clear together is a contradiction, refused.
  const both = gw.invoke(owner, {
    command: 'schedule.edit_task',
    input: { task_id: taskId, description: 'x', clear_description: true },
    purpose: 'dpv:ServiceProvision',
  });
  expect(both.status).toBe('failed');
});
