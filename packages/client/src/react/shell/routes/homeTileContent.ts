// Real content for the Home springboard tiles (issue #708, section A).
//
// Two sources, both already the shell's own:
//
//   1. The daily brief (`getDailyBrief`) — a real, content-minimized gateway
//      read over core_event / schedule_task / media_asset / tally_expense.
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

// The Tasks app's OWN "when" predicates (#834). `when.ts` is an import-free
// leaf for exactly this reason: the tile must not grow a second answer to
// "does this touch Today", and blueprint app sources are not type-checked
// under the client program.
import { dueLabel, landsToday } from "@centraid/blueprints/apps/tasks/when";

import type { DailyBrief } from "../../../gateway-client.js";
import { authorizeBlobUrl, BLOB_PREFIX } from "../../blueprints/blob-auth.js";
import type {
  HomeTileContent,
  HomeTilePerson,
  HomeTileTaskGlance,
  HomeTileTaskRow,
} from "./homeTiles.js";

/** The replica read surface this module needs — narrowed so the loader can be
 *  driven by a stub in tests without standing up a coordinator. */
export interface HomeTileReader {
  read: (
    appId: string,
    request: {
      entity: string;
      limit?: number;
      purpose?: string;
      where?: { column: string; op: "eq"; value: string }[];
    }
  ) => Promise<{ rows: readonly { values: Record<string, unknown> }[] }>;
}

// TRAP (issue #708): `purpose` on a replica read is NOT an audit label — it is
// a SHAPE SELECTOR. `ReplicaShellSession.resolveShapeId` filters the catalog by
// `shape.purpose === purpose`, so a value the catalog has never heard of
// matches no shape and the read throws `No offline shape for <app>/<entity>`.
// This module used to pass "home-springboard", describing why the shell was
// reading, and every one of the seven reads below threw — silently, because
// each is `.catch()`-ed so one app's missing grant cannot blank the other
// tiles. The visible result was a Home that stayed empty no matter how much
// content the vault held: Agenda and the tally figure survived only because
// they come from the brief instead.
//
// Omitting it lets the session apply `DEFAULT_REPLICA_PURPOSE`, which is what
// the shapes are actually registered under and what the palette (the other
// shell-side reader, `paletteEntitySearch.ts`) has always relied on.

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
  const result = await reader.read(appId, { entity, limit });
  return result.rows.filter((row) => isLive(row.values));
}

/**
 * The photo mosaic. `core_content_item.content_uri` starting with `blob:` is
 * the same test the Photos app's own `srcOf` applies before it builds a blob
 * route; the `?variant=thumb` derivative is what the grid renders, so the tile
 * asks for exactly the bytes Photos would.
 *
 * ...and falls back to the ORIGINAL when that derivative does not exist yet
 * (issue #708). `resolveServableBlob` answers `no-variant` → 404 for a photo
 * whose thumb the preview backstop has not generated, which is the state EVERY
 * photo is in for a while after it is imported. The mosaic rendered blank on a
 * library of ten pictures for exactly this reason. The fallback is the Photos
 * grid's own behaviour for small images (its `THUMB_EDGE` ceiling paints the
 * original directly), and it is the owner reading their own bytes on their own
 * device — not the derivatives-only provider-egress surface.
 */
async function photoThumbs(
  reader: HomeTileReader
): Promise<{ total: number; thumbs: string[] }> {
  const assets = await rowsOf(reader, "photos", "media.asset", WINDOW.mosaic);
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
    // Eight, because the mosaic is 4×2 on the large tile (see `MOSAIC` in
    // homeTiles.ts). Authorizing more than the grid can show would be paid for
    // in blob fetches nobody sees.
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
    thumbs: urls.filter((url): url is string => url !== null),
    total: assets.length,
  };
}

async function peopleFaces(
  reader: HomeTileReader
): Promise<{ total: number; directory: HomeTilePerson[] }> {
  const rows = await rowsOf(reader, "people", "core.party", WINDOW.faces);
  const directory = rows
    .filter((row) => text(row.values.kind) === "person")
    .map((row) => ({
      // The party id, because the face circle's hue is derived from it and a
      // person has to stay the same colour through a rename — and the same
      // colour as the phone's Home draws them, which derives from this same
      // id. A row with no id falls back to the name: a stable-enough key for
      // one render, and the alternative is dropping the person entirely.
      id: text(row.values.party_id) || text(row.values.display_name),
      name: text(row.values.display_name),
    }))
    .filter((person) => person.name !== "");
  return { directory, total: directory.length };
}

/**
 * The Tasks tile: the rows, plus the glance (#834).
 *
 * WHAT LANDS TODAY AND WHAT IS NEXT ARE NOT DERIVED HERE. `landsToday` is the
 * one predicate in the product that answers "does this touch Today", and
 * `dueLabel` is the one phrase that says when — both are imported from the
 * Tasks app itself, so the tile cannot quietly disagree with the room it is a
 * door into. That is also what keeps the rule an UNDATED TASK NEVER TOUCHES
 * TODAY true on this surface: `landsToday` returns false without a due value,
 * in this code path exactly as in every other.
 */
async function taskBoard(reader: HomeTileReader): Promise<{
  total: number;
  rows: HomeTileTaskRow[];
  glance: HomeTileTaskGlance;
}> {
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
  return { glance: taskGlance(open), rows: model, total: open.length };
}

/** The tile's own words for today's pile and the next dated row. */
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
  // The next thing AHEAD of today — what today already holds is the first
  // half of the glance, and repeating it as "next" would say it twice.
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
  const rows = await rowsOf(reader, "locker", "locker.item", WINDOW.faces);
  return {
    compromised: rows.filter((row) => row.values.compromised === 1).length,
    total: rows.length,
  };
}

/**
 * How many expenses the ledger actually holds.
 *
 * The brief carries a BALANCE and no count, and a balance of zero is
 * indistinguishable from a ledger that has never been used — which is how an
 * untouched vault grew a live "₹0.00 · All settled" tile. Worse than cosmetic:
 * a live tile made Home stop being day one, so the whole what-to-do treatment
 * disappeared the moment the brief settled, and "All settled" claims a
 * settlement that never happened. The count is the thing that says whether
 * there is a ledger at all, so the tile reads the rows.
 */
async function tallyCount(reader: HomeTileReader): Promise<number> {
  return (await rowsOf(reader, "tally", "tally.expense", WINDOW.faces)).length;
}

/** Longest excerpt the reading-register body can use: the tile clamps at three
 *  lines of serif, and a longer string is paid for in decode work nobody sees. */
const EXCERPT_MAX = 160;

/** Media types whose bytes decode to prose. `mintContentFromDataUri` keeps
 *  `text/*` INLINE in the row (the FTS feed) and spills everything else to the
 *  CAS, so this test is also the split between the two decode branches below —
 *  except the staged-upload path, which lands even text in the CAS. */
function isProse(mediaType: string): boolean {
  return mediaType.startsWith("text/") || mediaType === "application/markdown";
}

/** Decode a `data:` URI's payload to text, or "" for anything unreadable. */
function dataUriText(uri: string): string {
  const comma = uri.indexOf(",");
  if (comma === -1) return "";
  const meta = uri.slice(0, comma);
  const payload = uri.slice(comma + 1);
  try {
    if (!meta.includes(";base64")) return decodeURIComponent(payload);
    // `atob` yields latin1 code units; the bytes are UTF-8, so re-decode them.
    const bytes = Uint8Array.from(
      atob(payload),
      (ch) => ch.codePointAt(0) ?? 0
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

/** Fetch a CAS-held text body the way `photoThumbs` fetches image bytes: the
 *  owner reading their own bytes through the authed blob route. Any refusal is
 *  "", which degrades the tile to today's title-only body. */
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

/**
 * Markdown, reduced to plain prose lines.
 *
 * Not a parser — the tile needs a sentence, not a document model. Fenced code
 * is dropped whole; heading LINES are dropped when asked (the doc tile already
 * shows the title, and the seeded bodies open with a `# <title>` heading that
 * would otherwise repeat it word for word); list, quote, emphasis and link
 * markers are stripped so their text reads as the prose it is.
 */
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

/** Tile-sized cut, on a word, with an ellipsis only when something was lost. */
function clipToExcerpt(prose: string): string {
  if (prose.length <= EXCERPT_MAX) return prose;
  const cut = prose.slice(0, EXCERPT_MAX + 1);
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > 0 ? space : EXCERPT_MAX).trimEnd()}…`;
}

/**
 * The prose behind ONE content item, as stripped lines — or [] whenever any
 * link in the chain is missing: no row, a non-text media type, an undecodable
 * payload. [] is the seam's designed fallback (title-only body), so a binary
 * PDF and a refused blob fetch land on exactly today's rendering.
 */
async function contentProse(
  reader: HomeTileReader,
  appId: string,
  contentId: string,
  options: { dropHeadings: boolean }
): Promise<string[]> {
  if (contentId === "") return [];
  const result = await reader.read(appId, {
    entity: "core.content_item",
    limit: 1,
    where: [{ column: "content_id", op: "eq", value: contentId }],
  });
  const values = result.rows[0]?.values;
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
  const rows = await rowsOf(reader, "docs", "core.document", WINDOW.recent);
  const newest = [...rows].sort(byRecency("updated_at"))[0];
  if (!newest) return { total: rows.length };
  // The document's prose lives in its content item's bytes
  // (`current_content_id`), not in a column — this is the read that closes the
  // seam the tile used to record here in prose. Settled independently: a
  // missing shape, a binary media type or a refused blob fetch must degrade to
  // the title-only body, never blank the tile.
  const excerpt = clipToExcerpt(
    (
      await contentProse(
        reader,
        "docs",
        text(newest.values.current_content_id),
        { dropHeadings: true }
      ).catch(() => [])
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
  const rows = await rowsOf(reader, "notes", "knowledge.note", WINDOW.recent);
  const newest = [...rows].sort(byRecency("updated_at"))[0];
  if (!newest) return { total: rows.length };
  // Same seam, same read path as Docs: `knowledge_note.body_content_id` points
  // at bytes, and the body's true first line is what the tile promises. The
  // title stays as the fallback — it IS the note's first line in every path
  // that creates one, so a missing or binary body reads exactly as before.
  // Headings are KEPT here: a note that opens with `# Groceries` opens with
  // the word "Groceries", and that heading is not repeated anywhere on the
  // tile the way the doc title is.
  const [first] = await contentProse(
    reader,
    "notes",
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
    // The brief already expanded recurrences for today's window; re-deriving
    // them from raw `core.event` rows here would be a second, worse copy.
    ...(brief
      ? { agenda: { events: brief.events, total: brief.events.length } }
      : {}),
    // The figure comes from the brief; whether there is a figure to show at all
    // comes from the rows (see `tallyCount`).
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
