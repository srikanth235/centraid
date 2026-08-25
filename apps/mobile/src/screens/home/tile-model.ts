// What each springboard tile SAYS, derived from replica rows (#708 A).
//
// Every tile carries an INVARIANT header — icon, name, count — over a body
// whose structure differs per app. The header makes the grid one grid; the body
// makes a tile recognisable at a glance without reading a word of it.
//
// KEEP PURE (no React, no react-native, no replica imports beyond the row
// type): the selection rules are the part that can be wrong, so they are the
// part that is unit-tested. `useSpringboardTiles` owns the reads.
//
// TWO HONESTY RULES run through everything here:
//
//  1. A tile never invents content. With no read path for an app (Locker), the
//     tile renders its designed body with no data and a WITHHELD count, never
//     a zero.
//  2. "Empty" and "not loaded yet" are different answers, which is why
//     `springboardState` refuses first-run on an unsettled or unknown tile.

import type { ReplicaRow } from "@centraid/client/replica/native";

/** Data availability, before any styling decision. */
export type TileStatus =
  /** A read this tile needs has not settled. Body renders static skeletons. */
  | "loading"
  /** No replica/grant/read path — we cannot say whether content exists. */
  | "unknown"
  /** Settled, and the app genuinely holds nothing. */
  | "empty"
  /** Settled, with something to show. */
  | "content";

export interface TilePhoto {
  id: string;
  /** Gateway thumb URL or a pinned on-device path. `undefined` when the asset
   *  EXISTS but its bytes are not addressable yet — still a CELL, painting the
   *  skeleton ground at the geometry the photograph will occupy. Dropping the
   *  row instead renders ten photographs as one blank rectangle under a "10". */
  uri?: string;
  /** The undownscaled bytes, when `uri` points at a DERIVATIVE of them: the
   *  thumb variant is generated after the record lands, so `uri` 404s in
   *  between. Absent for a pinned thumbnail, which is a variant of nothing. */
  originalUri?: string;
}

export interface TileFace {
  /** `party_id`, never the display name: the renderer derives the circle's hue
   *  from this, and a rename must not repaint a person. */
  id: string;
  initials: string;
  /** A stored colour always wins. Blank and whitespace-only are NOT a choice —
   *  the seeded vault leaves `avatar_color` empty, and treating `""` as a
   *  colour paints faces with no fill. Those fall through to the derivation. */
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
  /** Already formatted ("4.1 MB"); empty when the byte size is not recorded. */
  size: string;
}

/** One member per first-party app. */
export type TileBody =
  | { kind: "photos"; photos: TilePhoto[] }
  | { kind: "docs"; rows: TileDocRow[] }
  | { kind: "agenda"; title: string; at: string; after: string }
  | { kind: "people"; faces: TileFace[]; more: number }
  | { kind: "tasks"; rows: TileTaskRow[] }
  // `after` is optional because the brief's third line (:5079) needs a
  // rolling-comparison read `useSpringboardTiles` does not build. The body
  // renders it the moment a caller supplies one and stays silent otherwise.
  | { kind: "tally"; figure: string; caption: string; after?: string }
  | { kind: "locker"; locked: boolean }
  | { kind: "notes"; title: string; excerpt: string };

export interface TileData {
  appId: string;
  status: TileStatus;
  /** `undefined` renders the withheld glyph, never a fabricated 0. */
  count?: number;
  /** True when `count` hit the read's ceiling, so it renders as `N+`. */
  countCapped?: boolean;
  /** What the count counted — "open", "this month", "next 7 days". */
  countLabel: string;
  body: TileBody;
}

const text = (row: ReplicaRow, key: string): string =>
  row[key] == null ? "" : String(row[key]);

/** Newest first by an ISO column; ties fall back to the row's own id column. */
function byDescending(
  column: string,
  idColumn: string
): (left: ReplicaRow, right: ReplicaRow) => number {
  return (left, right) =>
    text(right, column).localeCompare(text(left, column)) ||
    text(left, idColumn).localeCompare(text(right, idColumn));
}

// ──────────────────────────────────────────────────────────────── photos ───

/**
 * Order is RE-ESTABLISHED here, never trusted: a replica read merges N vault
 * scopes.
 *
 * An asset whose bytes are not addressable yet still yields a CELL with no
 * `uri` — returning fewer cells makes the tile reflow when the bytes land, and
 * returning none draws an empty box under a header saying 10.
 */
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
      // The one case with no cell: no photograph behind it to wait for.
      if (!contentId || !assetId) return [];
      const scopeId = text(row, "__centraidScopeId");
      const local = pinned(scopeId, contentId);
      if (local) return [{ id: assetId, uri: local }];
      if (!gatewayBase) return [{ id: assetId }];
      // The same address `timeline-engine` builds, so a tile thumbnail is a
      // cache hit on the grid the tile opens into.
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

/** Cells exist but none can paint bytes yet — the moment the tile must SAY
 *  where the originals are rather than look broken. */
export function mosaicAwaitingBytes(photos: readonly TilePhoto[]): boolean {
  return photos.length > 0 && photos.every((photo) => !photo.uri);
}

/** ONE row across the tile's bled width (:5044); mobile never draws the
 *  desktop's second row. A FIXED count is the no-reflow contract: only the
 *  contents of each cell ever change. */
export const MOSAIC_SLOTS = 4;

/** STATED, never derived from `aspectRatio`: a percentage-width cell can
 *  resolve to zero height, and a zero-height cell inside a min-height container
 *  reads as one deliberate blank rectangle rather than a layout failure. */
export const MOSAIC_CELL_HEIGHT = 88;

/** `R.gap.m` (:5031), shared by the card's padding (`LauncherGrid`) and the
 *  mosaic's negative margins (`TileBody`): the bleed reaches the tile edge only
 *  while it exactly cancels that padding. */
export const TILE_PAD = 12;

/** Exactly `MOSAIC_SLOTS`. An empty slot is still a cell and still paints. */
export function mosaicCells(
  photos: readonly TilePhoto[]
): (TilePhoto | undefined)[] {
  return Array.from({ length: MOSAIC_SLOTS }, (_, index) => photos[index]);
}

// ──────────────────────────────────────────────────────────── prose bodies ───

/** `core.content_item` bodies are always `data:` URIs; anything else (a PDF, an
 *  image) has no prose to excerpt and returns "". */
export function decodeProse(contentUri: unknown): string {
  if (typeof contentUri !== "string" || !contentUri.startsWith("data:"))
    return "";
  const comma = contentUri.indexOf(",");
  if (comma < 0) return "";
  const meta = contentUri.slice(0, comma);
  const payload = contentUri.slice(comma + 1);
  // Base64 needs `atob`, not worth it here: the editors write the
  // percent-encoded form, and a tile that cannot read a body shows its title.
  if (meta.includes(";base64")) return "";
  try {
    return decodeURIComponent(payload);
  } catch {
    return "";
  }
}

/** Headings are SKIPPED, not stripped: the tile shows the title on the line
 *  above, and `# Heading` is almost always that same title again. Quote and
 *  list markers are stripped from what survives — syntax, not words. */
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

// ────────────────────────────────────────────────────────────────── docs ───

const BYTE_UNITS = ["bytes", "KB", "MB", "GB", "TB"] as const;

/** One decimal above the byte rung and none below it — a size is scanned, not
 *  compared, so a second decimal is noise. A missing or nonsensical count
 *  returns "" (a name with no size), never a fabricated 0 bytes. */
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

/** RULED ROWS — name and size — never a prose excerpt: Docs and Notes both hold
 *  text, and drawing both as a title over an opening line makes two tiles
 *  indistinguishable at a glance, the one thing a body exists to prevent. */
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

// ──────────────────────────────────────────────────────────────── agenda ───

export interface AgendaOccurrence {
  instanceKey: string;
  summary: string;
  start: string;
}

/** The after-line is the point of the Agenda body: "then …" answers what a
 *  next-event alone leaves open, and with nothing after it must SAY so — a
 *  blank reads as a missing render. */
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

// ──────────────────────────────────────────────────────────────── people ───

/** Overlapping face circles: a sample of the directory, name-ordered. */
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

/** ONE initial, never two: the 30px disc at 12px/500 is sized for one. An
 *  unnamed person still gets a circle, not a hole. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0]![0] ?? "").toUpperCase();
}

// ───────────────────────────────────────────────────────────────── tasks ───

const OPEN_STATUSES = new Set(["needs-action", "in-process"]);

/** Open tasks only — the number the tile counts, and the rows it draws. */
export function openTasks(rows: readonly ReplicaRow[]): ReplicaRow[] {
  return rows.filter((row) => OPEN_STATUSES.has(text(row, "status")));
}

/** EXACTLY ONE struck row — the most recent completion, appended last — is what
 *  makes this body legible as a task list rather than any list of short
 *  strings. Only present when a completion actually exists. */
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

// ───────────────────────────────────────────────────────────────── tally ───

/** Minor units summed over the rows the read already scoped to this month. */
export function sumMinor(rows: readonly ReplicaRow[]): number {
  return rows.reduce((total, row) => total + Number(row.amount_minor ?? 0), 0);
}

/** First day of the current local month, as the ISO date `spent_on` stores. */
export function monthStartDate(now: Date): string {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    "01",
  ].join("-");
}
