import type { VaultDb } from "../db.js";
import type { Identity } from "../gateway/types.js";
import { PUBLISHERS } from "./publishers.js";
import { stageFile } from "./stage-file.js";
import { publishBatch } from "./staging.js";

export interface ImportResult {
  imported: number;
  skipped: number;
  receiptId: string;
}

function stageAndPublish(
  db: VaultDb,
  importer: Identity,
  filename: string,
  text: string
): ImportResult {
  const staged = stageFile(db, importer, { filename, data: text });
  const published = publishBatch(db, importer, staged.batchId, PUBLISHERS);
  return {
    imported: published.created,
    skipped: published.updated + published.skipped,
    receiptId: published.receiptId,
  };
}

export function importIcsEvents(
  db: VaultDb,
  importer: Identity,
  icsText: string
): ImportResult {
  return stageAndPublish(db, importer, "inline.ics", icsText);
}

export function importVcardParties(
  db: VaultDb,
  importer: Identity,
  vcfText: string
): ImportResult {
  return stageAndPublish(db, importer, "inline.vcf", vcfText);
}
