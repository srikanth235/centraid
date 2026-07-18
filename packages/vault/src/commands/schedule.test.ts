// The propose/reschedule/RSVP loop is exercised in gateway.test.ts; this
// file covers the pack's own additions, starting with cancel_event.

import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { uuidv7 } from '../ids.js';
import { registerScheduleCommands } from './schedule.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;
let calendarId: string;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerScheduleCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
  calendarId = uuidv7();
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

function proposeEvent(): string {
  const outcome = invoke('schedule.propose_event', {
    summary: 'Dentist',
    dtstart: '2026-07-10T09:00:00Z',
    dtend: '2026-07-10T09:30:00Z',
    calendar_id: calendarId,
  });
  expect(outcome.status).toBe('executed');
  return (outcome as { output: { event_id: string } }).output.event_id;
}

test('propose_event stores rrule, conferencing_uri and reminders', () => {
  const outcome = invoke('schedule.propose_event', {
    summary: 'Weekly standup',
    dtstart: '2026-07-06T09:00:00Z',
    dtend: '2026-07-06T09:15:00Z',
    calendar_id: calendarId,
    start_tz: 'Asia/Kolkata',
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    conferencing_uri: 'https://meet.example.com/standup',
    reminders: [{ minutes_before: 10 }, { minutes_before: 0 }],
  });
  expect(outcome.status).toBe('executed');
  const eventId = (outcome as { output: { event_id: string } }).output.event_id;
  const event = db.vault
    .prepare('SELECT start_tz, rrule FROM core_event WHERE event_id = ?')
    .get(eventId) as { start_tz: string; rrule: string };
  expect(event).toEqual({ start_tz: 'Asia/Kolkata', rrule: 'FREQ=WEEKLY;BYDAY=MO' });
  const ext = db.vault
    .prepare('SELECT conferencing_uri, reminders_json FROM schedule_event_ext WHERE event_id = ?')
    .get(eventId) as { conferencing_uri: string; reminders_json: string };
  expect(ext.conferencing_uri).toBe('https://meet.example.com/standup');
  expect(JSON.parse(ext.reminders_json)).toEqual([{ minutes_before: 10 }, { minutes_before: 0 }]);
});

test('propose_event refuses an unrecognized repeat rule', () => {
  const outcome = invoke('schedule.propose_event', {
    summary: 'Bad rule',
    dtstart: '2026-07-06T09:00:00Z',
    dtend: '2026-07-06T09:15:00Z',
    calendar_id: calendarId,
    rrule: 'every monday',
  });
  expect(outcome.status).toBe('failed');
  if (outcome.status === 'failed') expect(outcome.predicate).toContain('not recognized');
});

test('an iCalendar chair, when present, must be the event organizer', () => {
  const eventId = proposeEvent();
  const otherPartyId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO core_party
         (party_id, kind, display_name, created_at, updated_at, ontology_version)
       VALUES (?, 'person', 'Asha', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '1.4')`,
    )
    .run(otherPartyId);

  expect(() =>
    db.vault
      .prepare(
        `INSERT INTO schedule_attendee
           (attendee_id, event_id, party_id, role, partstat)
         VALUES (?, ?, ?, 'chair', 'accepted')`,
      )
      .run(uuidv7(), eventId, otherPartyId),
  ).toThrow(/must match the event organizer/);

  db.vault
    .prepare(
      `INSERT INTO schedule_attendee
         (attendee_id, event_id, party_id, role, partstat)
       VALUES (?, ?, ?, 'chair', 'accepted')`,
    )
    .run(uuidv7(), eventId, boot.ownerPartyId);
  expect(() =>
    db.vault
      .prepare('UPDATE core_event SET organizer_party_id = ? WHERE event_id = ?')
      .run(otherPartyId, eventId),
  ).toThrow(/must match its chair attendee/);
});

test('cancel_event marks the event cancelled as a SEQUENCE revision, not a vanish', () => {
  const eventId = proposeEvent();
  const before = db.vault
    .prepare('SELECT sequence FROM core_event WHERE event_id = ?')
    .get(eventId) as { sequence: number };
  const outcome = invoke('schedule.cancel_event', { event_id: eventId });
  expect(outcome.status).toBe('executed');
  const event = db.vault
    .prepare('SELECT status, sequence FROM core_event WHERE event_id = ?')
    .get(eventId) as { status: string; sequence: number };
  expect(event.status).toBe('cancelled');
  expect(event.sequence).toBe(before.sequence + 1);
});

test('cancel_event refuses an already-cancelled event and a missing one', () => {
  const eventId = proposeEvent();
  invoke('schedule.cancel_event', { event_id: eventId });
  const again = invoke('schedule.cancel_event', { event_id: eventId });
  expect(again.status).toBe('failed');
  if (again.status === 'failed') expect(again.predicate).toContain('event_exists_not_cancelled');
  const missing = invoke('schedule.cancel_event', { event_id: 'no-such-event' });
  expect(missing.status).toBe('failed');
});
