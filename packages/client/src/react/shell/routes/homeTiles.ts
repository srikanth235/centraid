import { apps, formatRelativeTime, identityInitials } from "@centraid/design";
import type { AppMetaResolved } from "@centraid/design";

import { formatCurrencyMinor } from "../../../capture.js";
import { HOME_FIRST_MOVE_COPY } from "../../../home-copy.js";

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

export type HomeTileSize = "small" | "medium" | "large";

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

export function homeTileSize(id: HomeTileAppId): HomeTileSize {
  return TILE_SIZE[id];
}

export interface HomeTilePerson {
  id: string;
  name: string;
}

export interface HomeTileFace extends HomeTilePerson {
  initials: string;
}

export interface HomeTileTaskRow {
  title: string;
  done: boolean;
}

export interface HomeTileTaskGlance {
  today: string;
  next: string;
}

export type HomeTileBody =
  | { kind: "photos"; thumbs: readonly string[]; more: number }
  | { kind: "docs"; title: string; excerpt: string }
  | { kind: "agenda"; title: string; at: string; after: string }
  | { kind: "people"; faces: readonly HomeTileFace[]; more: number }
  | {
      kind: "tasks";
      rows: readonly HomeTileTaskRow[];
      glance: HomeTileTaskGlance;
    }
  | { kind: "tally"; figure: string; caption: string }
  | { kind: "locker"; chip: string; tone: "ok" | "warn" }
  | { kind: "notes"; line: string; at: string }
  | { kind: "empty" };

export interface HomeTileModel {
  id: HomeTileAppId;
  name: string;
  iconKey: AppMetaResolved["iconKey"];
  colorKey: AppMetaResolved["colorKey"];
  count: number | null;
  countLabel: string;
  size: HomeTileSize;
  body: HomeTileBody;
}

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

const MOSAIC = 8;
const FACES = 4;
const TASK_ROWS = 3;

function clockOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

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
  if (id === "tally") return null; // the figure IS the number
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

export function partitionHomeTiles(tiles: readonly HomeTileModel[]): {
  live: readonly HomeTileModel[];
  idle: readonly HomeTileModel[];
} {
  return {
    idle: tiles.filter((tile) => tile.body.kind === "empty"),
    live: tiles.filter((tile) => tile.body.kind !== "empty"),
  };
}

export interface HomeFirstMove {
  id: string;
  label: string;
  hint: string;
  iconKey: AppMetaResolved["iconKey"];
  colorKey: AppMetaResolved["colorKey"];
  kind: "app" | "connectors";
}

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

const CONNECTORS_MOVE = {
  colorKey: "teal",
  iconKey: "Plug",
} as const satisfies Pick<HomeFirstMove, "colorKey" | "iconKey">;

export function homeFirstMoves(
  idle: readonly HomeTileModel[],
  limit = 4
): readonly HomeFirstMove[] {
  const idleIds = new Set<string>(idle.map((tile) => tile.id));
  return FIRST_MOVE_ORDER.flatMap<HomeFirstMove>((id) => {
    const copy = HOME_FIRST_MOVE_COPY[id];
    if (!copy) return [];
    if (id === "connectors") {
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
