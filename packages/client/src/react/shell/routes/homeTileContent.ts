// Real content for the Home springboard tiles (issue #708, section A).
//
// Two sources, both already the shell's own:
//
//   1. The daily brief (`getDailyBrief`) — a real, content-minimized gateway
//      read over core_event / schedule_task / media_media_asset / tally_expense.
//      It already backs Home, so agenda, the tally figure and the photo count
//      cost nothing extra.
//   2. The replica shell session — the same door `searchPaletteEntities` uses.
//      `session.read(appId, { entity })` resolves the shape from the app's own
//      grant, so an app that is not installed, not granted, or not yet
//      replicated simply fails its read and its tile falls back to the designed
//      empty body. Every read is settled independently for exactly that reason.
//
// No fixtures. A tile with no read path renders the empty body and the seam is
// recorded here in prose rather than papered over with a plausible number.

import type { DailyBrief } from "../../../gateway-client.js";
import { authorizeBlobUrl, BLOB_PREFIX } from "../../blueprints/blob-auth.js";
import type { HomeTileContent, HomeTileTaskRow } from "./homeTiles.js";

/** The replica read surface this module needs — narrowed so the loader can be
 *  driven by a stub in tests without standing up a coordinator. */
export interface HomeTileReader {
  read: (
    appId: string,
    request: { entity: string; limit?: number; purpose?: string }
  ) => Promise<{ rows: readonly { values: Record<string, unknown> }[] }>;
}

/** Why the shell is reading — the grant ledger records a purpose per read. */
const PURPOSE = "home-springboard";

/** Deliberately small windows: a tile shows a handful of rows, and Home is the
 *  most re-entered route in the shell. */
const WINDOW = { faces: 24, mosaic: 24, recent: 8, tasks: 24 } as const;

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function isLive(values: Record<string, unknown>): boolean {
  return values.deleted_at == null && values.archived_at == null;
}

/** Newest-first by whichever timestamp the entity actually carries. */
function byRecency(field: string) {
  return (
    left: { values: Record<string, unknown> },
    right: { values: Record<string, unknown> }
  ): number =>
    text(right.values[field]).localeCompare(text(left.values[field]));
}

async function rowsOf(
  reader: HomeTileReader,
  appId: string,
  entity: string,
  limit: number
): Promise<readonly { values: Record<string, unknown> }[]> {
  const result = await reader.read(appId, { entity, limit, purpose: PURPOSE });
  return result.rows.filter((row) => isLive(row.values));
}

/**
 * The photo mosaic. `core_content_item.content_uri` starting with `blob:` is
 * the same test the Photos app's own `srcOf` applies before it builds a blob
 * route; the `?variant=thumb` derivative is what the grid renders, so the tile
 * asks for exactly the bytes Photos would.
 */
async function photoThumbs(
  reader: HomeTileReader
): Promise<{ total: number; thumbs: string[] }> {
  const assets = await rowsOf(
    reader,
    "photos",
    "media.media_asset",
    WINDOW.mosaic
  );
  const contents = await rowsOf(
    reader,
    "photos",
    "core.content_item",
    WINDOW.mosaic
  );
  const uriById = new Map(
    contents.map((row) => [
      text(row.values.content_id),
      text(row.values.content_uri),
    ])
  );
  const newest = [...assets]
    .sort(byRecency("captured_at"))
    .map((row) => text(row.values.content_id))
    .filter((id) => uriById.get(id)?.startsWith("blob:") === true)
    .slice(0, 4);
  const urls = await Promise.all(
    newest.map((id) =>
      authorizeBlobUrl(`${BLOB_PREFIX}/${id}?variant=thumb`).catch(() => null)
    )
  );
  return {
    thumbs: urls.filter((url): url is string => url !== null),
    total: assets.length,
  };
}

async function peopleFaces(
  reader: HomeTileReader
): Promise<{ total: number; names: string[] }> {
  const rows = await rowsOf(reader, "people", "core.party", WINDOW.faces);
  const names = rows
    .filter((row) => text(row.values.kind) === "person")
    .map((row) => text(row.values.display_name))
    .filter(Boolean);
  return { names, total: names.length };
}

async function taskBoard(
  reader: HomeTileReader
): Promise<{ total: number; rows: HomeTileTaskRow[] }> {
  const rows = await rowsOf(reader, "tasks", "schedule.task", WINDOW.tasks);
  const open = rows.filter((row) => {
    const status = text(row.values.status);
    return status === "needs-action" || status === "in-process";
  });
  const done = [...rows]
    .filter((row) => text(row.values.status) === "completed")
    .sort(byRecency("completed_at"));
  const model: HomeTileTaskRow[] = [
    ...open.map((row) => ({ done: false, title: text(row.values.title) })),
    ...done.slice(0, 1).map((row) => ({
      done: true,
      title: text(row.values.title),
    })),
  ].filter((row) => row.title !== "");
  return { rows: model, total: open.length };
}

async function lockerState(
  reader: HomeTileReader
): Promise<{ total: number; compromised: number }> {
  const rows = await rowsOf(reader, "locker", "locker.item", WINDOW.faces);
  return {
    compromised: rows.filter((row) => row.values.compromised === 1).length,
    total: rows.length,
  };
}

async function newestDoc(
  reader: HomeTileReader
): Promise<{ total: number; title?: string; excerpt?: string }> {
  const rows = await rowsOf(reader, "docs", "core.document", WINDOW.recent);
  const newest = [...rows].sort(byRecency("updated_at"))[0];
  return {
    total: rows.length,
    // SEAM: a document's prose lives in its content item's BYTES, not in a
    // column, so the excerpt would need a blob fetch (and a decode per media
    // type) the springboard has no business doing. The reading-register body
    // renders with the title alone until a read path exposes the excerpt.
    ...(newest ? { title: text(newest.values.title) } : {}),
  };
}

async function newestNote(
  reader: HomeTileReader
): Promise<{ total: number; line?: string; at?: string }> {
  const rows = await rowsOf(reader, "notes", "knowledge.note", WINDOW.recent);
  const newest = [...rows].sort(byRecency("updated_at"))[0];
  return {
    total: rows.length,
    // SEAM (same shape as Docs): `knowledge_note.body_content_id` points at
    // bytes, so the note's true first LINE is not readable here. The title is
    // the note's own first line in every path that creates one, so it stands in
    // the reading register until the body is reachable.
    ...(newest
      ? { at: text(newest.values.updated_at), line: text(newest.values.title) }
      : {}),
  };
}

/**
 * Everything the springboard can honestly show, gathered concurrently. Every
 * branch is independently settled: one app's missing grant must not blank the
 * other seven tiles.
 */
export async function loadHomeTileContent(input: {
  reader: HomeTileReader;
  brief?: DailyBrief | undefined;
}): Promise<HomeTileContent> {
  const brief = input.brief;
  const [photos, people, tasks, locker, docs, notes] = await Promise.all([
    photoThumbs(input.reader).catch(() => undefined),
    peopleFaces(input.reader).catch(() => undefined),
    taskBoard(input.reader).catch(() => undefined),
    lockerState(input.reader).catch(() => undefined),
    newestDoc(input.reader).catch(() => undefined),
    newestNote(input.reader).catch(() => undefined),
  ]);
  return {
    // The brief already expanded recurrences for today's window; re-deriving
    // them from raw `core.event` rows here would be a second, worse copy.
    ...(brief
      ? {
          agenda: { events: brief.events, total: brief.events.length },
          tally: {
            balanceMinor: brief.balanceMinor,
            currency: brief.currency,
          },
        }
      : {}),
    ...(docs ? { docs } : {}),
    ...(locker ? { locker } : {}),
    ...(notes ? { notes } : {}),
    ...(people ? { people } : {}),
    // The brief's photo count is TODAY's imports; the tile's count is the
    // library, so the mosaic read owns it and the brief only fills the gap.
    ...(photos
      ? { photos }
      : brief
        ? { photos: { thumbs: [], total: brief.newPhotos } }
        : {}),
    ...(tasks ? { tasks } : {}),
  };
}

/** The shell's ambient replica scope, loaded lazily for the same reason the
 *  palette does it: importing this module must not boot the replica. */
export async function homeTileReader(): Promise<HomeTileReader> {
  const { getReplicaShellSession } =
    await import("../../../replica/shell-session.js");
  return getReplicaShellSession();
}
