// Ingest customs (§10 standing duty) — the border post. OFX, ICS, vCard and
// IMAP all enter the same way: dedupe on the external key, stamp per-row
// provenance (prov:Agent class 'import'), resolve raw handles to identities
// via party_identifier, and leave one receipt per batch.

import type { VaultDb } from '../db.js';
import { nowIso, uuidv7 } from '../ids.js';
import { writeProvenance, writeReceipt } from '../gateway/evidence.js';
import { resolveHandle } from '../gateway/duties.js';
import type { Identity } from '../gateway/types.js';
import { ONTOLOGY_VERSION } from '../schema/migrate.js';
import { parseIcs } from './ics.js';
import { parseVcards } from './vcard.js';

export interface ImportResult {
  imported: number;
  skipped: number;
  receiptId: string;
}

/** Import RFC 5545 ICS events: dedupe on ical_uid, provenance per row. */
export function importIcsEvents(db: VaultDb, importer: Identity, icsText: string): ImportResult {
  const events = parseIcs(icsText);
  const created: string[] = [];
  let skipped = 0;
  db.vault.exec('BEGIN');
  try {
    for (const event of events) {
      const existing = db.vault
        .prepare('SELECT event_id FROM core_event WHERE ical_uid = ?')
        .get(event.uid) as { event_id: string } | undefined;
      if (existing) {
        skipped += 1;
        continue;
      }
      const eventId = uuidv7();
      const now = nowIso();
      db.vault
        .prepare(
          `INSERT INTO core_event
             (event_id, ical_uid, summary, description, dtstart, dtend, start_tz, rrule, status,
              location_place_id, organizer_party_id, sequence, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?)`,
        )
        .run(
          eventId,
          event.uid,
          event.summary,
          event.description,
          event.dtstart,
          event.dtend,
          event.startTz,
          event.rrule,
          event.status,
          now,
          now,
        );
      created.push(eventId);
    }
    db.vault.exec('COMMIT');
  } catch (err) {
    db.vault.exec('ROLLBACK');
    throw err;
  }
  for (const eventId of created) {
    writeProvenance(db.journal, importer, 'core.event', eventId, 'import.ics', undefined, 'import');
  }
  const receiptId = writeReceipt(db.journal, {
    grantId: null,
    invocationId: null,
    action: 'act ingest.import_ics',
    objectType: 'core.event',
    objectId: null,
    purpose: null,
    decision: 'allow',
    detail: { imported: created.length, skipped },
  });
  return { imported: created.length, skipped, receiptId };
}

/**
 * Import vCards: handles resolve to existing parties (never a duplicate
 * person per channel); unresolved cards mint a party plus identifiers.
 */
export function importVcardParties(db: VaultDb, importer: Identity, vcfText: string): ImportResult {
  const cards = parseVcards(vcfText);
  const createdParties: string[] = [];
  const createdIdentifiers: string[] = [];
  let skipped = 0;
  db.vault.exec('BEGIN');
  try {
    for (const card of cards) {
      // Resolution first: any known handle claims the whole card.
      let partyId: string | null = null;
      for (const identifier of card.identifiers) {
        partyId = resolveHandle(db, identifier.scheme, identifier.value);
        if (partyId) break;
      }
      if (partyId) {
        skipped += 1; // the person exists; only backfill missing handles
      } else {
        partyId = uuidv7();
        const now = nowIso();
        db.vault
          .prepare(
            `INSERT INTO core_party (party_id, kind, display_name, sort_name, birth_date, avatar_content_id, created_at, updated_at, ontology_version)
             VALUES (?, 'person', ?, ?, ?, NULL, ?, ?, ?)`,
          )
          .run(partyId, card.fn, card.sortName, card.bday, now, now, ONTOLOGY_VERSION);
        createdParties.push(partyId);
      }
      const primarySeen = new Set<string>(
        (
          db.vault
            .prepare(
              'SELECT scheme FROM core_party_identifier WHERE party_id = ? AND is_primary = 1',
            )
            .all(partyId) as { scheme: string }[]
        ).map((r) => r.scheme),
      );
      for (const identifier of card.identifiers) {
        const exists = db.vault
          .prepare('SELECT 1 AS x FROM core_party_identifier WHERE scheme = ? AND value = ?')
          .get(identifier.scheme, identifier.value);
        if (exists) continue;
        const identifierId = uuidv7();
        const isPrimary = primarySeen.has(identifier.scheme) ? 0 : 1;
        primarySeen.add(identifier.scheme);
        db.vault
          .prepare(
            `INSERT INTO core_party_identifier (identifier_id, party_id, scheme, value, label, is_primary, verified_at, valid_from, valid_to)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
          )
          .run(
            identifierId,
            partyId,
            identifier.scheme,
            identifier.value,
            identifier.label,
            isPrimary,
            nowIso(),
          );
        createdIdentifiers.push(identifierId);
      }
    }
    db.vault.exec('COMMIT');
  } catch (err) {
    db.vault.exec('ROLLBACK');
    throw err;
  }
  for (const id of createdParties) {
    writeProvenance(db.journal, importer, 'core.party', id, 'import.vcard', undefined, 'import');
  }
  for (const id of createdIdentifiers) {
    writeProvenance(
      db.journal,
      importer,
      'core.party_identifier',
      id,
      'import.vcard',
      undefined,
      'import',
    );
  }
  const receiptId = writeReceipt(db.journal, {
    grantId: null,
    invocationId: null,
    action: 'act ingest.import_vcard',
    objectType: 'core.party',
    objectId: null,
    purpose: null,
    decision: 'allow',
    detail: { imported: createdParties.length, identifiers: createdIdentifiers.length, skipped },
  });
  return { imported: createdParties.length, skipped, receiptId };
}
