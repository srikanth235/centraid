// What the Data place SAYS, derived from what the gateway actually sent
// (#765, spec §6).
//
// Pure on purpose: every sentence on that screen is a fact about the vault,
// so the mapping from census/graph/browse payloads to rows, subs, captions
// and counts is the part worth testing, and it is tested here without a
// renderer (the convention `screens/home/tile-model.ts` already follows).
//
// The rule this file exists to hold: a clause appears only when the payload
// carries it. `lib/atlas.ts` types the phone's read surface deliberately
// narrower than the wire — there are no write timestamps in the census and no
// per-kind write pulse — so the reference's `12 written today` and its
// `4 min` meta column have NOTHING behind them here and are absent rather
// than approximated. Same for the reference's `Written today` filter chip.

import { formatBytes, formatRelativeTime } from "@centraid/design";

import type { DocRecord } from "../../kit/components/doc-table-model";
import type {
  AtlasCensus,
  AtlasGraph,
  AtlasKind,
  BrowseRowsPage,
  BrowseTable,
} from "../../lib/atlas";

/** One kind in the census, with the display strings its row needs. */
export interface KindRow {
  /** The logical name — what `fetchBrowseRows({ table })` is asked for. */
  logical: string;
  title: string;
  sub: string;
  rows: number;
  bytes: number | null;
  /** The engine's own bookkeeping rather than something an app writes. */
  machinery: boolean;
}

/** One relation between two kinds, already worded. */
export interface RelationRow {
  key: string;
  title: string;
  sub: string;
  /** The kind the Browse verb switches the record table to. */
  browse: string;
}

/** A record, plus the raw row behind it — the table shows the first, the
 *  record view shows the second, and both need the same identity. */
export interface RecordView {
  id: string;
  record: DocRecord;
  row: Record<string, unknown>;
}

/** The kinds list is long enough to need filtering above this many rows. The
 *  reference's own ready state is 5 kinds and its full state is 12. */
export const FULL_AT = 8;

/** How many records the table asks for. The reference shows six. */
export const RECORD_PAGE = 6;

/** The `Largest` chip keeps the top of the list, not a threshold — a vault
 *  where every kind is small still has a largest handful. */
const LARGEST_KEEP = 5;

/**
 * Columns a record's title may come from, best first.
 *
 * Browse rows are raw column maps (the only shape the gateway has), so the
 * title is a GUESS at which column a member would recognise — and when none
 * of these exist the id is shown rather than an invented label.
 */
const TITLE_COLUMNS = [
  "title",
  "name",
  "label",
  "headline",
  "subject",
  "filename",
  "path",
  "display_name",
] as const;

/** Columns that say what sort of thing one record is (the hidden `Kind`). */
const KIND_COLUMNS = ["kind", "type", "mime_type", "mime", "ext"] as const;

/** Columns that say when a record was written (the hidden `Written`), newest
 *  meaning first. Also what `newest first` is ordered by — see `useData`. */
const TIME_COLUMNS = [
  "updated_at",
  "modified_at",
  "written_at",
  "created_at",
  "occurred_at",
  "ts",
] as const;

/** Grouped digits, the one numeric register these pages read in. */
export function count(n: number): string {
  return n.toLocaleString();
}

/** `1 record` / `1,908 records` — the count and its noun, agreeing. */
export function recordCount(n: number): string {
  return `${count(n)} ${n === 1 ? "record" : "records"}`;
}

/**
 * A kind's sub line: `1,908 records · 1.2 GB`.
 *
 * The size clause is dropped when the census was taken by the `estimate`
 * method, which reports `bytes: null` — a kind whose size is unknown says
 * nothing about its size.
 */
export function kindSub(kind: Pick<AtlasKind, "rows" | "bytes">): string {
  return kind.bytes === null
    ? recordCount(kind.rows)
    : `${recordCount(kind.rows)} · ${formatBytes(kind.bytes)}`;
}

/**
 * The census, flattened into rows.
 *
 * Only POPULATED kinds appear: a table with no rows is a shape the schema
 * allows, not something an app has written, and the empty state's own sentence
 * ("Kinds appear here as apps write records") is the promise that it will show
 * up when it does. The engine's own bookkeeping sorts after everything a
 * member's apps wrote, and within each half the biggest kind leads.
 */
export function censusKinds(census: AtlasCensus): KindRow[] {
  const out: KindRow[] = [];
  for (const pack of census.packs) {
    for (const table of pack.tables) {
      if (table.rows <= 0) continue;
      out.push({
        bytes: table.bytes,
        logical: table.logical,
        machinery: pack.packKind === "machinery",
        rows: table.rows,
        sub: kindSub(table),
        title: table.label || table.logical,
      });
    }
  }
  return out.sort((a, b) => {
    if (a.machinery !== b.machinery) return a.machinery ? 1 : -1;
    return b.rows - a.rows;
  });
}

/** The filter chips, published only when the list is long (spec §10's `full`
 *  branch). `Written today` is not among them: see the file header. */
export type KindFilter = "all" | "largest" | "machinery";

export const KIND_FILTERS: readonly { id: KindFilter; label: string }[] = [
  { id: "all", label: "All kinds" },
  { id: "largest", label: "Largest" },
  // The census divides packs into what apps write and what the engine keeps
  // for itself; this is that second half, named as the census names it.
  { id: "machinery", label: "The engine's own" },
];

/** Largest by size where the census measured sizes, by record count where it
 *  only estimated — the one honest reading of "largest" per method. */
export function filterKinds(rows: KindRow[], filter: KindFilter): KindRow[] {
  if (filter === "machinery") return rows.filter((row) => row.machinery);
  if (filter === "largest") {
    return [...rows]
      .sort((a, b) =>
        a.bytes !== null && b.bytes !== null
          ? b.bytes - a.bytes
          : b.rows - a.rows
      )
      .slice(0, LARGEST_KEEP);
  }
  return rows;
}

function friendlyName(graph: AtlasGraph, logical: string): string {
  const node = graph.nodes.find((entry) => entry.logical === logical);
  return node?.friendly ?? node?.label ?? logical;
}

/**
 * How the kinds relate.
 *
 * The graph carries two different mechanisms and they are not interchangeable:
 * an AUTHORED link is something a member or an app said ("this photograph is
 * of that person"), a FOREIGN KEY is the schema's own rule. Authored links are
 * the ones worth reading, so they lead; the FK edges are the fallback for a
 * vault that has not linked anything yet, which is most new vaults — without
 * them this section would be empty on a store that plainly does relate.
 */
export function relationRows(graph: AtlasGraph): RelationRow[] {
  if (graph.authoredLinks.length > 0) {
    return [...graph.authoredLinks]
      .sort((a, b) => b.count - a.count)
      .map((link) => ({
        browse: link.fromType,
        key: `${link.relationConceptId}:${link.fromType}:${link.toType}`,
        sub: [
          link.relationLabel ?? "",
          `${count(link.count)} ${link.count === 1 ? "link" : "links"}`,
        ]
          .filter(Boolean)
          .join(" · "),
        title: `${friendlyName(graph, link.fromType)} → ${friendlyName(graph, link.toType)}`,
      }));
  }
  return [...graph.fkEdges]
    .sort((a, b) => b.childRows - a.childRows)
    .map((edge) => ({
      browse: edge.fromLogical,
      key: `${edge.fromTable}:${edge.col}:${edge.toTable}`,
      // `fill` is the share of child rows that actually carry the reference —
      // a schema rule that half the records opt out of is a different fact
      // from one they all obey, and the row says which.
      sub: `${edge.col} · ${Math.round(edge.fill * 100)}% of ${recordCount(edge.childRows)}`,
      title: `${friendlyName(graph, edge.fromLogical)} → ${
        edge.toLogical === null
          ? edge.toTable
          : friendlyName(graph, edge.toLogical)
      }`,
    }));
}

function text(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return "";
}

function firstOf(
  row: Record<string, unknown>,
  columns: readonly string[]
): string {
  for (const column of columns) {
    const value = text(row, column);
    if (value) return value;
  }
  return "";
}

/** The write time as the store keeps it — an ISO string or an epoch NUMBER.
 *  Stringifying a number first would hand `Date.parse` something it cannot
 *  read, and the row would claim it had no time at all. */
function timeOf(row: Record<string, unknown>): string | number | undefined {
  for (const column of TIME_COLUMNS) {
    const value = row[column];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** The column a page can be ordered by to read newest first, if it has one. */
export function timeColumn(columns: readonly string[]): string | undefined {
  return TIME_COLUMNS.find((column) => columns.includes(column));
}

/** The record's id: the store's own `id`, else the rowid the browse route
 *  selects alongside it for rowid tables. */
function recordId(row: Record<string, unknown>, index: number): string {
  const id = text(row, "id") || text(row, "__rowid");
  return id || `row-${String(index)}`;
}

/**
 * One page of raw rows, read as records.
 *
 * `kind` and `written` are the two columns the wide table would show and this
 * surface folds into one annotation line; either may be missing, and
 * `snipLine` already renders what is there without a stray separator.
 */
export function browseRecords(page: BrowseRowsPage): RecordView[] {
  return page.rows.map((row, index) => {
    const id = recordId(row, index);
    const when = timeOf(row);
    return {
      id,
      record: {
        key: id,
        kind: firstOf(row, KIND_COLUMNS),
        title: firstOf(row, TITLE_COLUMNS) || id,
        written: when === undefined ? "" : formatRelativeTime(when),
      },
      row,
    };
  });
}

/**
 * The sentence under the table.
 *
 * `newest first` is a claim about the ORDER, so it is made only when the page
 * was actually ordered by a write time descending. A store whose records carry
 * no timestamp comes back in the key order the gateway paginates by, and the
 * caption says that instead of borrowing the reference's words.
 */
export function tableCaption(
  shown: number,
  total: number,
  newestFirst: boolean
): string {
  const order = newestFirst
    ? ", newest first"
    : ", in the order the store keeps them";
  return `The first ${count(shown)} of ${count(total)}${order}. The table scrolls rather than pages, the way the drive does.`;
}

/** The kind whose records are shown: the one asked for by name, else the
 *  biggest thing the member's own apps wrote. */
export function pickBrowseTable(
  tables: readonly BrowseTable[],
  wanted?: string
): BrowseTable | undefined {
  if (wanted) {
    const named = tables.find(
      (table) => table.logical === wanted || table.physical === wanted
    );
    if (named) return named;
  }
  const populated = tables.filter((table) => table.rows > 0);
  const owned = populated.filter((table) => !table.machinery);
  const pool = owned.length > 0 ? owned : populated;
  return [...pool].sort((a, b) => b.rows - a.rows)[0];
}

/** `9 kinds · 12,408 records · 2.1 GB` — the standing detail, from the census
 *  totals and nothing else. */
export function censusDetail(census: AtlasCensus): string {
  const clauses = [
    `${count(census.totals.populatedKinds)} ${census.totals.populatedKinds === 1 ? "kind" : "kinds"}`,
    recordCount(census.totals.rows),
  ];
  if (census.totals.bytes !== null)
    clauses.push(formatBytes(census.totals.bytes));
  return clauses.join(" · ");
}
