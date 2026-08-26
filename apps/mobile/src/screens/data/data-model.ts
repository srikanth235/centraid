// What the Data place SAYS, from what the gateway actually sent (#765, §6). A
// clause appears only when the payload carries it: the phone's read surface has
// no write timestamps, so `12 written today` is absent, never approximated.

import { formatBytes, formatRelativeTime } from "@centraid/design";

import type { DocRecord } from "../../kit/components/doc-table-model";
import type {
  AtlasCensus,
  AtlasGraph,
  AtlasKind,
  BrowseRowsPage,
  BrowseTable,
} from "../../lib/atlas";

export interface KindRow {
  logical: string;
  title: string;
  sub: string;
  rows: number;
  bytes: number | null;
  /** Engine bookkeeping, not an app's write. */
  machinery: boolean;
}

export interface RelationRow {
  key: string;
  title: string;
  sub: string;
  browse: string;
}

export interface RecordView {
  id: string;
  record: DocRecord;
  row: Record<string, unknown>;
}

export const FULL_AT = 8;

export const RECORD_PAGE = 6;

/** `Largest` keeps a top slice, never a threshold. */
const LARGEST_KEEP = 5;

/** Best first; with no match the id is shown, never an invented label. */
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

const KIND_COLUMNS = ["kind", "type", "mime_type", "mime", "ext"] as const;

const TIME_COLUMNS = [
  "updated_at",
  "modified_at",
  "written_at",
  "created_at",
  "occurred_at",
  "ts",
] as const;

export function count(n: number): string {
  return n.toLocaleString();
}

export function recordCount(n: number): string {
  return `${count(n)} ${n === 1 ? "record" : "records"}`;
}

/** `bytes: null` (the `estimate` method) drops the size clause. */
export function kindSub(kind: Pick<AtlasKind, "rows" | "bytes">): string {
  return kind.bytes === null
    ? recordCount(kind.rows)
    : `${recordCount(kind.rows)} · ${formatBytes(kind.bytes)}`;
}

/** Only POPULATED kinds: an empty table is a schema shape, not a write. */
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

export type KindFilter = "all" | "largest" | "machinery";

export const KIND_FILTERS: readonly { id: KindFilter; label: string }[] = [
  { id: "all", label: "All kinds" },
  { id: "largest", label: "Largest" },
  { id: "machinery", label: "The engine's own" },
];

/** By size where measured, by record count where estimated. */
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

/** Authored links lead; FK edges are the fallback for a vault that has linked
 * nothing yet. */
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
      // `fill`: the share of child rows that actually carry the reference.
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

/** ISO string or epoch NUMBER — stringify first and `Date.parse` fails. */
function timeOf(row: Record<string, unknown>): string | number | undefined {
  for (const column of TIME_COLUMNS) {
    const value = row[column];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export function timeColumn(columns: readonly string[]): string | undefined {
  return TIME_COLUMNS.find((column) => columns.includes(column));
}

function recordId(row: Record<string, unknown>, index: number): string {
  const id = text(row, "id") || text(row, "__rowid");
  return id || `row-${String(index)}`;
}

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

/** `newest first` claims an ORDER: say it only when the page has one. */
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

export function censusDetail(census: AtlasCensus): string {
  const clauses = [
    `${count(census.totals.populatedKinds)} ${census.totals.populatedKinds === 1 ? "kind" : "kinds"}`,
    recordCount(census.totals.rows),
  ];
  if (census.totals.bytes !== null)
    clauses.push(formatBytes(census.totals.bytes));
  return clauses.join(" · ");
}
