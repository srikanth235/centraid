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
