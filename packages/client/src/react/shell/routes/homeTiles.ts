// The Home springboard's tile model (issue #708, section A).
//
// The Binding Layer's Home is not an icon launcher. Every tile carries the
// INVARIANT header — app mark, app name at the UI role, count in the numeric
// register — and a body whose STRUCTURE differs per app, because the apps'
// content characters differ. A photo grid wants to disappear behind imagery; a
// document wants reading comfort; an agenda wants a pinned after-line. The
// header is what makes them one house; the body is what makes them rooms.
//
// This module is pure: raw per-app content in, tile models out. The reads live
// in `homeTileContent.ts` and the rendering in `screens/HomeSpringboard.tsx`,
// so the selection rules (what shows, in what order, and when the vault is
// genuinely empty) are testable without a replica or a DOM.
import { apps, formatRelativeTime, identityInitials } from "@centraid/design";
import type { AppMetaResolved } from "@centraid/design";

import { formatCurrencyMinor } from "../../../capture.js";

/**
 * Springboard order. Not alphabetical and not install order: it runs from the
 * apps whose content changes hourly (agenda, tasks) to the ones that are a
 * standing library (locker), so the top of the grid is the part worth a glance.
 */
export const HOME_TILE_ORDER = [
  "agenda",
  "tasks",
  "photos",
  "notes",
  "docs",
  "people",
  "tally",
  "locker",
] as const;

export type HomeTileAppId = (typeof HOME_TILE_ORDER)[number];

/**
 * Tile size class: `small` 1×1, `medium` 2×1, `large` 2×2 on a grid that is 4
 * columns on desktop and 2 on mobile, where `large` flattens to 2×1.
 *
 * A springboard of identical rectangles is a launcher wearing content; the size
 * class is what makes the grid read as a page with a subject. It follows the
 * app's BODY, not its importance: a mosaic needs area to be a mosaic, prose
 * needs measure to be prose, and a figure or a chip needs neither.
 */
export type HomeTileSize = "small" | "medium" | "large";

/**
 * The brief's per-app assignment. Photos is the only `large` (its body is a
 * thumbnail mosaic, which is the one body that gets worse as it shrinks); Docs
 * is `medium` because prose clamped into a 1×1 is a title with a word after it.
 *
 * Notes takes Docs' size for the same reason and by the same rule — the brief
 * names no Notes app, but Notes' body IS the Docs body (title over prose in the
 * reading register), and the size class follows the body.
 */
const TILE_SIZE: Record<HomeTileAppId, HomeTileSize> = {
  agenda: "small",
  docs: "medium",
  locker: "small",
  notes: "medium",
  people: "small",
  photos: "large",
  tally: "small",
  tasks: "small",
};

/** The size class for an app id, defaulting anything unknown to the 1×1. */
export function homeTileSize(id: HomeTileAppId): HomeTileSize {
  return TILE_SIZE[id];
}

/** One overlapping face circle. Identity, never a photo we do not have. */
export interface HomeTileFace {
  name: string;
  initials: string;
}

/** A task row. Exactly one of these may be `done` — see `taskRows`. */
export interface HomeTileTaskRow {
  title: string;
  done: boolean;
}

/**
 * The structurally distinct tile bodies. `empty` is the DESIGNED empty body —
 * a dashed placeholder with what-to-do copy, not a blank tile and not a
 * skeleton (a skeleton means "still loading", which is a different state).
 */
export type HomeTileBody =
  /** Thumbnail mosaic, bleeding to the tile edge. */
  | { kind: "photos"; thumbs: readonly string[]; more: number }
  /** Title plus prose excerpt, both in the reading register. */
  | { kind: "docs"; title: string; excerpt: string }
  /** The next event, with the one after it pinned to the tile bottom. */
  | { kind: "agenda"; title: string; at: string; after: string }
  /** Overlapping face circles. */
  | { kind: "people"; faces: readonly HomeTileFace[]; more: number }
  /** Checkbox rows; the most recently completed one is struck through. */
  | { kind: "tasks"; rows: readonly HomeTileTaskRow[] }
  /** One large figure in the numeric register. */
  | { kind: "tally"; figure: string; caption: string }
  /** A state chip. */
  | { kind: "locker"; chip: string; tone: "ok" | "warn" }
  /** The most recent note's first line, in the reading register. */
  | { kind: "notes"; line: string; at: string }
  | { kind: "empty"; hint: string };

export interface HomeTileModel {
  id: HomeTileAppId;
  name: string;
  iconKey: AppMetaResolved["iconKey"];
  /** The app's identity hue key — `--c-<colorKey>`. The shell spends none. */
  colorKey: AppMetaResolved["colorKey"];
  /** The header count. `null` when the app has no countable content yet. */
  count: number | null;
  /** The unit the count is in, for the tile's accessible name. */
  countLabel: string;
  /** Grid footprint — see `homeTileSize`. */
  size: HomeTileSize;
  body: HomeTileBody;
}

/** Raw per-app content, as the read layer hands it over. Every field optional:
 *  an app with no read path, no grant, or no rows simply has nothing here. */
export interface HomeTileContent {
  photos?: { total: number; thumbs: readonly string[] };
  docs?: { total: number; title?: string; excerpt?: string };
  agenda?: {
    total: number;
    events: readonly { title: string; at: string }[];
  };
  people?: { total: number; names: readonly string[] };
  tasks?: {
    total: number;
    rows: readonly HomeTileTaskRow[];
  };
  tally?: { balanceMinor: number; currency: string };
  locker?: { total: number; compromised: number };
  notes?: { total: number; line?: string; at?: string };
}

/** What-to-do copy for an app that has nothing in it yet. One sentence, an
 *  instruction rather than an apology — the tile is still a door. */
const EMPTY_HINT: Record<HomeTileAppId, string> = {
  agenda: "Add your first event to see what's next here.",
  docs: "File a document to keep it versioned and restorable.",
  locker: "Save a password to keep it behind the lock.",
  notes: "Write a note — the newest one shows up here.",
  people: "Add someone you want to stay in touch with.",
  photos: "Add photos and the newest ones appear here.",
  tally: "Log a shared expense to start a balance.",
  tasks: "Add a task and it lands on this tile.",
};

const COUNT_LABEL: Record<HomeTileAppId, string> = {
  agenda: "events",
  docs: "documents",
  locker: "items",
  notes: "notes",
  people: "people",
  photos: "photos",
  tally: "expenses",
  tasks: "open tasks",
};

/** The four thumbnails a mosaic shows; the rest becomes a "+N". */
const MOSAIC = 4;
/** Faces before the overlap stops reading as a stack. */
const FACES = 4;
/** Task rows that fit above the tile's baseline without clamping to one line. */
const TASK_ROWS = 3;

/** Wall-clock time for an event, in the reader's locale. */
function clockOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The tasks a tile shows: open work first (that is the reason to look), with
 * at most ONE completed row, struck through, so the list reads as a list you
 * are working rather than a list you are only accumulating.
 */
export function taskRows(
  rows: readonly HomeTileTaskRow[],
  limit = TASK_ROWS
): readonly HomeTileTaskRow[] {
  const open = rows.filter((row) => !row.done);
  const done = rows.find((row) => row.done);
  const shown = open.slice(0, done ? Math.max(0, limit - 1) : limit);
  return done ? [...shown, done] : shown;
}

function bodyFor(
  id: HomeTileAppId,
  content: HomeTileContent,
  now: number
): HomeTileBody {
  const empty: HomeTileBody = { hint: EMPTY_HINT[id], kind: "empty" };
  if (id === "photos") {
    const photos = content.photos;
    if (!photos || photos.total === 0) return empty;
    return {
      kind: "photos",
      more: Math.max(0, photos.total - Math.min(MOSAIC, photos.thumbs.length)),
      thumbs: photos.thumbs.slice(0, MOSAIC),
    };
  }
  if (id === "docs") {
    const docs = content.docs;
    if (!docs || docs.total === 0 || !docs.title) return empty;
    return { excerpt: docs.excerpt ?? "", kind: "docs", title: docs.title };
  }
  if (id === "agenda") {
    const agenda = content.agenda;
    const next = agenda?.events[0];
    if (!agenda || !next) return empty;
    const after = agenda.events[1];
    return {
      after: after ? `then ${after.title} · ${clockOf(after.at)}` : "",
      at: clockOf(next.at),
      kind: "agenda",
      title: next.title,
    };
  }
  if (id === "people") {
    const people = content.people;
    if (!people || people.names.length === 0) return empty;
    return {
      faces: people.names.slice(0, FACES).map((name) => ({
        initials: identityInitials(name),
        name,
      })),
      kind: "people",
      more: Math.max(0, people.total - Math.min(FACES, people.names.length)),
    };
  }
  if (id === "tasks") {
    const tasks = content.tasks;
    const rows = taskRows(tasks?.rows ?? []);
    if (!tasks || rows.length === 0) return empty;
    return { kind: "tasks", rows };
  }
  if (id === "tally") {
    const tally = content.tally;
    if (!tally) return empty;
    return {
      caption: tally.balanceMinor === 0 ? "All settled" : "Net position",
      figure: formatCurrencyMinor(tally.balanceMinor, tally.currency),
      kind: "tally",
    };
  }
  if (id === "locker") {
    const locker = content.locker;
    if (!locker || locker.total === 0) return empty;
    return locker.compromised > 0
      ? {
          chip: `${locker.compromised} need attention`,
          kind: "locker",
          tone: "warn",
        }
      : { chip: "All secure", kind: "locker", tone: "ok" };
  }
  const notes = content.notes;
  if (!notes || notes.total === 0 || !notes.line) return empty;
  return {
    at: formatRelativeTime(notes.at, now),
    kind: "notes",
    line: notes.line,
  };
}

function countFor(id: HomeTileAppId, content: HomeTileContent): number | null {
  if (id === "tally") return null; // the figure IS the number; a count beside it says nothing
  const totals: Record<Exclude<HomeTileAppId, "tally">, number | undefined> = {
    agenda: content.agenda?.total,
    docs: content.docs?.total,
    locker: content.locker?.total,
    notes: content.notes?.total,
    people: content.people?.total,
    photos: content.photos?.total,
    tasks: content.tasks?.total,
  };
  return totals[id] ?? null;
}

/**
 * The springboard's tiles: one per INSTALLED first-party app, in springboard
 * order. An app the vault does not have is not a tile — Home shows what you
 * have, and Discover is where you get more.
 */
export function buildHomeTiles(input: {
  installedIds: readonly string[];
  content: HomeTileContent;
  now?: number;
}): readonly HomeTileModel[] {
  const now = input.now ?? Date.now();
  const installed = new Set(input.installedIds);
  return HOME_TILE_ORDER.filter((id) => installed.has(id)).flatMap((id) => {
    const meta = apps.find((app) => app.id === id);
    if (!meta) return [];
    return [
      {
        body: bodyFor(id, input.content, now),
        colorKey: meta.colorKey,
        count: countFor(id, input.content),
        countLabel: COUNT_LABEL[id],
        iconKey: meta.iconKey,
        id,
        name: meta.name,
        size: homeTileSize(id),
      },
    ];
  });
}

/**
 * First run is "the vault has no content ANYWHERE" — not "a read is still in
 * flight". A springboard of eight designed empty bodies is eight apologies;
 * one piece of what-to-do copy with dashed placeholders is an instruction. The
 * caller must therefore only ask this once its reads have settled.
 */
export function isFirstRun(tiles: readonly HomeTileModel[]): boolean {
  return tiles.length > 0 && tiles.every((tile) => tile.body.kind === "empty");
}
