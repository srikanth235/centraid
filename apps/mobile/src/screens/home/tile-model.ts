// Springboard tile payload from replica rows (#708 A). KEEP PURE; `useSpringboardTiles` owns reads.
// Honesty: never invent content (withheld count, not 0); empty ≠ not-loaded (`springboardState` refuses first-run on unsettled/unknown).

import type { ReplicaRow } from "@centraid/client/replica/native";

export type TileStatus = "loading" | "unknown" | "empty" | "content";

export interface TilePhoto {
  id: string;
  /** Thumb/pinned path. `undefined` when the asset exists but bytes are not addressable yet — still a CELL; dropping the row reflows ten photos as one blank under a "10". */
  uri?: string;
  /** Undownscaled bytes when `uri` is a derivative (thumb lands after the record; `uri` 404s in between). Absent for a pinned thumbnail. */
  originalUri?: string;
}

export interface TileFace {
  /** `party_id`, never display name — hue is derived from this; a rename must not repaint. */
  id: string;
  initials: string;
  /** Stored colour wins. Blank/`""` is not a choice (seeded vault leaves `avatar_color` empty) — fall through to derivation. */
  color?: string;
}

export interface TileTaskRow {
  id: string;
  title: string;
  done: boolean;
}

export interface TileDocRow {
  id: string;
  name: string;
  size: string;
}

export type TileBody =
  | { kind: "photos"; photos: TilePhoto[] }
  | { kind: "docs"; rows: TileDocRow[] }
  | { kind: "agenda"; title: string; at: string; after: string }
  | { kind: "people"; faces: TileFace[]; more: number }
  | { kind: "tasks"; rows: TileTaskRow[] }
  // `after` optional: rolling-comparison read is not built; render when supplied, else silent.
  | { kind: "tally"; figure: string; caption: string; after?: string }
  | { kind: "locker"; locked: boolean }
  | { kind: "notes"; title: string; excerpt: string };

export interface TileData {
  appId: string;
  status: TileStatus;
  /** `undefined` = withheld glyph, never a fabricated 0. */
  count?: number;
  /** True when `count` hit the read ceiling (`N+`). */
  countCapped?: boolean;
  countLabel: string;
  body: TileBody;
}

const text = (row: ReplicaRow, key: string): string =>
  row[key] == null ? "" : String(row[key]);

function byDescending(
  column: string,
  idColumn: string
): (left: ReplicaRow, right: ReplicaRow) => number {
  return (left, right) =>
    text(right, column).localeCompare(text(left, column)) ||
    text(left, idColumn).localeCompare(text(right, idColumn));
}

/** Re-sort here: replica reads merge N scopes. Unaddressable bytes still yield a CELL with no `uri` — fewer cells reflow; none draws an empty box under "10". */
export function selectPhotoMosaic(
  rows: readonly ReplicaRow[],
  gatewayBase: string | undefined,
  pinned: (scopeId: string, contentId: string) => string | undefined,
  count = MOSAIC_SLOTS
): TilePhoto[] {
  return [...rows]
    .sort(byDescending("captured_at", "asset_id"))
    .flatMap((row) => {
      const contentId = text(row, "content_id");
      const assetId = text(row, "asset_id");
      if (!contentId || !assetId) return [];
      const scopeId = text(row, "__centraidScopeId");
      const local = pinned(scopeId, contentId);
      if (local) return [{ id: assetId, uri: local }];
      if (!gatewayBase) return [{ id: assetId }];
      const blob = `${gatewayBase}/centraid/_gateway/blobs/${encodeURIComponent(
        scopeId
      )}/${encodeURIComponent(contentId)}`;
      const variant = text(row, "kind") === "video" ? "poster" : "thumb";
      return [
        { id: assetId, uri: `${blob}?variant=${variant}`, originalUri: blob },
      ];
    })
    .slice(0, count);
}

export function mosaicAwaitingBytes(photos: readonly TilePhoto[]): boolean {
  return photos.length > 0 && photos.every((photo) => !photo.uri);
}

/** One row, fixed count — no-reflow: only cell contents change. Mobile never draws desktop's second row. */
export const MOSAIC_SLOTS = 4;

/** Stated, never from `aspectRatio`: a % width cell can resolve to 0 height and read as a blank rectangle. */
export const MOSAIC_CELL_HEIGHT = 88;

/** `R.gap.m`, shared with `LauncherGrid` padding and `TileBody` negative margins — bleed cancels that padding exactly. */
export const TILE_PAD = 12;

export function mosaicCells(
  photos: readonly TilePhoto[]
): (TilePhoto | undefined)[] {
  return Array.from({ length: MOSAIC_SLOTS }, (_, index) => photos[index]);
}

/** `core.content_item` bodies are `data:` URIs; anything else has no prose — return "". */
export function decodeProse(contentUri: unknown): string {
  if (typeof contentUri !== "string" || !contentUri.startsWith("data:"))
    return "";
  const comma = contentUri.indexOf(",");
  if (comma < 0) return "";
  const meta = contentUri.slice(0, comma);
  const payload = contentUri.slice(comma + 1);
  // Editors write percent-encoded; skip base64 (`atob`) — show the title instead.
  if (meta.includes(";base64")) return "";
  try {
    return decodeURIComponent(payload);
  } catch {
    return "";
  }
}

/** Skip headings (title is already shown); strip quote/list markers from what survives. */
export function firstProseLine(body: string, maxChars = 220): string {
  for (const raw of body.split("\n")) {
    if (raw.trimStart().startsWith("#")) continue;
    const line = raw.replace(/^[>\-*\s]+/u, "").trim();
    if (line) return line.slice(0, maxChars);
  }
  return "";
}

export function selectNoteExcerpt(
  notes: readonly ReplicaRow[],
  contents: readonly ReplicaRow[]
): { title: string; excerpt: string } | undefined {
  const newest = [...notes].sort(byDescending("updated_at", "note_id"))[0];
  if (!newest) return undefined;
  const body = contents.find(
    (row) => row.content_id === newest.body_content_id
  );
  return {
    title: text(newest, "title") || "Untitled",
    excerpt: firstProseLine(decodeProse(body?.content_uri)),
  };
}

const BYTE_UNITS = ["bytes", "KB", "MB", "GB", "TB"] as const;

/** One decimal above the byte rung; missing/nonsensical → "", never fabricated 0 bytes. */
export function formatBytes(bytes: unknown): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "";
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${rounded.toLocaleString()} ${BYTE_UNITS[unit]}`;
}

/** Name + size, never a prose excerpt — Docs and Notes would otherwise look the same. */
export function selectDocRows(
  documents: readonly ReplicaRow[],
  contents: readonly ReplicaRow[],
  limit = 3
): TileDocRow[] {
  const sizes = new Map<string, unknown>();
  for (const row of contents) sizes.set(text(row, "content_id"), row.byte_size);
  return [...documents]
    .sort(byDescending("updated_at", "document_id"))
    .slice(0, limit)
    .map((row) => ({
      id: text(row, "document_id"),
      name: text(row, "title") || "Untitled",
      size: formatBytes(sizes.get(text(row, "current_content_id"))),
    }));
}

export interface AgendaOccurrence {
  instanceKey: string;
  summary: string;
  start: string;
}

/** After-line is required: blank reads as a missing render; with nothing after, say so. */
export function selectNextEvent(
  occurrences: readonly AgendaOccurrence[],
  now: Date,
  formatTime: (iso: string) => string
): { title: string; at: string; after: string } | undefined {
  const nowIso = now.toISOString();
  const upcoming = occurrences
    .filter((occurrence) => occurrence.start >= nowIso)
    .sort((left, right) => left.start.localeCompare(right.start));
  const next = upcoming[0];
  if (!next) return undefined;
  const after = upcoming[1];
  return {
    title: next.summary || "Untitled event",
    at: formatTime(next.start),
    after: after
      ? `then ${after.summary || "Untitled event"}`
      : "nothing after it",
  };
}

export function countUpcoming(
  occurrences: readonly AgendaOccurrence[],
  now: Date,
  days: number
): number {
  const from = now.toISOString();
  const to = new Date(now.getTime() + days * 86_400_000).toISOString();
  return occurrences.filter(
    (occurrence) => occurrence.start >= from && occurrence.start <= to
  ).length;
}

export function selectFaces(
  profiles: readonly ReplicaRow[],
  namesByParty: ReadonlyMap<string, string>,
  count = 5
): TileFace[] {
  return profiles
    .filter((row) => row.deleted_at == null)
    .map((row) => {
      const partyId = text(row, "party_id");
      return {
        id: partyId,
        name: namesByParty.get(partyId) ?? "",
        color: text(row, "avatar_color").trim(),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, count)
    .map((person) => ({
      id: person.id,
      initials: initialsOf(person.name),
      ...(person.color ? { color: person.color } : {}),
    }));
}

/** One initial (30px disc); unnamed still gets a circle, not a hole. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0]![0] ?? "").toUpperCase();
}

const OPEN_STATUSES = new Set(["needs-action", "in-process"]);

export function openTasks(rows: readonly ReplicaRow[]): ReplicaRow[] {
  return rows.filter((row) => OPEN_STATUSES.has(text(row, "status")));
}

/** At most one struck row (most recent completion), appended last — else this is just a list of short strings. */
export function selectTaskRows(
  rows: readonly ReplicaRow[],
  limit = 4
): TileTaskRow[] {
  const open = openTasks(rows)
    .sort(
      (left, right) =>
        Number(left.sort_order ?? 0) - Number(right.sort_order ?? 0) ||
        text(left, "task_id").localeCompare(text(right, "task_id"))
    )
    .map((row) => ({
      id: text(row, "task_id"),
      title: text(row, "title"),
      done: false,
    }));
  const done = rows
    .filter((row) => text(row, "status") === "completed" && row.completed_at)
    .sort(byDescending("completed_at", "task_id"))[0];
  if (!done) return open.slice(0, limit);
  return [
    ...open.slice(0, Math.max(limit - 1, 0)),
    { id: text(done, "task_id"), title: text(done, "title"), done: true },
  ];
}

export function sumMinor(rows: readonly ReplicaRow[]): number {
  return rows.reduce((total, row) => total + Number(row.amount_minor ?? 0), 0);
}

export function monthStartDate(now: Date): string {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    "01",
  ].join("-");
}
