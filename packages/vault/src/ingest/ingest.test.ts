import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:evt-1@example.com',
  'SUMMARY:Cardiology follow-up\\, Dr Mehta',
  'DESCRIPTION:Bring the 90-day',
  '  vitals summary', // folded line
  'DTSTART;TZID=Asia/Kolkata:20260709T103000',
  'DTEND;TZID=Asia/Kolkata:20260709T110000',
  'STATUS:CONFIRMED',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:evt-2@example.com',
  'SUMMARY:Weekly standup',
  'DTSTART:20260706T033000Z',
  'DTEND:20260706T034500Z',
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'STATUS:TENTATIVE',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('ICS import: events land with round-trip UIDs, tz, rrule; provenance kind=import', () => {
  const result = gw.importIcs(owner, ICS);
  expect(result).toMatchObject({ imported: 2, skipped: 0 });
  const clinic = db.vault
    .prepare(
      'SELECT summary, description, dtstart, start_tz, status FROM core_event WHERE ical_uid = ?',
    )
    .get('evt-1@example.com');
  expect(clinic).toMatchObject({
    summary: 'Cardiology follow-up, Dr Mehta',
    description: 'Bring the 90-day vitals summary',
    dtstart: '2026-07-09T10:30:00',
    start_tz: 'Asia/Kolkata',
    status: 'confirmed',
  });
  const standup = db.vault
    .prepare('SELECT dtstart, rrule, status FROM core_event WHERE ical_uid = ?')
    .get('evt-2@example.com');
  expect(standup).toMatchObject({
    dtstart: '2026-07-06T03:30:00Z',
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    status: 'tentative',
  });
  const prov = db.journal
    .prepare(
      `SELECT count(*) AS n FROM consent_provenance WHERE prov_activity='import.ics' AND agent_kind='import'`,
    )
    .get() as { n: number };
  expect(prov.n).toBe(2);
});

test('ICS re-import is idempotent: dedupe on ical_uid', () => {
  gw.importIcs(owner, ICS);
  const second = gw.importIcs(owner, ICS);
  expect(second).toMatchObject({ imported: 0, skipped: 2 });
  const events = db.vault.prepare('SELECT count(*) AS n FROM core_event').get() as { n: number };
  expect(events.n).toBe(2);
});

const VCF = [
  'BEGIN:VCARD',
  'VERSION:4.0',
  'FN:Ravi Kumar',
  'N:Kumar;Ravi;;;',
  'BDAY:1988-03-12',
  'EMAIL;TYPE=WORK:Ravi@Example.com',
  'TEL;TYPE=CELL:+91 98765-43210',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:4.0',
  'FN:Meera Iyer',
  'EMAIL:meera@example.com',
  'END:VCARD',
].join('\r\n');

test('vCard import: parties minted with normalized identifiers and sort names', () => {
  const result = gw.importVcards(owner, VCF);
  expect(result).toMatchObject({ imported: 2, skipped: 0 });
  const ravi = db.vault
    .prepare(
      `SELECT party_id, sort_name, birth_date FROM core_party WHERE display_name = 'Ravi Kumar'`,
    )
    .get() as { party_id: string; sort_name: string; birth_date: string };
  expect(ravi).toMatchObject({ sort_name: 'Kumar, Ravi', birth_date: '1988-03-12' });
  const ids = db.vault
    .prepare(
      'SELECT scheme, value, is_primary FROM core_party_identifier WHERE party_id = ? ORDER BY scheme',
    )
    .all(ravi.party_id);
  expect(ids).toEqual([
    { scheme: 'email', value: 'ravi@example.com', is_primary: 1 },
    { scheme: 'tel', value: '+919876543210', is_primary: 1 },
  ]);
});

test('vCard re-import resolves handles to the existing party — never a duplicate person', () => {
  gw.importVcards(owner, VCF);
  // Same person exported by a different app: same email, new phone.
  const again = [
    'BEGIN:VCARD',
    'FN:R. Kumar (work)',
    'EMAIL:ravi@example.com',
    'TEL:+91 11111 22222',
    'END:VCARD',
  ].join('\r\n');
  const result = gw.importVcards(owner, again);
  expect(result).toMatchObject({ imported: 0, skipped: 1 });
  const people = db.vault
    .prepare(`SELECT count(*) AS n FROM core_party WHERE kind='person'`)
    .get() as { n: number };
  expect(people.n).toBe(3); // owner + Ravi + Meera, no fourth
  // The new phone backfilled onto the existing party, non-primary.
  const ravi = db.vault
    .prepare(`SELECT party_id FROM core_party WHERE display_name = 'Ravi Kumar'`)
    .get() as { party_id: string };
  const tels = db.vault
    .prepare(
      `SELECT value, is_primary FROM core_party_identifier WHERE party_id = ? AND scheme='tel' ORDER BY value`,
    )
    .all(ravi.party_id);
  expect(tels).toEqual([
    { value: '+911111122222', is_primary: 0 },
    { value: '+919876543210', is_primary: 1 },
  ]);
});

test('imports are owner-only in v0', () => {
  expect(() => gw.importIcs({ kind: 'device', deviceId: 'x', deviceKey: 'y' }, ICS)).toThrow(
    /unknown caller/,
  );
});
