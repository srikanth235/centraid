// What a Google Takeout archive says ABOUT its photos (#721); what the bytes
// say is blob/pipeline.ts's job. Sidecar pairing is undocumented folklore, so
// every rule here is a heuristic that names which one it is, and a missed rule
// must still import the photo on its own EXIF. Deliberately PURE — entry names
// and bytes in, a plan out — so the guesswork stays testable apart from
// stage-file.ts, which owns the database and staging band.

import { sha256Hex } from "../ids.js";

/**
 * Only what `sniffMediaType` recognises (blob/pipeline.ts) — anything else
 * lands as `kind = 'scan'`. TIFF and AVIF wait on the sniffer.
 */
const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "heic",
  "heif",
  "mp4",
  "mov",
  "m4v",
  "webm",
  "avi",
]);

/** Extensions that make the pair in a Live Photo / motion-photo pair. */
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  "mp4",
  "mov",
  "m4v",
  "webm",
  "avi",
]);

/**
 * Takeout scaffolding, never curation: an album called "Photos from 2019" is
 * one the owner never made. Localised roots cost a stray title, never a photo.
 */
const YEAR_FOLDER = /^(?:photos from )?(?:19|20)\d{2}$/u;
const STRUCTURAL_FOLDERS: ReadonlySet<string> = new Set([
  "takeout",
  "google photos",
]);

/**
 * Shortest stem accepted as a TRUNCATED match (Takeout cuts around 46–51).
 * Below it a shared prefix is coincidence: prefer no sidecar to the wrong one.
 */
const MIN_TRUNCATED_STEM = 40;

/** Takeout writes "0" for an unknown capture time — not the epoch. */
const MIN_EPOCH_S = 1;
/** The year-3000 ceiling `isoTime()` uses in blob/media-metadata.ts. */
const MAX_EPOCH_S = 32_503_680_000;

/** Every field is nullable: absence is a fact. */
export interface SidecarFacts {
  /** `photoTakenTime.timestamp` as an ISO-8601 UTC instant. */
  capturedAt: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Google Photos `description`. */
  caption: string | null;
  favorite: boolean;
}

/** No sidecar (or an unreadable one): the bytes speak for themselves. */
export const NO_SIDECAR_FACTS: SidecarFacts = {
  capturedAt: null,
  latitude: null,
  longitude: null,
  caption: null,
  favorite: false,
};

export interface TakeoutMediaEntry {
  /** Archive-relative, slash-normalised — the stable external id. */
  path: string;
  sidecarPath: string | null;
  sidecar: SidecarFacts;
  /** Null for year folders and the archive root. */
  album: string | null;
  /** Null when nothing in the archive pairs with it. */
  captureGroupId: string | null;
}

export interface TakeoutPlan {
  media: TakeoutMediaEntry[];
  /** Entries consumed AS metadata — reported neither as media nor unrouted. */
  metadata: ReadonlySet<string>;
}

export function normalizeArchivePath(name: string): string {
  return name
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/{2,}/gu, "/");
}

function extensionOf(path: string): string {
  const base = path.split("/").at(-1) ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function fileNameOf(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export function isMediaPath(path: string): boolean {
  return MEDIA_EXTENSIONS.has(extensionOf(path));
}

function isoFromEpochSeconds(raw: unknown): string | null {
  // Epoch SECONDS as a decimal string. "0", missing and absurd all mean "we
  // do not know", which the vault says as NULL — never 1970.
  const seconds =
    typeof raw === "string"
      ? Number(raw)
      : typeof raw === "number"
        ? raw
        : Number.NaN;
  if (
    !Number.isFinite(seconds) ||
    seconds < MIN_EPOCH_S ||
    seconds > MAX_EPOCH_S
  )
    return null;
  return new Date(seconds * 1000).toISOString();
}

function numberAt(source: unknown, key: string): number | null {
  if (typeof source !== "object" || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * EXACT (0, 0) MEANS ABSENT — Takeout writes `0.0` for every unlocated photo,
 * so a real 0°N 0°E photo loses its coordinates instead. `geoDataExif` is
 * ignored: the spool pipeline already reads that EXIF off the bytes.
 */
function geoOf(sidecar: Record<string, unknown>): {
  latitude: number | null;
  longitude: number | null;
} {
  const geo = sidecar.geoData;
  const latitude = numberAt(geo, "latitude");
  const longitude = numberAt(geo, "longitude");
  if (latitude === null || longitude === null)
    return { latitude: null, longitude: null };
  if (latitude === 0 && longitude === 0)
    return { latitude: null, longitude: null };
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180)
    return { latitude: null, longitude: null };
  return { latitude, longitude };
}

/** Anything unreadable yields no facts. */
export function parseTakeoutSidecar(text: string): SidecarFacts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Recovery, not a swallow: a corrupt sidecar must not fail its photo.
    return NO_SIDECAR_FACTS;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return NO_SIDECAR_FACTS;
  const sidecar = parsed as Record<string, unknown>;
  const takenTime = sidecar.photoTakenTime;
  const timestamp =
    typeof takenTime === "object" && takenTime !== null
      ? (takenTime as Record<string, unknown>).timestamp
      : undefined;
  const description = sidecar.description;
  const caption =
    typeof description === "string" && description.trim().length > 0
      ? description.trim()
      : null;
  return {
    capturedAt: isoFromEpochSeconds(timestamp),
    ...geoOf(sidecar),
    caption,
    favorite: sidecar.favorited === true,
  };
}

/**
 * Google's conventions, most-certain first: `IMG_1234.HEIC.json`; the
 * `.supplemental-metadata` family (matched by prefix in `resolveSidecar`, never
 * enumerated); `IMG_1234(1).HEIC` → `IMG_1234.HEIC(1).json`; and
 * `IMG_1234-edited.jpg`, which shares the original's.
 */
function sidecarStems(fileName: string): string[] {
  const stems = [fileName];
  const duplicate = /^(?<stem>.*)(?<marker>\(\d+\))(?<ext>\.[^.]+)$/u.exec(
    fileName
  );
  if (duplicate?.groups) {
    const { stem, marker, ext } = duplicate.groups;
    stems.push(`${stem}${ext}${marker}`);
  }
  const edited = /^(?<stem>.*)-edited(?<ext>\.[^.]+)$/u.exec(fileName);
  if (edited?.groups) {
    stems.push(...sidecarStems(`${edited.groups.stem}${edited.groups.ext}`));
  }
  return stems;
}

function resolveSidecar(
  fileName: string,
  siblings: Map<string, string>
): string | null {
  const stems = sidecarStems(fileName);
  for (const stem of stems) {
    const exact = siblings.get(stem);
    if (exact) return exact;
  }
  // `.supplemental-metadata` family: a stem extending one of ours by a dotted
  // suffix. Shortest wins when both somehow exist.
  let best: { stem: string; path: string } | null = null;
  for (const [stem, path] of siblings) {
    if (!stems.some((candidate) => stem.startsWith(`${candidate}.`))) continue;
    if (best === null || stem.length < best.stem.length) best = { stem, path };
  }
  if (best) return best.path;
  // Truncation LAST: longest prefix wins, only above MIN_TRUNCATED_STEM.
  for (const [stem, path] of siblings) {
    if (stem.length < MIN_TRUNCATED_STEM) continue;
    if (!fileName.startsWith(stem)) continue;
    if (best === null || stem.length > best.stem.length) best = { stem, path };
  }
  return best?.path ?? null;
}

/**
 * Extension, `(n)` and `-edited` stripped, so `IMG_1234.HEIC/.MP4/-edited`
 * name one moment. Directory-scoped: two albums' `IMG_1234` are not one click.
 */
function pairingKey(path: string): string {
  const fileName = fileNameOf(path);
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return `${directoryOf(path)}/${stem
    .replace(/\(\d+\)$/u, "")
    .replace(/-edited$/u, "")
    .toLowerCase()}`;
}

/**
 * The folder IS the album, minus the exclusions above. A `metadata.json` title
 * wins when present; its ABSENCE is not disqualifying — older exports shipped
 * albums without one.
 */
function albumTitleFor(
  directory: string,
  folderTitles: Map<string, string>
): string | null {
  if (directory === "") return null;
  const folder = fileNameOf(directory);
  const normalized = folder.trim().toLowerCase();
  if (YEAR_FOLDER.test(normalized)) return null;
  if (STRUCTURAL_FOLDERS.has(normalized)) return null;
  return folderTitles.get(directory) ?? folder;
}

function folderTitleOf(data: Buffer): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString("utf8"));
  } catch {
    // The folder name still names the album: this costs a nicety, not a row.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const title = (parsed as Record<string, unknown>).title;
  return typeof title === "string" && title.trim().length > 0
    ? title.trim()
    : null;
}

export function planTakeout(
  entries: readonly { name: string; data: Buffer }[]
): TakeoutPlan {
  const metadata = new Set<string>();
  const folderTitles = new Map<string, string>();
  const sidecarBytes = new Map<string, Buffer>();
  const sidecarsByDirectory = new Map<string, Map<string, string>>();
  const mediaPaths: string[] = [];

  for (const entry of entries) {
    const path = normalizeArchivePath(entry.name);
    if (isMediaPath(path)) {
      mediaPaths.push(path);
      continue;
    }
    if (extensionOf(path) !== "json") continue;
    const fileName = fileNameOf(path);
    const directory = directoryOf(path);
    if (fileName === "metadata.json") {
      // Consumed whether or not it parses, so a malformed one is never
      // reported to the owner as an unimported file.
      metadata.add(path);
      const title = folderTitleOf(entry.data);
      if (title) folderTitles.set(directory, title);
      continue;
    }
    const stem = fileName.slice(0, -".json".length);
    let index = sidecarsByDirectory.get(directory);
    if (!index) {
      index = new Map<string, string>();
      sidecarsByDirectory.set(directory, index);
    }
    index.set(stem, path);
    sidecarBytes.set(path, entry.data);
  }

  // A capture group needs an image AND a video sharing a key: a lone `.MOV`
  // is a video, not half a Live Photo.
  const byPairingKey = new Map<string, string[]>();
  for (const path of mediaPaths) {
    const key = pairingKey(path);
    const group = byPairingKey.get(key);
    if (group) group.push(path);
    else byPairingKey.set(key, [path]);
  }

  const media = mediaPaths.map((path) => {
    const directory = directoryOf(path);
    const siblings = sidecarsByDirectory.get(directory);
    const sidecarPath = siblings
      ? resolveSidecar(fileNameOf(path), siblings)
      : null;
    if (sidecarPath) metadata.add(sidecarPath);
    const key = pairingKey(path);
    const group = byPairingKey.get(key) ?? [];
    const paired =
      group.some((member) => VIDEO_EXTENSIONS.has(extensionOf(member))) &&
      group.some((member) => !VIDEO_EXTENSIONS.has(extensionOf(member)));
    return {
      path,
      sidecarPath,
      sidecar: sidecarPath
        ? parseTakeoutSidecar(sidecarBytes.get(sidecarPath)!.toString("utf8"))
        : NO_SIDECAR_FACTS,
      album: albumTitleFor(directory, folderTitles),
      // From the archive-relative key alone, so a re-import derives the same
      // id and `media.add_asset`'s COALESCE merge completes a half-done pair.
      captureGroupId: paired ? `takeout:${sha256Hex(key).slice(0, 32)}` : null,
    } satisfies TakeoutMediaEntry;
  });

  return { media, metadata };
}
