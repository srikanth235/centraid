// The staging spine (issue #290 phase 2): stage → review → publish/discard,
// the external-id map that turns append-on-dedup into true sync, and the
// file-drop customs for MBOX, statement CSV and Takeout zips.

import { deflateRawSync } from 'node:zlib';
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

const ICS = (summary: string) =>
  [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:evt-1@example.com',
    `SUMMARY:${summary}`,
    'DTSTART:20260709T103000Z',
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

test('stage → review → publish: first contact is a draft, publish lands rows + map', () => {
  const staged = gw.stageImportFile(owner, { filename: 'calendar.ics', data: ICS('Dentist') });
  expect(staged.kind).toBe('file.ics');
  expect(staged.staged).toMatchObject({ create: 1, update: 0, skip: 0 });
  // Nothing landed yet — staging is reviewable state.
  const before = db.vault.prepare('SELECT count(*) AS n FROM core_event').get() as { n: number };
  expect(before.n).toBe(0);
  // The batch is owner-readable for review.
  const rows = gw.read(owner, { entity: 'sync.import_row', purpose: 'dpv:ServiceProvision' }).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ disposition: 'create', entity_type: 'core.event' });

  const published = gw.publishImport(owner, staged.batchId);
  expect(published).toMatchObject({ created: 1, updated: 0, skipped: 0 });
  const event = db.vault
    .prepare('SELECT summary FROM core_event WHERE ical_uid = ?')
    .get('evt-1@example.com') as { summary: string };
  expect(event.summary).toBe('Dentist');
  const map = db.vault
    .prepare('SELECT target_type, gone_upstream FROM sync_external_entity WHERE external_id = ?')
    .get('evt-1@example.com') as { target_type: string; gone_upstream: number };
  expect(map).toMatchObject({ target_type: 'core.event', gone_upstream: 0 });
});

test('re-import: unchanged skips, changed stages an update (vault-wins review)', () => {
  const first = gw.stageImportFile(owner, { filename: 'calendar.ics', data: ICS('Dentist') });
  gw.publishImport(owner, first.batchId);

  const unchanged = gw.stageImportFile(owner, { filename: 'calendar.ics', data: ICS('Dentist') });
  expect(unchanged.staged).toMatchObject({ create: 0, update: 0, skip: 1 });

  const changed = gw.stageImportFile(owner, {
    filename: 'calendar.ics',
    data: ICS('Dentist — moved to Friday'),
  });
  expect(changed.staged).toMatchObject({ create: 0, update: 1, skip: 0 });
  const published = gw.publishImport(owner, changed.batchId);
  expect(published).toMatchObject({ created: 0, updated: 1 });
  const event = db.vault
    .prepare('SELECT summary, sequence FROM core_event WHERE ical_uid = ?')
    .get('evt-1@example.com') as { summary: string; sequence: number };
  expect(event.summary).toBe('Dentist — moved to Friday');
  expect(event.sequence).toBe(1);
  // One event total — the map re-targeted, never duplicated.
  const count = db.vault.prepare('SELECT count(*) AS n FROM core_event').get() as { n: number };
  expect(count.n).toBe(1);
});

test('discard: a draft batch publishes nothing and cannot be re-published', () => {
  const staged = gw.stageImportFile(owner, { filename: 'calendar.ics', data: ICS('Dentist') });
  gw.discardImport(owner, staged.batchId);
  const events = db.vault.prepare('SELECT count(*) AS n FROM core_event').get() as { n: number };
  expect(events.n).toBe(0);
  expect(() => gw.publishImport(owner, staged.batchId)).toThrow(/discarded, not draft/);
});

const MBOX = [
  'From meera@example.com Mon Jul  6 10:00:00 2026',
  'From: "Meera Pillai" <meera@example.com>',
  'Date: Mon, 6 Jul 2026 10:00:00 +0530',
  'Subject: Goa dates?',
  'Message-ID: <m1@example.com>',
  '',
  'Are we doing the long weekend or not?',
  '',
  'From meera@example.com Mon Jul  6 11:00:00 2026',
  'From: Meera Pillai <meera@example.com>',
  'Date: Mon, 6 Jul 2026 11:00:00 +0530',
  'Subject: Re: Goa dates?',
  'Message-ID: <m2@example.com>',
  '',
  'Booking the villa tonight either way.',
].join('\n');

test('MBOX: messages thread by normalized subject, senders resolve to one party', () => {
  const staged = gw.stageImportFile(owner, { filename: 'inbox.mbox', data: MBOX });
  expect(staged.staged.create).toBe(2);
  gw.publishImport(owner, staged.batchId);

  const threads = db.vault.prepare('SELECT count(*) AS n FROM social_thread').get() as {
    n: number;
  };
  expect(threads.n).toBe(1); // "Goa dates?" and "Re: Goa dates?" share a key
  const messages = db.vault
    .prepare('SELECT count(*) AS n FROM social_message WHERE sender_party_id IS NOT NULL')
    .get() as { n: number };
  expect(messages.n).toBe(2);
  const meera = db.vault
    .prepare(`SELECT count(*) AS n FROM core_party WHERE display_name = 'Meera Pillai'`)
    .get() as { n: number };
  expect(meera.n).toBe(1); // one sender party across both messages
  // Re-import: everything skips via the map.
  const again = gw.stageImportFile(owner, { filename: 'inbox.mbox', data: MBOX });
  expect(again.staged).toMatchObject({ create: 0, skip: 2 });
});

const CSV = [
  'Date,Description,Amount,Reference',
  '2026-07-01,"Grocers, Indiranagar",-1842.50,TXN001',
  '02/07/2026,Salary,150000.00,TXN002',
  '2026-07-03,Chai,-30,TXN003',
].join('\n');

test('CSV: statement rows land as transactions on a named account', () => {
  const staged = gw.stageImportFile(owner, {
    filename: 'hdfc-june.csv',
    data: CSV,
    accountName: 'HDFC Savings',
    currency: 'INR',
  });
  expect(staged.staged.create).toBe(3);
  const published = gw.publishImport(owner, staged.batchId);
  expect(published.created).toBe(3);
  const account = db.vault
    .prepare(`SELECT account_id, currency FROM core_account WHERE name = 'HDFC Savings'`)
    .get() as { account_id: string; currency: string };
  expect(account.currency).toBe('INR');
  const txns = db.vault
    .prepare(
      'SELECT amount_minor, direction, posted_at FROM core_transaction WHERE account_id = ? ORDER BY posted_at',
    )
    .all(account.account_id) as { amount_minor: number; direction: string; posted_at: string }[];
  expect(txns).toEqual([
    { amount_minor: 184250, direction: 'debit', posted_at: '2026-07-01T00:00:00Z' },
    { amount_minor: 15000000, direction: 'credit', posted_at: '2026-07-02T00:00:00Z' },
    { amount_minor: 3000, direction: 'debit', posted_at: '2026-07-03T00:00:00Z' },
  ]);
  // Idempotent on the Reference column.
  const again = gw.stageImportFile(owner, {
    filename: 'hdfc-june.csv',
    data: CSV,
    accountName: 'HDFC Savings',
    currency: 'INR',
  });
  expect(again.staged).toMatchObject({ create: 0, skip: 3 });
});

/** Build an in-memory zip (deflate) — the Takeout shape. */
function zipOf(entries: { name: string; text: string }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = deflateRawSync(Buffer.from(entry.text, 'utf8'));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.byteLength(entry.text), 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const cdir = Buffer.alloc(46);
    cdir.writeUInt32LE(0x02014b50, 0);
    cdir.writeUInt16LE(8, 10);
    cdir.writeUInt32LE(data.length, 20);
    cdir.writeUInt32LE(Buffer.byteLength(entry.text), 24);
    cdir.writeUInt16LE(nameBuf.length, 28);
    cdir.writeUInt32LE(offset, 42);
    central.push(cdir, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

test('Takeout zip: inner ics + vcf route to one mixed batch; strays reported', () => {
  const VCF = ['BEGIN:VCARD', 'FN:Ravi Kumar', 'EMAIL:ravi@example.com', 'END:VCARD'].join('\r\n');
  const zip = zipOf([
    { name: 'Takeout/Calendar/personal.ics', text: ICS('Standup') },
    { name: 'Takeout/Contacts/All Contacts.vcf', text: VCF },
    { name: 'Takeout/archive_browser.html', text: '<html></html>' },
  ]);
  const staged = gw.stageImportFile(owner, { filename: 'takeout.zip', data: zip });
  expect(staged.kind).toBe('file.takeout');
  expect(staged.staged.create).toBe(2);
  expect(staged.unrouted).toEqual(['Takeout/archive_browser.html']);
  const published = gw.publishImport(owner, staged.batchId);
  expect(published.created).toBe(2);
  const party = db.vault
    .prepare(`SELECT count(*) AS n FROM core_party WHERE display_name = 'Ravi Kumar'`)
    .get() as { n: number };
  expect(party.n).toBe(1);
  const prov = db.journal
    .prepare(`SELECT count(*) AS n FROM consent_provenance WHERE prov_activity = 'import.takeout'`)
    .get() as { n: number };
  expect(prov.n).toBeGreaterThanOrEqual(2);
});

test('imports stay owner-only (v0)', () => {
  expect(() =>
    gw.stageImportFile(
      { kind: 'device', deviceId: 'x', deviceKey: 'y' },
      {
        filename: 'a.ics',
        data: ICS('x'),
      },
    ),
  ).toThrow(/unknown caller/);
});
