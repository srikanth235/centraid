// The file-length exemption list, read from its ledger.
//
// `max-lines` in oxlint.config.ts caps a source file at 625 lines. The files
// that predate the rule are exempt by name — a row in
// tests/inventory.json#fileSize — rather than by an inline `oxlint-disable`.
// The difference is what it costs to add one: a suppression comment is free
// and invisible to review; a row has to survive the section's down-only
// `_budget` in scripts/check-ledgers.ts, which means a hand edit and an
// `approvedDeviation` note that CHANGED against the merge base.
//
// Lives here rather than inline in oxlint.config.ts because that config is
// itself subject to the ceiling.
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

type FileSizeSection = {
  _budget: number;
  sites: Record<string, number>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileSizeSection(value: unknown): value is FileSizeSection {
  if (
    !isRecord(value) ||
    typeof value._budget !== "number" ||
    !isRecord(value.sites)
  ) {
    return false;
  }
  return Object.values(value.sites).every((site) => typeof site === "number");
}

const inventoryRaw: unknown = JSON.parse(
  readFileSync(path.join(ROOT, "tests/inventory.json"), "utf8")
);
if (!isRecord(inventoryRaw) || !isFileSizeSection(inventoryRaw.fileSize)) {
  throw new Error("tests/inventory.json#fileSize is missing or malformed");
}
const section = inventoryRaw.fileSize;

/** Paths the ceiling does not apply to, in ledger order. */
export const oversizedFiles: string[] = Object.keys(section.sites);

// The budget IS the row count; a disagreement means someone edited one and not
// the other, and the exemption list would then be wider than the ratchet says.
if (section._budget !== oversizedFiles.length) {
  throw new Error(
    `tests/inventory.json#fileSize: _budget is ${section._budget} but ${oversizedFiles.length} sites are listed`
  );
}
