// Home springboard tile content (#708), from the daily brief and the replica
// shell session. Each read settles independently into the designed empty body:
// an empty tile beats a plausible number.

// The Tasks app's OWN predicates (#834): no second answer to "Today".
import { dueLabel, landsToday } from "@centraid/blueprints/apps/tasks/when";
import type { Page, PageQuery, PageRequest } from "@centraid/core/page";

import type { DailyBrief } from "../../../gateway-client.js";
import { authorizeBlobUrl, BLOB_PREFIX } from "../../blueprints/blob-auth.js";
import type {
  HomeTileContent,
  HomeTilePerson,
  HomeTileTaskGlance,
  HomeTileTaskRow,
} from "./homeTiles.js";

/**
 * The tiles' one read: a page of a statement over this seat's own file (#996,
 * R8). It was a declarative `(entity, limit, where)` request against the shaped
 * store; the statement is now written here, where a reviewer can see which
 * table it walks and in what order.
 */
export interface HomeTileReader {
  page: <Row extends object>(
    query: PageQuery<Row>,
    request: PageRequest
  ) => Promise<Page<Row>>;
}

/**
 * What each tile reads, as SQL rather than as a shape.
 *
 * THE WINDOW IS NOW TAKEN IN RECENCY ORDER, which the declarative read could
 * not express: it asked for `limit` rows in whatever order the store held them
 * and every tile then sorted the window in JS. On a vault with more rows than
 * the window that was the WRONG rows sorted correctly — a newest-note tile
 * showing the newest of an arbitrary two dozen. The order is in the statement
 * now, and the JS sorts that follow are left alone: they are cheap over a
 * window and they keep each tile's own tiebreak visible.
 *
 * `live` is the soft-delete guard, per table and by its real columns. The
 * declarative path filtered `deleted_at`/`archived_at` off every row in JS
 * whether or not the table had them; a statement cannot name a column that is
 * not there, so each entry names its own.
 */
interface TileSource {
  readonly table: string;
  readonly pk: string;
  readonly order: string;
  readonly live: readonly string[];
}

const TILE_SOURCES: Readonly<Record<string, TileSource>> = {
  "media.asset": {
    table: "media_asset",
    pk: "asset_id",
    order: "captured_at",
    live: ["deleted_at", "archived_at"],
  },
  "core.content_item": {
    table: "core_content_item",
    pk: "content_id",
    order: "created_at",
    live: ["deleted_at"],
  },
  "core.party": {
    table: "core_party",
    pk: "party_id",
    order: "updated_at",
    live: ["deleted_at"],
  },
  "schedule.task": {
    table: "schedule_task",
    pk: "task_id",
    order: "updated_at",
    live: ["deleted_at"],
  },
  "locker.item": {
    table: "locker_item",
    pk: "item_id",
    order: "updated_at",
    live: ["deleted_at", "archived_at"],
  },
  "tally.expense": {
    table: "tally_expense",
    pk: "expense_id",
    order: "updated_at",
    live: ["deleted_at"],
  },
  "core.document": {
    table: "core_document",
    pk: "document_id",
    order: "updated_at",
    live: ["deleted_at"],
  },
  "knowledge.note": {
    table: "knowledge_note",
    pk: "note_id",
    order: "updated_at",
    live: ["deleted_at"],
  },
};

const WINDOW = { faces: 24, mosaic: 24, recent: 8, tasks: 24 } as const;

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function isLive(values: Record<string, unknown>): boolean {
  return values.deleted_at == null && values.archived_at == null;
}

function byRecency(field: string) {
  return (
    left: { values: Record<string, unknown> },
    right: { values: Record<string, unknown> }
  ): number =>
    text(right.values[field]).localeCompare(text(left.values[field]));
}

function tileQuery(entity: string): PageQuery<Record<string, unknown>> {
  const source = TILE_SOURCES[entity];
  if (!source) throw new Error(`no home-tile source for ${entity}`);
  return {
    name: `home.tile.${entity}`,
    // `*` because a tile reads a different handful of columns per entity and
    // the row shapes are the vault's own; the window is two dozen rows.
    select: "*",
    from: source.table,
    ...(source.live.length > 0
      ? {
          where: source.live
            .map((column) => `"${column}" IS NULL`)
            .join(" AND "),
        }
      : {}),
    order: { sortColumn: source.order, pkColumn: source.pk, descending: true },
  };
}

async function rowsOf(
  reader: HomeTileReader,
  entity: string,
  limit: number
): Promise<readonly { values: Record<string, unknown> }[]> {
  const page = await reader.page(tileQuery(entity), { limit });
  // `isLive` stays as a belt on the statement's brace: the predicate is the
  // authority, and this costs one comparison over a window of two dozen.
  return page.rows
    .filter((values) => isLive(values))
    .map((values) => ({ values }));
}

// A `blob:` handle pins its Blob until revoked, so each load revokes the
// previous load's once its own are ready; a decoded `<img>` keeps painting,
// so the mosaic never blanks (#883).
let liveMosaicUrls: readonly string[] = [];

function swapMosaicUrls(next: readonly string[]): readonly string[] {
  for (const url of liveMosaicUrls) {
    if (next.includes(url)) continue;
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Revoking twice is a no-op, not an error.
    }
  }
  liveMosaicUrls = next;
  return next;
}

/** Call on Home unmount and on re-scope: no handle outlives its vault. */
export function releaseHomeTileBlobs(): void {
  swapMosaicUrls([]);
}

/** Falls back to the ORIGINAL until the thumb derivative exists (#708). */
async function photoThumbs(
  reader: HomeTileReader
): Promise<{ total: number; thumbs: string[] }> {
  const assets = await rowsOf(reader, "media.asset", WINDOW.mosaic);
  const contents = await rowsOf(reader, "core.content_item", WINDOW.mosaic);
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
    .slice(0, 8);
  const urls = await Promise.all(
    newest.map(async (id) => {
      const thumb = await authorizeBlobUrl(
        `${BLOB_PREFIX}/${id}?variant=thumb`
      ).catch(() => null);
      if (thumb !== null) return thumb;
      return authorizeBlobUrl(`${BLOB_PREFIX}/${id}`).catch(() => null);
    })
  );
  return {
    thumbs: [...swapMosaicUrls(urls.filter((url) => url !== null))],
    total: assets.length,
  };
}

async function peopleFaces(
  reader: HomeTileReader
): Promise<{ total: number; directory: HomeTilePerson[] }> {
  const rows = await rowsOf(reader, "core.party", WINDOW.faces);
  const directory = rows
    .filter((row) => text(row.values.kind) === "person")
    .map((row) => ({
      // The face hue derives from the party id, so a rename keeps its colour.
      id: text(row.values.party_id) || text(row.values.display_name),
      name: text(row.values.display_name),
    }))
    .filter((person) => person.name !== "");
  return { directory, total: directory.length };
}

/** NOT DERIVED HERE (#834): `landsToday` and `dueLabel` come from the Tasks
 *  app, so the tile cannot disagree with it. */
async function taskBoard(reader: HomeTileReader): Promise<{
  total: number;
  rows: HomeTileTaskRow[];
  glance: HomeTileTaskGlance;
}> {
  const rows = await rowsOf(reader, "schedule.task", WINDOW.tasks);
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
  return { glance: taskGlance(open), rows: model, total: open.length };
}

function taskGlance(
  open: readonly { values: Record<string, unknown> }[]
): HomeTileTaskGlance {
  const now = new Date().toISOString();
  const dated = open
    .map((row) => ({
      due_at: text(row.values.due_at) || null,
      next_due: text(row.values.next_due) || null,
      status: text(row.values.status),
      title: text(row.values.title),
    }))
    .filter((task) => task.title !== "");
  const today = dated.filter((task) => landsToday(task, now)).length;
  const ahead = dated
    .filter((task) => {
      const due = task.next_due ?? task.due_at;
      return due !== null && !landsToday(task, now);
    })
    .map((task) => ({
      due: (task.next_due ?? task.due_at)!,
      title: task.title,
    }))
    .filter((task) => task.due > now)
    .sort((left, right) => left.due.localeCompare(right.due))[0];
  const when = ahead ? dueLabel(ahead.due, now) : null;
  return {
    next: ahead && when ? `next · ${ahead.title}, ${when}` : "",
    today: today > 0 ? `${today} today` : "",
  };
}

async function lockerState(
  reader: HomeTileReader
): Promise<{ total: number; compromised: number }> {
  const rows = await rowsOf(reader, "locker.item", WINDOW.faces);
  return {
    compromised: rows.filter((row) => row.values.compromised === 1).length,
    total: rows.length,
  };
}

/** A zero balance cannot be told from a ledger never used; only the count
 *  says one exists. */
async function tallyCount(reader: HomeTileReader): Promise<number> {
  return (await rowsOf(reader, "tally.expense", WINDOW.faces)).length;
}

const EXCERPT_MAX = 160;

function isProse(mediaType: string): boolean {
  return mediaType.startsWith("text/") || mediaType === "application/markdown";
}

function dataUriText(uri: string): string {
  const comma = uri.indexOf(",");
  if (comma === -1) return "";
  const meta = uri.slice(0, comma);
  const payload = uri.slice(comma + 1);
  try {
    if (!meta.includes(";base64")) return decodeURIComponent(payload);
    // `atob` yields latin1 units; the bytes are UTF-8.
    const bytes = Uint8Array.from(
      atob(payload),
      (ch) => ch.codePointAt(0) ?? 0
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

async function blobText(contentId: string): Promise<string> {
  const url = await authorizeBlobUrl(`${BLOB_PREFIX}/${contentId}`).catch(
    () => null
  );
  if (url === null) return "";
  try {
    return await (await fetch(url)).text();
  } catch {
    return "";
  } finally {
    URL.revokeObjectURL(url);
  }
}

function markdownProseLines(
  raw: string,
  options: { dropHeadings: boolean }
): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const line of raw.split(/\r?\n/u)) {
    if (/^\s*(?:```|~~~)/u.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^\s*#{1,6}\s+/u.test(line);
    if (heading && options.dropHeadings) continue;
    const prose = text(
      line
        .replace(/^\s*#{1,6}\s+/u, "")
        .replace(/^\s*>\s?/u, "")
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, "")
        .replace(/!\[(?<alt>[^\]]*)\]\([^)]*\)/gu, "$<alt>")
        .replace(/\[(?<label>[^\]]*)\]\([^)]*\)/gu, "$<label>")
        .replace(/[`*_~]+/gu, "")
    );
    if (prose !== "") lines.push(prose);
  }
  return lines;
}

function clipToExcerpt(prose: string): string {
  if (prose.length <= EXCERPT_MAX) return prose;
  const cut = prose.slice(0, EXCERPT_MAX + 1);
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > 0 ? space : EXCERPT_MAX).trimEnd()}…`;
}

/** [] when any link is missing — the designed title-only fallback. */
async function contentProse(
  reader: HomeTileReader,
  contentId: string,
  options: { dropHeadings: boolean }
): Promise<string[]> {
  if (contentId === "") return [];
  // ONE row by its primary key. The keyset's tiebreak is the same column the
  // predicate pins, so the order is a formality — but it is the order the
  // cursor is read off, so it is stated rather than left to the table's.
  const page = await reader.page<Record<string, unknown>>(
    {
      name: "home.tile.content-item",
      select: "content_id, media_type, content_uri",
      from: "core_content_item",
      where: "content_id = ?",
      bind: [contentId],
      order: {
        sortColumn: "content_id",
        pkColumn: "content_id",
        descending: false,
      },
    },
    { limit: 1 }
  );
  const values = page.rows[0];
  if (!values || !isProse(text(values.media_type))) return [];
  const uri = typeof values.content_uri === "string" ? values.content_uri : "";
  const raw = uri.startsWith("data:")
    ? dataUriText(uri)
    : uri.startsWith("blob:")
      ? await blobText(contentId)
      : "";
  return markdownProseLines(raw, options);
}

async function newestDoc(
  reader: HomeTileReader
): Promise<{ total: number; title?: string; excerpt?: string }> {
  const rows = await rowsOf(reader, "core.document", WINDOW.recent);
  const newest = [...rows].sort(byRecency("updated_at"))[0];
  if (!newest) return { total: rows.length };
  const excerpt = clipToExcerpt(
    (
      await contentProse(reader, text(newest.values.current_content_id), {
        dropHeadings: true,
      }).catch(() => [])
    ).join(" ")
  );
  return {
    total: rows.length,
    ...(excerpt === "" ? {} : { excerpt }),
    title: text(newest.values.title),
  };
}

async function newestNote(
  reader: HomeTileReader
): Promise<{ total: number; line?: string; at?: string }> {
  const rows = await rowsOf(reader, "knowledge.note", WINDOW.recent);
  const newest = [...rows].sort(byRecency("updated_at"))[0];
  if (!newest) return { total: rows.length };
  // Headings KEPT, unlike Docs: a note's opening heading appears nowhere else.
  const [first] = await contentProse(
    reader,
    text(newest.values.body_content_id),
    { dropHeadings: false }
  ).catch(() => []);
  const line = clipToExcerpt(first ?? "") || text(newest.values.title);
  return {
    total: rows.length,
    at: text(newest.values.updated_at),
    line,
  };
}

/** One app's missing grant must not blank the other tiles. */
export async function loadHomeTileContent(input: {
  reader: HomeTileReader;
  brief?: DailyBrief | undefined;
}): Promise<HomeTileContent> {
  const brief = input.brief;
  const [photos, people, tasks, locker, docs, notes, expenses] =
    await Promise.all([
      photoThumbs(input.reader).catch(() => undefined),
      peopleFaces(input.reader).catch(() => undefined),
      taskBoard(input.reader).catch(() => undefined),
      lockerState(input.reader).catch(() => undefined),
      newestDoc(input.reader).catch(() => undefined),
      newestNote(input.reader).catch(() => undefined),
      tallyCount(input.reader).catch(() => 0),
    ]);
  return {
    ...(brief
      ? { agenda: { events: brief.events, total: brief.events.length } }
      : {}),
    ...(brief && expenses > 0
      ? {
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
    // The brief counts TODAY's imports; the tile counts all.
    ...(photos
      ? { photos }
      : brief
        ? { photos: { thumbs: [], total: brief.newPhotos } }
        : {}),
    ...(tasks ? { tasks } : {}),
  };
}

export async function homeTileReader(): Promise<HomeTileReader> {
  const { getReplicaShellSession } =
    await import("../../../replica/shell-session-scopes.js");
  return getReplicaShellSession();
}
