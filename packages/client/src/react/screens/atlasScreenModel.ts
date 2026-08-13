// The Data route's derivations (v9 §6, issue #765) — census, pulse, graph and
// browse payloads turned into the block list's rows, sub lines, count line and
// health sentence. Pure: no React, no network, so every sentence the page says
// about the vault is testable on its own.
//
// The rule the whole file obeys: a clause the data cannot support is OMITTED,
// never guessed. The pulse knows which DAY a kind was last written, not which
// minute, so the meta slot says "Today" and never "4 minutes ago".

import type { IconName } from "@centraid/design";

import { formatBytes, relativeWhen } from "../../format.js";
import type {
  AtlasCensusPayload,
  AtlasGraphPayload,
  AtlasPulsePayload,
  BrowseColumnsResult,
} from "../../gateway-client.js";
import type { DocTableRow } from "../ui/DocTable.js";
import { cellText, isSealedValue, rowIdOf } from "./atlasBrowseData.js";

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

/** The kinds the vault has actually written, life data before plumbing and
 *  fullest first. A kind with no rows is not a row: the census sentence counts
 *  it, and the list is what you can open. */
export function kindRowsFrom(
  stats: AtlasCensusPayload,
  pulse: AtlasPulsePayload | null,
  now: number = Date.now()
): KindRow[] {
  const today = todayKey(now);
  const byType = new Map((pulse?.series ?? []).map((s) => [s.entityType, s]));
  const rows: KindRow[] = [];
  for (const pack of stats.packs) {
    for (const table of pack.tables) {
      if (table.rows === 0) continue;
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

/** "1,908 records · 1.2 GB · 12 written today" — each clause only when the
 *  census/pulse carries it. */
export function kindSubLine(kind: KindRow): string {
  const parts = [`${kind.records.toLocaleString()} records`];
  if (kind.bytes !== null) parts.push(formatBytes(kind.bytes));
  if (kind.writtenToday !== null && kind.writtenToday > 0)
    parts.push(`${kind.writtenToday.toLocaleString()} written today`);
  return parts.join(" · ");
}

/** The row's one mono slot: when this kind was last written. */
export function kindMeta(
  kind: KindRow,
  now: number = Date.now()
): string | undefined {
  if (kind.lastWriteDay === null) return undefined;
  if (kind.lastWriteDay === "") return "Quiet";
  return dayLabel(kind.lastWriteDay, now);
}

/** The app bar's count line: "9 kinds · 12,408 records · 2.1 GB". */
export function countLine(stats: AtlasCensusPayload): string {
  if (stats.totals.populatedKinds === 0) return "No kinds yet";
  const size = formatBytes(stats.totals.bytes ?? stats.fileBytesTotal);
  return [
    `${stats.totals.populatedKinds.toLocaleString()} kinds`,
    `${stats.totals.rows.toLocaleString()} records`,
    size,
  ].join(" · ");
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
  const nameOf = new Map<string, string>();
  for (const node of graph.nodes) {
    const name = node.friendly ?? node.label;
    nameOf.set(node.logical, name);
    nameOf.set(node.physical, name);
  }
  const logicalOf = new Map<string, string>();
  for (const node of graph.nodes) {
    logicalOf.set(node.logical, node.logical);
    logicalOf.set(node.physical, node.logical);
  }

  const pairs = new Map<
    string,
    { from: string; to: string; labels: Set<string>; count: number }
  >();
  for (const link of graph.authoredLinks) {
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

  const rows = graph.fkEdges
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

const GLYPHS: readonly { match: RegExp; icon: IconName }[] = [
  { icon: "Users", match: /party|person|people|contact|face/u },
  { icon: "Image", match: /photo|image|media|video/u },
  { icon: "Calendar", match: /event|calendar|occurrence/u },
  { icon: "EnvelopeSimple", match: /message|thread|mail|email/u },
  { icon: "Receipt", match: /receipt|invoice|payment|money|account/u },
  { icon: "Compass", match: /place|location|geo/u },
  { icon: "Todo", match: /task|todo|habit/u },
  { icon: "Folder", match: /doc|file|note|blob|attachment/u },
];

/** The row's leading 16px glyph. A vault kind is not an app, so this maps the
 *  ontology's own vocabulary rather than reusing the launcher's icons. */
export function kindGlyph(logical: string): IconName {
  const name = logical.toLowerCase();
  for (const g of GLYPHS) if (g.match.test(name)) return g.icon;
  return "Database";
}

/** Columns a record's own sub-kind might live in, most specific first. */
const KIND_COLUMNS = ["kind", "type", "subtype", "mime_type", "content_type"];
/** Columns a record's write time might live in, most recent-meaning first. */
const WRITTEN_COLUMNS = [
  "updated_at",
  "written_at",
  "created_at",
  "occurred_at",
  "recorded_at",
  "at",
];

/** Format a cell that is meant to be a moment. Anything this cannot read as a
 *  time is left as it was written rather than being coerced into a date. */
export function writtenText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    const ms = value > 1e12 ? value : value * 1000;
    return relativeWhen(new Date(ms).toISOString());
  }
  const text = cellText(value);
  if (/^\d{4}-\d{2}-\d{2}/u.test(text)) return relativeWhen(text);
  return text;
}

/** Browse rows → table rows. The Record column is the table's own display
 *  field, the Kind column is the record's sub-kind when it has one and the
 *  kind's name when it does not, and Written is empty when the kind records no
 *  time at all — an empty cell is honest; a fabricated date is not. */
export function docRowsFrom(
  cols: BrowseColumnsResult,
  rows: readonly Record<string, unknown>[],
  kindLabel: string
): DocTableRow[] {
  const names = new Set(cols.columns.map((c) => c.name));
  const kindCol = KIND_COLUMNS.find((c) => names.has(c) && c !== "kind_label");
  const writtenCol = WRITTEN_COLUMNS.find((c) => names.has(c));
  const icon = kindGlyph(cols.logical);
  return rows.map((row) => {
    const id = rowIdOf(row, cols.columns);
    const display = row[cols.displayField];
    const title = isSealedValue(display)
      ? "Sealed"
      : cellText(display) || id || cols.displayField;
    const sub = kindCol ? cellText(row[kindCol]) : "";
    return {
      icon,
      id,
      kind: sub === "" ? kindLabel : sub,
      title,
      written: writtenCol ? writtenText(row[writtenCol]) : "",
    };
  });
}

/** The line under the table. Verbatim shape (v9 §9) — the numbers are live. */
export function tableCaption(shown: number, total: number): string {
  return `The first ${shown.toLocaleString()} of ${total.toLocaleString()}, newest first. The table scrolls rather than pages, the way the drive does.`;
}
