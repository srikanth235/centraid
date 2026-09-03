import { dueLabel, landsToday } from "@centraid/blueprints/apps/tasks/when";

import type { DailyBrief } from "../../../gateway-client.js";
import { authorizeBlobUrl, BLOB_PREFIX } from "../../blueprints/blob-auth.js";
import type {
  HomeTileContent,
  HomeTilePerson,
  HomeTileTaskGlance,
  HomeTileTaskRow,
} from "./homeTiles.js";

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

async function rowsOf(
  reader: HomeTileReader,
  appId: string,
  entity: string,
  limit: number
): Promise<readonly { values: Record<string, unknown> }[]> {
  const result = await reader.read(appId, { entity, limit });
  return result.rows.filter((row) => isLive(row.values));
}

let liveMosaicUrls: readonly string[] = [];

function swapMosaicUrls(next: readonly string[]): readonly string[] {
  for (const url of liveMosaicUrls) {
    if (next.includes(url)) continue;
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Intentionally empty.
    }
  }
  liveMosaicUrls = next;
  return next;
}

export function releaseHomeTileBlobs(): void {
  swapMosaicUrls([]);
}

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
  const rows = await rowsOf(reader, "people", "core.party", WINDOW.faces);
  const directory = rows
    .filter((row) => text(row.values.kind) === "person")
    .map((row) => ({
      id: text(row.values.party_id) || text(row.values.display_name),
      name: text(row.values.display_name),
    }))
    .filter((person) => person.name !== "");
  return { directory, total: directory.length };
}

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
  const rows = await rowsOf(reader, "locker", "locker.item", WINDOW.faces);
  return {
    compromised: rows.filter((row) => row.values.compromised === 1).length,
    total: rows.length,
  };
}

async function tallyCount(reader: HomeTileReader): Promise<number> {
  return (await rowsOf(reader, "tally", "tally.expense", WINDOW.faces)).length;
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
    await import("../../../replica/shell-session.js");
  return getReplicaShellSession();
}
