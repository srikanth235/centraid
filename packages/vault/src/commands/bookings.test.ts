import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { uuidv7 } from '../ids.js';
import { registerBookingCommands } from './bookings.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;
let calendarId: string;
let requesterId: string;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerBookingCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
  calendarId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO schedule_calendar (calendar_id, owner_party_id, name, color, default_tz, visibility, external_uri)
       VALUES (?, ?, 'Work', NULL, 'Europe/Berlin', 'private', NULL)`,
    )
    .run(calendarId, boot.ownerPartyId);
  requesterId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO core_party (party_id, kind, display_name, sort_name, birth_date, avatar_content_id, created_at, updated_at, ontology_version)
       VALUES (?, 'person', 'Client Bob', NULL, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '0')`,
    )
    .run(requesterId);
});

function invoke(command: string, input: Record<string, unknown>) {
  return gw.invoke(owner, { command, input, purpose: 'dpv:ServiceProvision' });
}

function setAllDayAvailability(): void {
  const out = invoke('schedule.set_availability', {
    weekday_mask: 127, // every day
    window_start: '09:00',
    window_end: '17:00',
    tz: 'Europe/Berlin',
  });
  expect(out.status).toBe('executed');
}

function requestBooking(dtstart: string, dtend: string) {
  return invoke('schedule.request_booking', {
    calendar_id: calendarId,
    summary: 'Discovery call',
    dtstart,
    dtend,
    requester_party_id: requesterId,
  });
}

test('set_availability records a weekly window; a backwards window is refused', () => {
  setAllDayAvailability();
  const rule = db.vault
    .prepare('SELECT weekday_mask, window_start, window_end, kind FROM schedule_availability_rule')
    .get();
  expect(rule).toMatchObject({
    weekday_mask: 127,
    window_start: '09:00',
    window_end: '17:00',
    kind: 'work',
  });

  const backwards = invoke('schedule.set_availability', {
    weekday_mask: 1,
    window_start: '17:00',
    window_end: '09:00',
    tz: 'Europe/Berlin',
  });
  expect(backwards.status).toBe('failed');
  if (backwards.status === 'failed') expect(backwards.predicate).toContain('window_is_positive');
});

test('request_booking holds a tentative slot inside availability, then confirm promotes it', () => {
  setAllDayAvailability();
  const booked = requestBooking('2026-07-06T10:00:00Z', '2026-07-06T11:00:00Z');
  expect(booked.status).toBe('executed');
  const { event_id, status } = (booked as { output: { event_id: string; status: string } }).output;
  expect(status).toBe('tentative');
  const ext = db.vault
    .prepare('SELECT busy FROM schedule_event_ext WHERE event_id = ?')
    .get(event_id) as { busy: string };
  expect(ext.busy).toBe('busy');
  const attendee = db.vault
    .prepare('SELECT party_id, partstat FROM schedule_attendee WHERE event_id = ?')
    .get(event_id);
  expect(attendee).toMatchObject({ party_id: requesterId, partstat: 'accepted' });

  const confirmed = invoke('schedule.confirm_booking', { event_id });
  expect(confirmed.status).toBe('executed');
  const ev = db.vault.prepare('SELECT status FROM core_event WHERE event_id = ?').get(event_id) as {
    status: string;
  };
  expect(ev.status).toBe('confirmed');
});

test('a slot outside availability is refused', () => {
  setAllDayAvailability();
  const late = requestBooking('2026-07-06T20:00:00Z', '2026-07-06T21:00:00Z');
  expect(late.status).toBe('failed');
  if (late.status === 'failed') expect(late.reason).toContain('outside your availability');
});

test('a slot overlapping an existing busy hold is refused', () => {
  setAllDayAvailability();
  const first = requestBooking('2026-07-06T10:00:00Z', '2026-07-06T11:00:00Z');
  expect(first.status).toBe('executed');
  const overlap = requestBooking('2026-07-06T10:30:00Z', '2026-07-06T11:30:00Z');
  expect(overlap.status).toBe('failed');
  if (overlap.status === 'failed') expect(overlap.predicate).toContain('no_busy_conflict');
});

test('remove_availability deletes a rule and leaves the others standing', () => {
  setAllDayAvailability();
  const weekend = invoke('schedule.set_availability', {
    weekday_mask: 96, // Saturday + Sunday
    window_start: '10:00',
    window_end: '14:00',
    tz: 'Europe/Berlin',
  });
  expect(weekend.status).toBe('executed');
  const weekendRuleId = (weekend as { output: { rule_id: string } }).output.rule_id;

  const removed = invoke('schedule.remove_availability', { rule_id: weekendRuleId });
  expect(removed.status).toBe('executed');
  expect((removed as { output: { rule_id: string } }).output.rule_id).toBe(weekendRuleId);

  const gone = db.vault
    .prepare('SELECT count(*) AS n FROM schedule_availability_rule WHERE rule_id = ?')
    .get(weekendRuleId) as { n: number };
  expect(gone.n).toBe(0);
  const survivors = db.vault
    .prepare('SELECT weekday_mask FROM schedule_availability_rule')
    .all() as Array<{ weekday_mask: number }>;
  expect(survivors).toEqual([{ weekday_mask: 127 }]);
});

test('remove_availability refuses a rule that does not exist', () => {
  setAllDayAvailability();
  const ghost = invoke('schedule.remove_availability', { rule_id: 'no-such-rule' });
  expect(ghost.status).toBe('failed');
  if (ghost.status === 'failed') expect(ghost.predicate).toContain('rule_exists');
  const untouched = db.vault
    .prepare('SELECT count(*) AS n FROM schedule_availability_rule')
    .get() as { n: number };
  expect(untouched.n).toBe(1);
});

test('confirm_booking only promotes a tentative hold', () => {
  const ghost = invoke('schedule.confirm_booking', { event_id: 'no-such-event' });
  expect(ghost.status).toBe('failed');
  if (ghost.status === 'failed') expect(ghost.predicate).toContain('booking_is_tentative');
});
