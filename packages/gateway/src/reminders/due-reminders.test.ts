import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, createGateway, openVaultDb, registerScheduleCommands, registerTaskCommands } from '@centraid/vault';
import type { Gateway, Credential, VaultDb } from '@centraid/vault';
import { computeDueReminders } from './due-reminders.js';

let db: VaultDb;
let gw: Gateway;
let owner: Credential;
let calendarId: string;

beforeEach(() => {
  db = openVaultDb();
  const boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerTaskCommands(gw);
  registerScheduleCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
  calendarId = 'cal-1';
  db.vault
    .prepare(
      `INSERT INTO schedule_calendar (calendar_id, owner_party_id, name, default_tz, visibility)
       VALUES (?, ?, 'Personal', 'Asia/Kolkata', 'private')`,
    )
    .run(calendarId, boot.ownerPartyId);
});

function invoke(command: string, input: Record<string, unknown>) {
  return gw.invoke(owner, { command, input, purpose: 'dpv:ServiceProvision' });
}

test('a task reminder fires once now reaches due_at minus remind_before_min', () => {
  invoke('schedule.add_task', {
    title: 'Call the dentist',
    due_at: '2026-07-10T09:00:00.000Z',
    remind_before_min: 15,
  });
  const tooEarly = computeDueReminders(db, '2026-07-10T08:44:00.000Z');
  expect(tooEarly).toEqual([]);
  const dueNow = computeDueReminders(db, '2026-07-10T08:45:00.000Z');
  expect(dueNow).toHaveLength(1);
  expect(dueNow[0]).toMatchObject({
    kind: 'task',
    title: 'Call the dentist',
    minutesBefore: 15,
  });
});

test('a completed task never reminds even past its fire time', () => {
  const outcome = invoke('schedule.add_task', {
    title: 'Call the dentist',
    due_at: '2026-07-10T09:00:00.000Z',
    remind_before_min: 15,
  });
  const taskId = (outcome as { output: { task_id: string } }).output.task_id;
  invoke('schedule.set_task_status', { task_id: taskId, status: 'completed' });
  expect(computeDueReminders(db, '2026-07-10T09:00:00.000Z')).toEqual([]);
});

test('a reminder goes stale well after its due time and stops firing', () => {
  invoke('schedule.add_task', {
    title: 'Ancient errand',
    due_at: '2026-01-01T09:00:00.000Z',
    remind_before_min: 10,
  });
  expect(computeDueReminders(db, '2026-07-10T09:00:00.000Z')).toEqual([]);
});

test('an event reminder fires from reminders_json, keyed per lead time', () => {
  const outcome = invoke('schedule.propose_event', {
    summary: 'Weekly standup',
    dtstart: '2026-07-06T09:00:00.000Z',
    dtend: '2026-07-06T09:15:00.000Z',
    calendar_id: calendarId,
    reminders: [{ minutes_before: 10 }, { minutes_before: 0 }],
  });
  expect(outcome.status).toBe('executed');
  const eventId = (outcome as { output: { event_id: string } }).output.event_id;

  const tenMinBefore = computeDueReminders(db, '2026-07-06T08:50:00.000Z');
  expect(tenMinBefore).toHaveLength(1);
  expect(tenMinBefore[0]).toMatchObject({ kind: 'event', id: eventId, minutesBefore: 10 });

  const atStart = computeDueReminders(db, '2026-07-06T09:00:00.000Z');
  expect(atStart).toHaveLength(2);
  expect(atStart.map((r) => r.key).sort()).toEqual(
    [`event:${eventId}:0`, `event:${eventId}:10`].sort(),
  );
});

test('a cancelled event never reminds', () => {
  const outcome = invoke('schedule.propose_event', {
    summary: 'Cancel me',
    dtstart: '2026-07-06T09:00:00.000Z',
    dtend: '2026-07-06T09:15:00.000Z',
    calendar_id: calendarId,
    reminders: [{ minutes_before: 10 }],
  });
  const eventId = (outcome as { output: { event_id: string } }).output.event_id;
  invoke('schedule.cancel_event', { event_id: eventId });
  expect(computeDueReminders(db, '2026-07-06T09:00:00.000Z')).toEqual([]);
});
