import { fmtDay } from "@centraid/blueprints/apps/_shared/format-kit";
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

export interface KindRow {
  logical: string;
  label: string;
  packLabel: string;
  machinery: boolean;
  records: number;
  bytes: number | null;
  writtenToday: number | null;
  lastWriteDay: string | null;
}

function todayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function atlasDayLabel(day: string, now: number = Date.now()): string {
  return fmtDay(day, { absolute: {}, now: new Date(now), undated: day });
}

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

export function kindWritten(kind: KindRow): boolean {
  return kind.records > 0;
}

export const NEVER_WRITTEN = "Never written";

export function kindMeta(
  kind: KindRow,
  now: number = Date.now()
): string | undefined {
  if (!kindWritten(kind)) return undefined;
  if (kind.lastWriteDay === null) return undefined;
  if (kind.lastWriteDay === "") return "Quiet";
  return atlasDayLabel(kind.lastWriteDay, now);
}

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

export function meterShare(kind: KindRow, largest: number): number {
  if (largest <= 0 || kind.records <= 0) return 0;
  return Math.min(100, Math.round((kind.records / largest) * 100));
}

export function largestRecords(kinds: readonly KindRow[]): number {
  return kinds.reduce((most, kind) => Math.max(most, kind.records), 0);
}

export function kindCount(kind: KindRow): string {
  if (!kindWritten(kind)) return NEVER_WRITTEN;
  const parts = [`${kind.records.toLocaleString()} records`];
  if (kind.bytes !== null) parts.push(formatBytes(kind.bytes));
  if (kind.writtenToday !== null && kind.writtenToday > 0)
    parts.push(`${kind.writtenToday.toLocaleString()} written today`);
  return parts.join(" · ");
}

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
    parts.push(`Last write ${atlasDayLabel(lastWrite, now).toLowerCase()}.`);
  if (lastBackupAt !== null)
    parts.push(`Last backup ${relativeWhen(lastBackupAt).toLowerCase()}.`);
  if (parts.length === 0) return "Every kind opened without error.";
  return parts.join(" ");
}

export interface RelationRow {
  id: string;
  title: string;
  sub: string;
  logical: string;
}

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

const WRITTEN_COLUMNS = [
  "updated_at",
  "written_at",
  "created_at",
  "occurred_at",
  "recorded_at",
  "at",
];

export function defaultSortKey(cols: BrowseColumnsResult): string {
  const names = new Set(cols.columns.map((c) => c.name));
  return WRITTEN_COLUMNS.find((c) => names.has(c)) ?? cols.keysetKey;
}

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

export function sortLabel(sort: GridSortData, timeKey: string): string {
  if (sort.key === timeKey)
    return sort.dir === "desc" ? "Newest first" : "Oldest first";
  return sort.dir === "desc" ? `${sort.key} Z–A` : `${sort.key} A–Z`;
}

export function censusStamp(readAt: string | null): string | undefined {
  if (readAt === null) return undefined;
  return `read ${relativeWhen(readAt).toLowerCase()}`;
}

export function tableCaption(
  shown: number,
  total: number,
  order: string
): string {
  return `The first ${shown.toLocaleString()} of ${total.toLocaleString()}, ${order.toLowerCase()} — the table scrolls rather than pages.`;
}
