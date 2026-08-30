import { DAY_MS } from "../_shared/format-kit.ts";
import { DFILTERS, sharedWithOption } from "./drive-copy.ts";
import type { FilterAxis } from "./drive-copy.ts";
// The filter row's MEANING (Docs spec §4.2), pure and DOM-free. An option with
// no computable predicate is NOT rendered — a pill that silently matches
// nothing reads as a fact about the drive. `shared_with: null` matches none.
import { typeMeta } from "./format.ts";
import type { DriveDoc } from "./types.ts";

export interface DriveFilters {
  type: string | null;
  people: string | null;
  modified: string | null;
  source: string | null;
}

export const NO_FILTERS: DriveFilters = {
  type: null,
  people: null,
  modified: null,
  source: null,
};

export function filtersActive(filters: DriveFilters): boolean {
  return Object.values(filters).some((value) => value !== null);
}

const TYPE_PREDICATE: Readonly<Record<string, (doc: DriveDoc) => boolean>> = {
  PDF: (doc) => typeMeta(doc.media_type, doc.title).cat === "pdf",
  Image: (doc) => typeMeta(doc.media_type, doc.title).cat === "image",
  Word: (doc) => typeMeta(doc.media_type, doc.title).cat === "doc",
  Spreadsheet: (doc) => typeMeta(doc.media_type, doc.title).cat === "sheet",
  Markdown: (doc) => String(doc.media_type ?? "").startsWith("text/markdown"),
  Text: (doc) => String(doc.media_type ?? "") === "text/plain",
  Audio: (doc) => String(doc.media_type ?? "").startsWith("audio/"),
  Video: (doc) => String(doc.media_type ?? "").startsWith("video/"),
  // `Folder` is absent: a folder is a label, not a row in this set (§2).
};

const MODIFIED_WINDOW: Readonly<Record<string, number>> = {
  Today: 1,
  "Last 7 days": 7,
  "Last 30 days": 30,
};

function modifiedWithin(doc: DriveDoc, days: number, now: number): boolean {
  const stamp = Date.parse(doc.updated_at || doc.created_at || "");
  return Number.isNaN(stamp) ? false : now - stamp <= days * DAY_MS;
}

function modifiedThisYear(doc: DriveDoc, now: number): boolean {
  const stamp = Date.parse(doc.updated_at || doc.created_at || "");
  if (Number.isNaN(stamp)) return false;
  return new Date(stamp).getFullYear() === new Date(now).getFullYear();
}

// `custody_state` is the only provenance fact this projection carries.
const SOURCE_PREDICATE: Readonly<Record<string, (doc: DriveDoc) => boolean>> = {
  "On this device": (doc) =>
    doc.custody_state === "local-only" || doc.custody_state === "replicated",
  "Gateway only": (doc) => doc.custody_state === "remote-only",
  "In the backup": (doc) => doc.custody_state === "replicated",
};

function sharedWithLabels(rows: readonly DriveDoc[]): string[] {
  const labels = new Set<string>();
  for (const doc of rows) {
    for (const share of doc.shared_with ?? []) labels.add(share.label);
  }
  return [...labels].toSorted((a, b) => a.localeCompare(b));
}

/** `rows` is the drive's own set, not the filtered one — else choosing an
 *  audience deletes its own pill. */
export function liveOptions(
  axis: FilterAxis,
  rows: readonly DriveDoc[] = []
): readonly string[] {
  if (!axis.live) return [];
  if (axis.id === "people") {
    return sharedWithLabels(rows).map(sharedWithOption);
  }
  if (axis.id === "type") {
    return axis.options.filter((option) => option in TYPE_PREDICATE);
  }
  if (axis.id === "modified") {
    return axis.options.filter(
      (option) => option in MODIFIED_WINDOW || option === "This year"
    );
  }
  if (axis.id === "source") {
    return axis.options.filter((option) => option in SOURCE_PREDICATE);
  }
  return [];
}

export function liveAxes(
  rows: readonly DriveDoc[] = []
): readonly FilterAxis[] {
  return DFILTERS.filter((axis) => liveOptions(axis, rows).length > 0);
}

/** Filters compose (§4.6): a chain, never a score. */
export function applyFilters(
  rows: readonly DriveDoc[],
  filters: DriveFilters,
  now: number = Date.now()
): DriveDoc[] {
  let list = [...rows];
  const byType = filters.type ? TYPE_PREDICATE[filters.type] : undefined;
  if (byType) list = list.filter(byType);
  if (filters.people) {
    const wanted = filters.people;
    list = list.filter((doc) =>
      (doc.shared_with ?? []).some(
        (share) => sharedWithOption(share.label) === wanted
      )
    );
  }
  if (filters.modified) {
    const days = MODIFIED_WINDOW[filters.modified];
    if (typeof days === "number") {
      list = list.filter((doc) => modifiedWithin(doc, days, now));
    } else if (filters.modified === "This year") {
      list = list.filter((doc) => modifiedThisYear(doc, now));
    }
  }
  const bySource = filters.source
    ? SOURCE_PREDICATE[filters.source]
    : undefined;
  if (bySource) list = list.filter(bySource);
  return list;
}
