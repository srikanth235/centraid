// The Data route's derivations (v9 §6, issue #765) — census, pulse, graph and
// browse payloads turned into the block list's rows, sub lines, count line and
// health sentence. Pure: no React, no network, so every sentence the page says
// about the vault is testable on its own.
//
// The rule the whole file obeys: a clause the data cannot support is OMITTED,
// never guessed. The pulse knows which DAY a kind was last written, not which
// minute, so the meta slot says "Today" and never "4 minutes ago".

import type { GridColumnData, GridSortData } from "@centraid/design/blocks";

import { formatBytes, relativeWhen } from "../../format.js";
import type {
  AtlasCensusPayload,
  AtlasGraphPayload,
  AtlasPulsePayload,
  BrowseColumnsResult,
} from "../../gateway-client.js";
import type { GridRowDef } from "../ui/GridBlock.js";
import {
  cellText,
  isNumericColumn,
  isSealedValue,
  rowIdOf,
} from "./atlasBrowseData.js";

/** One kind, as the Kinds list needs it. */
export interface KindRow {
  logical: string;
  label: string;
  packLabel: string;
  machinery: boolean;
  records: number;
  bytes: number | null;
  /** Writes recorded against this kind today, or `null` when the pulse (an
   *  enhancement-only fetch) never landed. */
  writtenToday: number | null;
  /** The most recent day the journal saw a write, `null` when unknown, and the
   *  empty string when the pulse is known and the window is silent. */
  lastWriteDay: string | null;
}

const DAY_MS = 86_400_000;

/** Today, in the pulse's own `YYYY-MM-DD` UTC vocabulary. */
function todayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** "Today" / "Yesterday" / a locale date — day granularity, because that is
 *  the granularity the journal pulse actually reports. */
export function dayLabel(day: string, now: number = Date.now()): string {
  if (day === todayKey(now)) return "Today";
  if (day === todayKey(now - DAY_MS)) return "Yesterday";
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString();
}

/**
 * Every kind the vault's schema defines, life data before plumbing and fullest
 * first — so the never-written ones land at the foot of their own group.
 *
 * A kind with no rows IS a row (#775). The census sentence counts it either
 * way, and a list that silently dropped it left a member reading "showing 9 of
 * 40" with no way to see the other thirty-one — which is a worse answer than
 * an inert row, because it does not say what is missing. The unwritten ones
 * are drawn `off`: present, reachable, and inert, since there is nothing to
 * browse. {@link kindWritten} is the one predicate that decides which is which.
 */
/** Is this a census the derivations can read — packs listed, totals present?
 *  A 200 body that is not a census (the e2e mock's `{}` absorb, an old
 *  gateway) must not become `stats`; that is a load error, not an empty vault. */
export function isCensusPayload(value: unknown): value is AtlasCensusPayload {
  if (value === null || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    Array.isArray(rec.packs) &&
    rec.totals !== null &&
    typeof rec.totals === "object"
  );
}

export function kindRowsFrom(
  stats: AtlasCensusPayload,
  pulse: AtlasPulsePayload | null,
  now: number = Date.now()
): KindRow[] {
  const today = todayKey(now);
  const byType = new Map((pulse?.series ?? []).map((s) => [s.entityType, s]));
  const rows: KindRow[] = [];
  for (const pack of stats.packs ?? []) {
    for (const table of pack.tables ?? []) {
      const series = byType.get(table.logical);
      const days = series?.days ?? [];
      const lastDay = days.reduce(
        (latest, d) => (d.count > 0 && d.day > latest ? d.day : latest),
        ""
      );
      rows.push({
        bytes: table.bytes,
        label: table.label,
        lastWriteDay: pulse ? lastDay : null,
        logical: table.logical,
        machinery: pack.packKind === "machinery",
        packLabel: pack.packLabel,
        records: table.rows,
        writtenToday: pulse
          ? (days.find((d) => d.day === today)?.count ?? 0)
          : null,
      });
    }
  }
  return rows.sort((a, b) => {
    if (a.machinery !== b.machinery) return a.machinery ? 1 : -1;
    return b.records - a.records;
  });
}

/** Has an app ever put a record of this kind in the vault? */
export function kindWritten(kind: KindRow): boolean {
  return kind.records > 0;
}

/** The words for a kind the schema defines and nothing has ever written. One
 *  string, used by the sub line and by the chip that filters for them. */
export const NEVER_WRITTEN = "Never written";

/**
 * The row's one mono slot: when this kind was last written.
 *
 * A never-written kind takes no slot at all. "Quiet" is a fact about a kind
 * that has records and no recent ones; saying it of a kind that has never held
 * anything would describe a lull that never happened — the sub line already
 * says {@link NEVER_WRITTEN} and that is the whole truth about it.
 */
export function kindMeta(
  kind: KindRow,
  now: number = Date.now()
): string | undefined {
  if (!kindWritten(kind)) return undefined;
  if (kind.lastWriteDay === null) return undefined;
  if (kind.lastWriteDay === "") return "Quiet";
  return dayLabel(kind.lastWriteDay, now);
}

/**
 * The "What it holds" head: "25 of 31 kinds written · 41,208 records".
 *
 * Both halves are the census's own totals rather than the rendered list's:
 * the list is filtered by the chips, and a head that counted what is on screen
 * would tell a member the vault shrank when they pressed "Written today".
 */
export function holdsMeta(stats: AtlasCensusPayload): string {
  const totals = stats.totals;
  if (!totals) return "";
  const parts: string[] = [];
  if (
    typeof totals.populatedKinds === "number" &&
    typeof totals.kinds === "number"
  ) {
    parts.push(
      `${totals.populatedKinds.toLocaleString()} of ${totals.kinds.toLocaleString()} kinds written`
    );
  }
  if (typeof totals.rows === "number") {
    parts.push(`${totals.rows.toLocaleString()} records`);
  }
  return parts.join(" · ");
}

/**
 * The meter bar's length: this kind's share of the LARGEST kind, 0–100.
 *
 * Share of the largest, never of the total. A vault's records are so unevenly
 * distributed that shares of the total round nine kinds out of ten to a bar
 * one pixel wide — a chart that says "everything is nothing" and answers no
 * question. Against the largest, the list reads as an ordering.
 */
export function meterShare(kind: KindRow, largest: number): number {
  if (largest <= 0 || kind.records <= 0) return 0;
  return Math.min(100, Math.round((kind.records / largest) * 100));
}

/** The biggest record count in a list of kinds — the meter's 100%. */
export function largestRecords(kinds: readonly KindRow[]): number {
  return kinds.reduce((most, kind) => Math.max(most, kind.records), 0);
}

/**
 * The meter row's numeric cell: `1,908 records · 1.2 GB · 12 written today`,
 * each clause only when the census/pulse carries it — or {@link
 * NEVER_WRITTEN} for a kind nothing has ever written. "0 records" reads as a
 * count that has moved rather than one that never has, and the never-written
 * words are the SAME string the chip that isolates those rows uses.
 */
export function kindCount(kind: KindRow): string {
  if (!kindWritten(kind)) return NEVER_WRITTEN;
  const parts = [`${kind.records.toLocaleString()} records`];
  if (kind.bytes !== null) parts.push(formatBytes(kind.bytes));
  // The clause the "Written today" chip filters on. Without it the chip sorts
  // rows by a fact none of them state, which is a filter a member cannot check.
  if (kind.writtenToday !== null && kind.writtenToday > 0)
    parts.push(`${kind.writtenToday.toLocaleString()} written today`);
  return parts.join(" · ");
}

/** The app bar's count line: "9 kinds · 12,408 records · 2.1 GB". */
export function countLine(stats: AtlasCensusPayload): string {
  const totals = stats.totals;
  if (!totals) return "";
  if (totals.populatedKinds === 0) return "No kinds yet";
  const parts: string[] = [];
  if (typeof totals.populatedKinds === "number") {
    parts.push(`${totals.populatedKinds.toLocaleString()} kinds`);
  }
  if (typeof totals.rows === "number") {
    parts.push(`${totals.rows.toLocaleString()} records`);
  }
  const sizeBytes = totals.bytes ?? stats.fileBytesTotal;
  if (typeof sizeBytes === "number") parts.push(formatBytes(sizeBytes));
  return parts.join(" · ");
}

/** The status line's second half. Both clauses are optional and neither is
 *  invented: no pulse means no "last write", no backup status means no "last
 *  backup", and with neither the line says what it does know — that the census
 *  read cleanly. */
export function healthDetail(
  pulse: AtlasPulsePayload | null,
  lastBackupAt: string | null,
  now: number = Date.now()
): string {
  const parts: string[] = [];
  const lastWrite = (pulse?.series ?? [])
    .flatMap((s) => s.days)
    .reduce(
      (latest, d) => (d.count > 0 && d.day > latest ? d.day : latest),
      ""
    );
  if (lastWrite !== "")
    parts.push(`Last write ${dayLabel(lastWrite, now).toLowerCase()}.`);
  if (lastBackupAt !== null)
    parts.push(`Last backup ${relativeWhen(lastBackupAt).toLowerCase()}.`);
  if (parts.length === 0) return "Every kind opened without error.";
  return parts.join(" ");
}

/** One "how they relate" row. */
export interface RelationRow {
  id: string;
  title: string;
  sub: string;
  /** The kind the row's Browse action opens — the relation's own end. */
  logical: string;
}

/** Relations, authored links first. `core_link` rows are what a person made;
 *  the FK graph is what the schema enforces. They are never conflated, so the
 *  authored set wins outright and the schema set is the fallback for a vault
 *  that has not authored any. */
export function relationRowsFrom(graph: AtlasGraphPayload | null): {
  rows: RelationRow[];
  authored: boolean;
} {
  if (!graph) return { authored: true, rows: [] };
  const nodes = graph.nodes ?? [];
  const nameOf = new Map<string, string>();
  for (const node of nodes) {
    const name = node.friendly ?? node.label;
    nameOf.set(node.logical, name);
    nameOf.set(node.physical, name);
  }
  const logicalOf = new Map<string, string>();
  for (const node of nodes) {
    logicalOf.set(node.logical, node.logical);
    logicalOf.set(node.physical, node.logical);
  }

  const pairs = new Map<
    string,
    { from: string; to: string; labels: Set<string>; count: number }
  >();
  for (const link of graph.authoredLinks ?? []) {
    const key = `${link.fromType}→${link.toType}`;
    const entry = pairs.get(key) ?? {
      count: 0,
      from: link.fromType,
      labels: new Set<string>(),
      to: link.toType,
    };
    entry.count += link.count;
    if (link.relationLabel) entry.labels.add(link.relationLabel);
    pairs.set(key, entry);
  }
  if (pairs.size > 0) {
    const rows = [...pairs.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([id, p]) => {
        const quoted = [...p.labels].map((l) => `“${l}”`).join(", ");
        const links = `${p.count.toLocaleString()} links`;
        return {
          id,
          logical: logicalOf.get(p.from) ?? p.from,
          sub: quoted === "" ? links : `${quoted} · ${links}`,
          title: `${nameOf.get(p.from) ?? p.from} → ${nameOf.get(p.to) ?? p.to}`,
        };
      });
    return { authored: true, rows };
  }

  const rows = (graph.fkEdges ?? [])
    .filter((e) => !e.ghost && !e.selfRef && e.fill > 0)
    .sort((a, b) => b.fill - a.fill)
    .slice(0, 8)
    .map((e) => ({
      id: `${e.fromTable}.${e.col}→${e.toTable}`,
      logical: e.fromLogical,
      sub: `linked by ${e.col} · ${e.fill.toLocaleString()} records`,
      title: `${nameOf.get(e.fromTable) ?? e.fromTable} → ${nameOf.get(e.toTable) ?? e.toTable}`,
    }));
  return { authored: false, rows };
}

/**
 * Which columns a record's own timestamp might live in, most recent-meaning
 * first. Used only to pick the DEFAULT order of a kind's records: the grid
 * shows what the store holds and never reformats a value.
 */
const WRITTEN_COLUMNS = [
  "updated_at",
  "written_at",
  "created_at",
  "occurred_at",
  "recorded_at",
  "at",
];

/**
 * The column a kind is ordered by until a member says otherwise.
 *
 * The store's keyset key is the fallback and it is the honest one — it is what
 * "newest first" means to a table with no time in it. A kind that DOES record
 * a time is ordered by that instead, because "newest" about a record means
 * when it was written and not when it happened to be inserted.
 */
export function defaultSortKey(cols: BrowseColumnsResult): string {
  const names = new Set(cols.columns.map((c) => c.name));
  return WRITTEN_COLUMNS.find((c) => names.has(c)) ?? cols.keysetKey;
}

/**
 * The record grid's columns: every column the store declares, in the store's
 * own order, carrying the declarations a member cannot see in a value — which
 * are the primary key, which is a reference and to what, and which the store
 * will not print.
 *
 * The register is chosen from the column's SQLite affinity plus its role: keys,
 * references and numerics are identifiers and figures, so they take the numeric
 * register; everything else is prose until proven otherwise.
 */
export function gridColumnsFrom(
  cols: BrowseColumnsResult
): readonly GridColumnData[] {
  return cols.columns.map((column) => {
    const mono =
      column.pk > 0 || column.fkTable !== null || isNumericColumn(column);
    return {
      key: column.name,
      label: column.name,
      ...(column.pk > 0 ? { pk: true as const } : {}),
      ...(column.fkTable ? { fk: column.fkLogical ?? column.fkTable } : {}),
      ...(column.sealed ? { sealed: true as const } : {}),
      ...(mono ? { register: "mono" as const } : {}),
    };
  });
}

/**
 * Browse rows → grid rows. The values pass through UNTOUCHED — the grid is the
 * store's own reading of a kind, so a timestamp stays the integer the store
 * holds — and the only derivation is the row's identity and the name its
 * controls are announced by.
 *
 * A record whose display field is sealed is named "Sealed" rather than by its
 * id: the id is the wrong thing to read out, and the masking sentinel must
 * never reach a screen as text.
 */
export function gridRowsFrom(
  cols: BrowseColumnsResult,
  rows: readonly Record<string, unknown>[]
): GridRowDef[] {
  return rows.map((row) => {
    const id = rowIdOf(row, cols.columns);
    const display = row[cols.displayField];
    return {
      id,
      name: isSealedValue(display)
        ? "Sealed"
        : cellText(display) || id || cols.displayField,
      values: row,
    };
  });
}

/**
 * The section head's trailing verb for a records grid — a toggle whose label
 * is its own readout (#775).
 *
 * Records were ordered newest-first and nothing could change it. Now the order
 * is a member's, so the head has to SAY where it stands, and the words differ
 * by what is being ordered: a time reads as newest/oldest, and anything else
 * reads as the alphabet, because "newest first" over a display name is not a
 * sentence about anything.
 */
export function sortLabel(sort: GridSortData, timeKey: string): string {
  if (sort.key === timeKey)
    return sort.dir === "desc" ? "Newest first" : "Oldest first";
  return sort.dir === "desc" ? `${sort.key} Z–A` : `${sort.key} A–Z`;
}

/**
 * The census freshness stamp — when the page last asked the gateway what the
 * vault holds.
 *
 * A census is a snapshot, and a snapshot with no timestamp reads as live. The
 * stamp is omitted rather than guessed while nothing has been read yet, which
 * is the same rule the health sentence obeys.
 */
export function censusStamp(readAt: string | null): string | undefined {
  if (readAt === null) return undefined;
  return `read ${relativeWhen(readAt).toLowerCase()}`;
}

/**
 * The line under the grid (v9 §9) — the numbers are live, and so is the order.
 *
 * "Newest first" used to be a constant in this sentence because the read was.
 * A caption that kept saying it while a member had sorted by name would be the
 * page telling them something they can see is false.
 */
export function tableCaption(
  shown: number,
  total: number,
  order: string
): string {
  return `The first ${shown.toLocaleString()} of ${total.toLocaleString()}, ${order.toLowerCase()} — the table scrolls rather than pages.`;
}
