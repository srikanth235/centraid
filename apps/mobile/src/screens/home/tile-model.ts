// What each springboard tile SAYS, derived from replica rows (issue #708 A).
//
// The Binding Layer's Home is made of content, not of icons: every tile carries
// an INVARIANT header — app icon, app name at the UI role, a count in the
// tabular numeric register — over a body whose STRUCTURE is different per app.
// The header is what makes the grid one grid; the body is what makes a tile
// recognisable at a glance without reading a word of it.
//
// This module is pure (no React, no react-native, no replica imports beyond the
// row type) for the same reason ./catalog and ./band are: the selection rules
// are the part that can be wrong, so they are the part that is unit-tested.
// ./useSpringboardTiles owns the reads; this owns what to do with the rows.
//
// Two honesty rules run through everything here:
//
//  1. A tile never invents content. Where mobile has no read path for an app
//     (Locker: its items are sealed columns behind an online, session-gated
//     `locker.items` RPC — see apps/locker/LockerHome.tsx), the tile renders its
//     designed body with no data and its count reads withheld, never zero.
//  2. "Empty" and "not loaded yet" are different answers. First-run means the
//     vault has no content; a query still in flight means we do not know yet.
//     `springboardState` refuses to call first-run on either an unsettled or an
//     unknown tile, because the day-one treatment is a claim about the vault.

import type { ReplicaRow } from "@centraid/client/replica/native";

/** Every tile's data-availability answer, before any styling decision. */
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
  /** Absolute gateway thumb URL, or a pinned on-device thumbnail path. */
  uri: string;
}

export interface TileFace {
  id: string;
  initials: string;
  /** The person's own avatar colour when they have one; else undefined. */
  color?: string;
}

export interface TileTaskRow {
  id: string;
  title: string;
  done: boolean;
}

/** The structurally distinct bodies. One member per first-party app. */
export type TileBody =
  | { kind: "photos"; photos: TilePhoto[] }
  | { kind: "docs"; title: string; excerpt: string }
  | { kind: "agenda"; title: string; at: string; after: string }
  | { kind: "people"; faces: TileFace[]; more: number }
  | { kind: "tasks"; rows: TileTaskRow[] }
  | { kind: "tally"; figure: string; caption: string }
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

// ---------------------------------------------------------------- photos ---

/**
 * The newest assets, as a mosaic that bleeds to the tile edge.
 *
 * Rows arrive already ordered by the read, but a replica read merges N vault
 * scopes, so the order is re-established here rather than trusted.
 */
export function selectPhotoMosaic(
  rows: readonly ReplicaRow[],
  gatewayBase: string | undefined,
  pinned: (scopeId: string, contentId: string) => string | undefined,
  count = 6
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
      if (!gatewayBase) return [];
      // Same address the Photos timeline builds (apps/photos/timeline-engine),
      // so a tile thumbnail is a cache hit on the grid the tile opens into.
      const blob = `${gatewayBase}/centraid/_gateway/blobs/${encodeURIComponent(
        scopeId
      )}/${encodeURIComponent(contentId)}`;
      const variant = text(row, "kind") === "video" ? "poster" : "thumb";
      return [{ id: assetId, uri: `${blob}?variant=${variant}` }];
    })
    .slice(0, count);
}

// ------------------------------------------------------------ prose bodies ---

/**
 * Decode a `core.content_item` body. Notes and short documents store their text
 * as a `data:` URI, which is the same wire shape apps/notes/notes-model decodes;
 * anything else (a PDF, an image) has no prose to excerpt and returns "".
 */
export function decodeProse(contentUri: unknown): string {
  if (typeof contentUri !== "string" || !contentUri.startsWith("data:"))
    return "";
  const comma = contentUri.indexOf(",");
  if (comma < 0) return "";
  const meta = contentUri.slice(0, comma);
  const payload = contentUri.slice(comma + 1);
  // Base64 bodies need `atob`, which is not worth reaching for on a tile: the
  // percent-encoded form is what the note/doc editors write, and a tile that
  // cannot read a body simply shows its title.
  if (meta.includes(";base64")) return "";
  try {
    return decodeURIComponent(payload);
  } catch {
    return "";
  }
}

/**
 * The first line of actual PROSE.
 *
 * Headings are skipped outright rather than stripped: the tile already shows
 * the note's or document's title on the line above, and a markdown `# Heading`
 * is almost always that same title again. Quote and list markers are stripped
 * from what survives — they are syntax, not words.
 */
export function firstProseLine(body: string, maxChars = 220): string {
  for (const raw of body.split("\n")) {
    if (raw.trimStart().startsWith("#")) continue;
    const line = raw.replace(/^[>\-*\s]+/u, "").trim();
    if (line) return line.slice(0, maxChars);
  }
  return "";
}

/** Newest note, in the reading register: its title plus its opening line. */
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

/** Newest document, same treatment — a title over prose, not a file row. */
export function selectDocExcerpt(
  documents: readonly ReplicaRow[],
  contents: readonly ReplicaRow[]
): { title: string; excerpt: string } | undefined {
  const newest = [...documents].sort(
    byDescending("updated_at", "document_id")
  )[0];
  if (!newest) return undefined;
  const body = contents.find(
    (row) => row.content_id === newest.current_content_id
  );
  return {
    title: text(newest, "title") || "Untitled",
    excerpt: firstProseLine(decodeProse(body?.content_uri)),
  };
}

// ---------------------------------------------------------------- agenda ---

export interface AgendaOccurrence {
  instanceKey: string;
  summary: string;
  start: string;
}

/**
 * The next event, plus the after-line the brief pins to the tile bottom.
 *
 * The after-line is the whole point of the Agenda body: "then …" answers the
 * question a next-event alone leaves open, and when there is nothing after it
 * has to SAY so rather than going blank — a blank reads as a missing render.
 */
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

/** How many occurrences land inside the next `days` — the tile's count. */
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

// ---------------------------------------------------------------- people ---

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
        color: text(row, "avatar_color"),
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

/** Up to two letters. An unnamed person still gets a circle, not a hole. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? (parts.at(-1)![0] ?? "") : "";
  return (first + last).toUpperCase();
}

// ----------------------------------------------------------------- tasks ---

const OPEN_STATUSES = new Set(["needs-action", "in-process"]);

/** Open tasks only — the number the tile counts, and the rows it draws. */
export function openTasks(rows: readonly ReplicaRow[]): ReplicaRow[] {
  return rows.filter((row) => OPEN_STATUSES.has(text(row, "status")));
}

/**
 * A few checkbox rows with EXACTLY ONE struck through.
 *
 * The struck row is the most recently completed task, and it is what makes the
 * body legible as a task list rather than as any other list of short strings.
 * It is appended last so the tile always reads open-work-then-a-win, and it is
 * only there when a completion actually exists.
 */
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

// ----------------------------------------------------------------- tally ---

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

// ------------------------------------------------------------ size ------

/**
 * Tile size class: `small` 1×1, `medium` 2×1, `large` 2×2 — 4 columns on
 * desktop, 2 here, where `large` FLATTENS to 2×1 (a 2×2 across half a phone is
 * a tile you scroll past rather than read).
 *
 * The class follows the app's BODY, not its importance: a mosaic needs area,
 * prose needs measure, a figure or a chip needs neither. Kept in step with
 * packages/client/src/react/shell/routes/homeTiles.ts, which carries the same
 * table for the desktop grid.
 */
export type TileSize = "small" | "medium" | "large";

const TILE_SIZE: Record<string, TileSize> = {
  agenda: "small",
  docs: "medium",
  // Notes' body IS the Docs body — a title over prose in the reading register —
  // and the size class follows the body.
  notes: "medium",
  locker: "small",
  people: "small",
  photos: "large",
  tally: "small",
  tasks: "small",
};

/** An app with no first-party tile (a gateway app) takes the 1×1. */
export function tileSize(appId: string): TileSize {
  return TILE_SIZE[appId] ?? "small";
}

/** Whether the tile takes a FULL-WIDTH slot on the two-column mobile grid —
 *  true for both `medium` and the flattened `large`. */
export function isWideTile(appId: string): boolean {
  return tileSize(appId) !== "small";
}

// ------------------------------------------------------------- copy ------

/**
 * What to do when an app holds nothing yet — one imperative line per app.
 *
 * Used twice: as an empty tile's body, and as the caption under each dashed
 * placeholder in the first-run treatment. It is deliberately what-to-DO rather
 * than what-is-missing ("no photos") — an empty grid on day one is a set of
 * invitations, not a set of failures. Locker's line is the odd one out because
 * its content is not missing, it is sealed.
 */
export const TILE_EMPTY_COPY: Record<string, string> = {
  agenda: "Put something on the calendar",
  docs: "Add your first document",
  locker: "Unlock to see your items",
  notes: "Write your first note",
  people: "Add someone you know",
  photos: "Back up your first photo",
  tally: "Log your first expense",
  tasks: "Capture the next thing to do",
};

// ------------------------------------------------------------ first run ---

export type SpringboardState = "loading" | "first-run" | "content";

/**
 * Which treatment the springboard renders.
 *
 * - Any tile with content → the grid. One app having something is enough.
 * - Otherwise any tile still loading → loading. Day one is a claim about the
 *   vault, and an unsettled read has not earned it.
 * - Otherwise any tile unknown (no replica, no grant, a failed read) → the
 *   grid, with those tiles empty. We do not know the vault is empty, so we do
 *   not say so; the grid degrades honestly where the first-run copy would lie.
 * - Otherwise every tile settled and empty → first run.
 *
 * Tiles whose content is structurally unreadable from Home (Locker) report
 * `unknown` and therefore never vote the vault empty on their own — but they
 * also must not veto a genuine first run, so `unknown` only wins when nothing
 * is loading and nothing has content. That is exactly the no-replica case.
 */
export function springboardState(
  tiles: readonly Pick<TileData, "status">[]
): SpringboardState {
  if (tiles.length === 0) return "loading";
  if (tiles.some((tile) => tile.status === "content")) return "content";
  if (tiles.some((tile) => tile.status === "loading")) return "loading";
  const readable = tiles.filter((tile) => tile.status !== "unknown");
  if (readable.length === 0) return "content";
  return "first-run";
}
