// Ingest customs (§10 standing duty) — the border post, rebased onto the
// staging spine (issue #290 phase 2): parse → stage → publish is ONE path
// for every source. These wrappers keep the original one-call contract
// (dedupe on the external key, per-row provenance with prov:Agent class
// 'import', identity resolution via party_identifier, batch receipts) by
// staging and publishing in the same act — the trusted fast lane for
// programmatic callers; owner-facing file drops stay staged for review.

import type { VaultDb } from '../db.js';
import type { Identity } from '../gateway/types.js';
import { PUBLISHERS } from './publishers.js';
import { stageFile } from './stage-file.js';
import { publishBatch } from './staging.js';

export interface ImportResult {
  imported: number;
  skipped: number;
  receiptId: string;
}

function stageAndPublish(
  db: VaultDb,
  importer: Identity,
  filename: string,
  text: string,
): ImportResult {
  const staged = stageFile(db, importer, { filename, data: text });
  const published = publishBatch(db, importer, staged.batchId, PUBLISHERS);
  return {
    imported: published.created,
    skipped: published.updated + published.skipped,
    receiptId: published.receiptId,
  };
}

/** Import RFC 5545 ICS events: dedupe on ical_uid, provenance per row. */
export function importIcsEvents(db: VaultDb, importer: Identity, icsText: string): ImportResult {
  return stageAndPublish(db, importer, 'inline.ics', icsText);
}

/**
 * Import vCards: handles resolve to existing parties (never a duplicate
 * person per channel); unresolved cards mint a party plus identifiers, and
 * known people backfill handles the vault has never seen.
 */
export function importVcardParties(db: VaultDb, importer: Identity, vcfText: string): ImportResult {
  return stageAndPublish(db, importer, 'inline.vcf', vcfText);
}
