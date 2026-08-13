import { DFILTERS } from "./drive-copy.ts";
import type { FilterAxis } from "./drive-copy.ts";
// The filter row's MEANING (Docs spec §4.2) — which option narrows a row set
// to what, and which options this drive can answer at all.
//
// Pure and DOM-free, for the reason every other pure module in this app is:
// "the filters compose, so each one narrows what the last one left" is a rule
// about a row set, and a rule about a row set expressed inline in a render
// function is a rule nobody can test. `emptyStateView` also has to know
// whether ANY filter is set (§4.6's fourth empty variant is "a filter with no
// matches", which is a different thing to say from an empty shelf), and that
// question has exactly one answer here.
//
// WHAT THIS FILE REFUSES TO ANSWER IS THE POINT. §4.2 names four properties
// and 27 options. This drive reads documents, their media type, their times
// and their byte custody — it does not read owners, shares, the app a document
// arrived from, or the people a document names. An option whose predicate
// cannot be computed is NOT rendered (`liveOptions` below), because a pill
// that silently matches nothing is worse than a pill that is not there: the
// member reads the empty result as a fact about their drive.
import { typeMeta } from "./format.ts";
import type { DriveDoc } from "./types.ts";

/** One selection per axis, or `null` for "this axis is not narrowing". */
export interface DriveFilters {
  type: string | null;
  modified: string | null;
  source: string | null;
}

export const NO_FILTERS: DriveFilters = {
  type: null,
  modified: null,
  source: null,
};

/** Is anything narrowing the set right now? §4.2's "Clear filters" link and
 *  §4.6's filter-empty variant both hang off this one question. */
export function filtersActive(filters: DriveFilters): boolean {
  return Object.values(filters).some((value) => value !== null);
}

// The `Type` axis, by the label the member reads. `cat` is `typeMeta`'s own
// category, so this table can never drift from what the row's kind badge says.
const TYPE_PREDICATE: Readonly<Record<string, (doc: DriveDoc) => boolean>> = {
  PDF: (doc) => typeMeta(doc.media_type).cat === "pdf",
  Image: (doc) => typeMeta(doc.media_type).cat === "image",
  Word: (doc) => typeMeta(doc.media_type).cat === "doc",
  Spreadsheet: (doc) => typeMeta(doc.media_type).cat === "sheet",
  Markdown: (doc) => String(doc.media_type ?? "").startsWith("text/markdown"),
  Text: (doc) => String(doc.media_type ?? "") === "text/plain",
  Audio: (doc) => String(doc.media_type ?? "").startsWith("audio/"),
  Video: (doc) => String(doc.media_type ?? "").startsWith("video/"),
  // `Folder` is deliberately absent: a folder is a LABEL on a document, not a
  // row in this set (§2 row 3), so "type: Folder" would filter a set that
  // never contains one.
};

const DAY = 86_400_000;

/** How far back an option reaches, in days. */
const MODIFIED_WINDOW: Readonly<Record<string, number>> = {
  Today: 1,
  "Last 7 days": 7,
  "Last 30 days": 30,
};

function modifiedWithin(doc: DriveDoc, days: number, now: number): boolean {
  const stamp = Date.parse(doc.updated_at || doc.created_at || "");
  return Number.isNaN(stamp) ? false : now - stamp <= days * DAY;
}

function modifiedThisYear(doc: DriveDoc, now: number): boolean {
  const stamp = Date.parse(doc.updated_at || doc.created_at || "");
  if (Number.isNaN(stamp)) return false;
  return new Date(stamp).getFullYear() === new Date(now).getFullYear();
}

// The `Source` axis reads the ONE provenance fact the drive projection
// actually carries: `custody_state`, the blob layer's answer to "where are the
// bytes". "Scanned here" and "From the share sheet" are facts about how a
// document ARRIVED, which nothing in this projection records.
const SOURCE_PREDICATE: Readonly<Record<string, (doc: DriveDoc) => boolean>> = {
  "On this device": (doc) =>
    doc.custody_state === "local-only" || doc.custody_state === "replicated",
  "Gateway only": (doc) => doc.custody_state === "remote-only",
  "In the backup": (doc) => doc.custody_state === "replicated",
};

/**
 * The options THIS drive can answer for an axis, in the spec's own order. An
 * axis with no answerable option is not rendered at all.
 */
export function liveOptions(axis: FilterAxis): readonly string[] {
  if (!axis.live) return [];
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

/** The axes with at least one answerable option — what `FilterRow` draws. */
export function liveAxes(): readonly FilterAxis[] {
  return DFILTERS.filter((axis) => liveOptions(axis).length > 0);
}

/**
 * Narrow a row set. "The filters compose, so each one narrows what the last
 * one left" (§4.6, verbatim) — which is exactly a chain of `filter` calls and
 * deliberately not a scoring function.
 */
export function applyFilters(
  rows: readonly DriveDoc[],
  filters: DriveFilters,
  now: number = Date.now()
): DriveDoc[] {
  let list = [...rows];
  const byType = filters.type ? TYPE_PREDICATE[filters.type] : undefined;
  if (byType) list = list.filter(byType);
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
