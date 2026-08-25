// The Home springboard's tile model (#708, section A).
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
import { HOME_FIRST_MOVE_COPY } from "../../../home-copy.js";

/**
 * Springboard order, taken from the handoff's own tile list rather than from a
 * freshness rule. It leads with the two bodies that carry IMAGERY and PROSE —
 * the mosaic and the reading register — and only then runs the small chips.
 *
 * Sorting by how often an app's content changes (agenda and tasks first, the
 * standing library last) is a sound rule and the wrong one here: it puts two
 * 1×1 chips in the top-left and pushes the mosaic to the right, so the first
 * thing the eye meets on Home is a checkbox list. The
 * mosaic is the only body that needs area to be itself; giving it the corner is
 * what makes the grid read as a page with a subject instead of a launcher with
 * a picture in it. Freshness still decides what is IN a tile — it just no
 * longer decides where the tile sits.
 */
export const HOME_TILE_ORDER = [
  "photos",
  "docs",
  "notes",
  "agenda",
  "tasks",
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
 * names no Notes app, but Notes' body IS the Docs body (title over compact
 * prose), and the size class follows the body.
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

/** One person in the directory, as the tile model needs them: a STABLE id and
 *  the name it renders. The id is what the face circle's hue is derived from
 *  (see `HomeTileFace`), so it is carried all the way from the read. */
export interface HomeTilePerson {
  id: string;
  name: string;
}

/** One overlapping face circle. Identity, never a photo we do not have. */
export interface HomeTileFace extends HomeTilePerson {
  initials: string;
}

/** A task row. Exactly one of these may be `done` — see `taskRows`. */
export interface HomeTileTaskRow {
  title: string;
  done: boolean;
}

/**
 * The Tasks tile's glance (#834): how much lands TODAY, and what is next.
 *
 * NOT A BADGE AND NOT AN ALARM. "3 today" is a pile the member can look at,
 * drawn in the tile's own body ink like every other tile's summary — there is
 * no count on the icon, no dot, and nothing red anywhere near it. Both halves
 * are absent rather than zero: a day with nothing due says nothing, because
 * "0 today" is a score.
 */
export interface HomeTileTaskGlance {
  /** `3 today`, or "" when nothing lands today. */
  today: string;
  /** `next · Sign the transfer, Friday`, or "" when nothing is dated. */
  next: string;
}

/**
 * The structurally distinct tile bodies. `empty` is the one that never renders:
 * it is how a tile says it has not earned the grid yet.
 */
export type HomeTileBody =
  /** Thumbnail mosaic, bleeding to the tile edge. */
  | { kind: "photos"; thumbs: readonly string[]; more: number }
  /** Title plus compact prose excerpt. */
  | { kind: "docs"; title: string; excerpt: string }
  /** The next event, with the one after it pinned to the tile bottom. */
  | { kind: "agenda"; title: string; at: string; after: string }
  /** Overlapping face circles. */
  | { kind: "people"; faces: readonly HomeTileFace[]; more: number }
  /** Checkbox rows; the most recently completed one is struck through, with
   *  the glance above them (#834). */
  | {
      kind: "tasks";
      rows: readonly HomeTileTaskRow[];
      glance: HomeTileTaskGlance;
    }
  /** One large figure in the numeric register. */
  | { kind: "tally"; figure: string; caption: string }
  /** A state chip. */
  | { kind: "locker"; chip: string; tone: "ok" | "warn" }
  /** The most recent note's first line, in the compact body register. */
  | { kind: "notes"; line: string; at: string }
  /** Nothing to show. A MARKER, not a rendering: `partitionHomeTiles` reads it
   *  to keep this app out of the grid entirely, and the invitation to fill it
   *  lives once, in `homeFirstMoves`. Carrying what-to-do copy here as well
   *  would be two spellings of one state, the drift `home-copy.ts` exists to
   *  prevent. */
  | { kind: "empty" };

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
  people?: { total: number; directory: readonly HomeTilePerson[] };
  tasks?: {
    total: number;
    rows: readonly HomeTileTaskRow[];
    /** Today's count and the next dated row — the tile's glance (#834). */
    glance?: HomeTileTaskGlance;
  };
  tally?: { balanceMinor: number; currency: string };
  locker?: { total: number; compromised: number };
  notes?: { total: number; line?: string; at?: string };
}

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

/**
 * Thumbnails a mosaic shows; the rest becomes a "+N".
 *
 * EIGHT, matching the handoff: the mosaic is four columns by two rows on the
 * 2×2 tile, and it is the one body that gets worse as it shrinks. Four cells
 * in that area read as four big crops of nothing in particular; eight read as
 * a camera roll, which is the claim the tile is making. Compact keeps the four
 * columns and drops to a single row when `large` flattens to 2×1.
 */
const MOSAIC = 8;
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
  const empty: HomeTileBody = { kind: "empty" };
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
    if (!people || people.directory.length === 0) return empty;
    return {
      faces: people.directory.slice(0, FACES).map((person) => ({
        id: person.id,
        initials: identityInitials(person.name),
        name: person.name,
      })),
      kind: "people",
      more: Math.max(
        0,
        people.total - Math.min(FACES, people.directory.length)
      ),
    };
  }
  if (id === "tasks") {
    const tasks = content.tasks;
    const rows = taskRows(tasks?.rows ?? []);
    if (!tasks || rows.length === 0) return empty;
    return {
      glance: tasks.glance ?? { next: "", today: "" },
      kind: "tasks",
      rows,
    };
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
 * order.
 *
 * Since #708 every bundled app is installed at vault mount, so in practice this
 * is all eight, every time. The filter stays because it states the rule the grid
 * actually obeys — a tile is a door into an app this vault HAS — and because an
 * audience vault mid-mount, or a release that ships a ninth app to a gateway
 * that has not restarted, is a real state that must render a shorter grid rather
 * than a broken tile.
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
 * Split the springboard into the tiles that have earned the grid and the apps
 * that have not.
 *
 * A BINARY over the same information gets both ends wrong: with nothing
 * anywhere it produces one sentence over four dashed rectangles; with one note
 * anywhere it flips and produces all eight tiles, seven of them apologising —
 * the "eight apologies" the day-one treatment exists to prevent, arriving one
 * note later. A vault fills up gradually, so the
 * surface has to be graded too: a tile is in the grid when it has something to
 * show, and everything else becomes an INVITATION rather than an absence.
 *
 * `live` keeps springboard order, so a tile does not move when its neighbour
 * fills — Home grows into itself rather than re-laying out under the reader.
 *
 * The caller must only ask once its reads have settled: an unanswered read is
 * "still looking", which is a different sentence from "there is nothing".
 */
export function partitionHomeTiles(tiles: readonly HomeTileModel[]): {
  live: readonly HomeTileModel[];
  idle: readonly HomeTileModel[];
} {
  return {
    idle: tiles.filter((tile) => tile.body.kind === "empty"),
    live: tiles.filter((tile) => tile.body.kind !== "empty"),
  };
}

/** One thing a member can do that will actually put something on this page. */
export interface HomeFirstMove {
  /** App id, or `connectors` for the one move that is not an app. */
  id: string;
  label: string;
  hint: string;
  iconKey: AppMetaResolved["iconKey"];
  colorKey: AppMetaResolved["colorKey"];
  /** Where selecting it goes — an app surface, or the Connectors page. */
  kind: "app" | "connectors";
}

/**
 * Leverage order, which is not springboard order.
 *
 * `connectors` leads because it is the only move whose result is bigger than the
 * act: mail, calendar and contacts arrive on their own afterwards, so one
 * decision fills three tiles. Photos and Docs come next because they are what
 * the day-one copy actually promises ("bring your photographs and documents
 * in"), and the rest follow by how quickly they pay back a single action.
 */
const FIRST_MOVE_ORDER = [
  "connectors",
  "photos",
  "docs",
  "notes",
  "agenda",
  "tasks",
  "people",
  "tally",
  "locker",
] as const;

/** Connectors is not an app, so it carries no entry in the app registry. */
const CONNECTORS_MOVE = {
  colorKey: "teal",
  iconKey: "Plug",
} as const satisfies Pick<HomeFirstMove, "colorKey" | "iconKey">;

/**
 * The first moves to offer, given the apps that are still empty.
 *
 * Every move lands somewhere that can TAKE content. The placeholders these
 * replace opened the empty app they were named after, which is a dead end
 * wearing an invitation — you arrive at the same emptiness one click deeper,
 * with no more idea what to do than before.
 */
export function homeFirstMoves(
  idle: readonly HomeTileModel[],
  limit = 4
): readonly HomeFirstMove[] {
  const idleIds = new Set<string>(idle.map((tile) => tile.id));
  return FIRST_MOVE_ORDER.flatMap<HomeFirstMove>((id) => {
    const copy = HOME_FIRST_MOVE_COPY[id];
    if (!copy) return [];
    if (id === "connectors") {
      // Offered while ANY app is empty: the accounts it connects fill several
      // of them, so it is never the wrong suggestion while the page is thin.
      return idle.length === 0
        ? []
        : [{ ...CONNECTORS_MOVE, ...copy, id, kind: "connectors" }];
    }
    if (!idleIds.has(id)) return [];
    const meta = apps.find((app) => app.id === id);
    if (!meta) return [];
    return [
      {
        ...copy,
        colorKey: meta.colorKey,
        iconKey: meta.iconKey,
        id,
        kind: "app",
      },
    ];
  }).slice(0, limit);
}
