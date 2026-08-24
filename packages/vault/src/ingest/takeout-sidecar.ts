// What a Google Takeout archive says ABOUT its photos (#721) — as
// opposed to what the photos' own bytes say, which is the spool pipeline's
// job (blob/pipeline.ts).
//
// A Takeout export is a bag of media files beside a parallel bag of `.json`
// sidecars, and the pairing between them is folklore. Google has shipped at
// least four naming conventions for the same relationship —
// `IMG_1234.HEIC.json`, `IMG_1234.HEIC.supplemental-metadata.json`, the
// duplicate marker migrating to the END of the name in `IMG_1234.HEIC(1).json`,
// and long names truncated mid-word — none of them documented. So every rule
// in this file is a heuristic and says which one it is. When a rule misses,
// the photo still imports; it imports with only what its own EXIF proves,
// which is the honest outcome, not a lost photo.
//
// The module is deliberately pure — entry names and bytes in, a plan out. The
// zip walk in stage-file.ts owns the database and the staging band; this owns
// the guesswork, and the guesswork is the part that has to be testable on its
// own.

import { sha256Hex } from "../ids.js";

/**
 * The media extensions the library accepts from an archive.
 *
 * The principle is NOT "every format that exists": it is "every format
 * `sniffMediaType` recognises from magic bytes or its extension table"
 * (blob/pipeline.ts). Anything else would stage as
 * `application/octet-stream`, land as `kind = 'scan'`, and claim to be a
 * photograph on no evidence. TIFF and AVIF are deliberately absent for
 * exactly that reason — add them here when the sniffer learns them.
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
 * Folder names that are Takeout's own scaffolding, never owner curation.
 * `Photos from 2019` (and a bare `2019`) is the export's chronological
 * bucket — the timeline already knows when a photo was taken, so filing it
 * into an album called "Photos from 2019" would invent a curation the owner
 * never made. Localised roots exist (`Google Fotos`, …); this recognises the
 * English ones, and a missed root only means a stray album title, never a
 * lost photo.
 */
const YEAR_FOLDER = /^(?:photos from )?(?:19|20)\d{2}$/u;
const STRUCTURAL_FOLDERS: ReadonlySet<string> = new Set([
  "takeout",
  "google photos",
]);

/**
 * The shortest sidecar stem we will accept as a TRUNCATED match for a longer
 * media name. Takeout's historical truncation lands around 46–51 characters,
 * so a prefix this long is overwhelmingly more likely to be one truncated
 * name than two different photos sharing an opening. Below it, a prefix match
 * is a coincidence and we would rather have no sidecar than the wrong one.
 */
const MIN_TRUNCATED_STEM = 40;

/** Takeout writes "0" for an unknown capture time — not the epoch. */
const MIN_EPOCH_S = 1;
/** The year-3000 ceiling `isoTime()` uses in blob/media-metadata.ts. */
const MAX_EPOCH_S = 32_503_680_000;

/** What one sidecar asserts. Every field is nullable: absence is a fact. */
export interface SidecarFacts {
  /** `photoTakenTime.timestamp`, as an ISO-8601 UTC instant. */
  capturedAt: string | null;
  latitude: number | null;
  longitude: number | null;
  /** `description` — the caption the owner typed in Google Photos. */
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

/** One media entry with everything the archive says about it. */
export interface TakeoutMediaEntry {
  /** Archive-relative, slash-normalised — the stable external id. */
  path: string;
  sidecarPath: string | null;
  sidecar: SidecarFacts;
  /** Reconstructed album title; null for year folders and the archive root. */
  album: string | null;
  /** Live-Photo pairing key; null when nothing in the archive pairs with it. */
  captureGroupId: string | null;
}

export interface TakeoutPlan {
  media: TakeoutMediaEntry[];
  /** Entries consumed AS metadata — reported neither as media nor unrouted. */
  metadata: ReadonlySet<string>;
}

/** Archive-relative path, slash-normalised. Zip names are already safe. */
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

/** True when this entry is library media by extension. */
export function isMediaPath(path: string): boolean {
  return MEDIA_EXTENSIONS.has(extensionOf(path));
}

function isoFromEpochSeconds(raw: unknown): string | null {
  // Takeout writes epoch SECONDS as a decimal string. "0", a missing field
  // and an absurd value are all the same answer — we do not know when this
  // was taken — and NULL is how the vault says that. Never 1970.
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
 * `geoData` coordinates, or null.
 *
 * EXACT (0, 0) MEANS ABSENT. Takeout fills `latitude`/`longitude` with `0.0`
 * for every photo that carries no location, so taking the zeros literally
 * would pin a decade of someone's library to Null Island in the Gulf of
 * Guinea. A genuine photograph taken within a metre of 0°N 0°E loses its
 * coordinates here; that is the trade, and it is the right way round.
 *
 * `geoDataExif` is deliberately ignored: it is a copy of the EXIF the spool
 * pipeline already reads off the bytes itself, so it would add a second,
 * staler path to the same fact.
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

/** Parse one sidecar document. Anything unreadable yields no facts. */
export function parseTakeoutSidecar(text: string): SidecarFacts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Recovery, not a swallow: a corrupt sidecar must not fail its photo.
    // The photo imports on its own EXIF, which is what it would have done
    // had Google never written the sidecar at all.
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
 * Sidecar names to try for one media file, most-certain first. Each entry is
 * one of Google's shipped conventions:
 *
 *  1. `IMG_1234.HEIC.json` — the classic form.
 *  2. `IMG_1234.HEIC.supplemental-metadata.json` and its siblings — matched
 *     by prefix below rather than enumerated, because Google keeps inventing
 *     the suffix.
 *  3. `IMG_1234(1).HEIC` → `IMG_1234.HEIC(1).json` — the duplicate marker
 *     moves from the middle of the media name to the END of the sidecar name.
 *  4. `IMG_1234-edited.jpg` shares `IMG_1234.jpg.json` — an edit made inside
 *     Google Photos ships as a second image with NO sidecar of its own.
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

/** Resolve one media file's sidecar within its own directory. */
function resolveSidecar(
  fileName: string,
  siblings: Map<string, string>
): string | null {
  const stems = sidecarStems(fileName);
  for (const stem of stems) {
    const exact = siblings.get(stem);
    if (exact) return exact;
  }
  // The `.supplemental-metadata` family: any sidecar whose stem extends one
  // of ours by a dotted suffix. Shortest wins so `IMG.jpg.json` beats
  // `IMG.jpg.supplemental-metadata.json` only when both somehow exist.
  let best: { stem: string; path: string } | null = null;
  for (const [stem, path] of siblings) {
    if (!stems.some((candidate) => stem.startsWith(`${candidate}.`))) continue;
    if (best === null || stem.length < best.stem.length) best = { stem, path };
  }
  if (best) return best.path;
  // Truncation, last: the sidecar's stem is a PREFIX of the media name
  // because Google cut the long one short. Longest prefix wins, and only
  // above MIN_TRUNCATED_STEM — below that a shared opening is a coincidence.
  for (const [stem, path] of siblings) {
    if (stem.length < MIN_TRUNCATED_STEM) continue;
    if (!fileName.startsWith(stem)) continue;
    if (best === null || stem.length > best.stem.length) best = { stem, path };
  }
  return best?.path ?? null;
}

/**
 * The pairing key for a Live Photo / motion photo: the file name with its
 * extension, a `(n)` duplicate marker and an `-edited` suffix removed, so
 * `IMG_1234.HEIC`, `IMG_1234.MP4` and `IMG_1234-edited.HEIC` all name the
 * same moment. Scoped to the directory, since two albums may each hold an
 * `IMG_1234` and they are not the same shutter click.
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
 * Album title for a media entry's directory, or null.
 *
 * The folder IS the album — that is the only structure Takeout gives us —
 * minus the two exclusions above. A per-folder `metadata.json` carries the
 * title the owner actually typed (it survives renames and non-ASCII the
 * filesystem mangled), so it wins when present; its ABSENCE is deliberately
 * not disqualifying, because older exports shipped albums without one and
 * dropping those albums would lose real curation to fix a cosmetic risk.
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
    // Same recovery as a photo's own sidecar: the folder name still names
    // the album, so an unreadable metadata.json costs a nicety, not a row.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const title = (parsed as Record<string, unknown>).title;
  return typeof title === "string" && title.trim().length > 0
    ? title.trim()
    : null;
}

/**
 * Read an archive's entry list as a photo library: which entries are media,
 * what each one's sidecar says, which album it belongs to, and which entries
 * pair into one capture.
 */
export function planTakeout(
  entries: readonly { name: string; data: Buffer }[]
): TakeoutPlan {
  const metadata = new Set<string>();
  const folderTitles = new Map<string, string>();
  const sidecarBytes = new Map<string, Buffer>();
  // Per-directory sidecar index: stem (the name minus `.json`) → path.
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
      // A per-folder album record — consumed whether or not it parses, so a
      // malformed one is not reported to the owner as an unimported file.
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

  // A capture group only exists where an image and a video share a key —
  // one lone `.MOV` in a folder is a video, not half a Live Photo.
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
      // Derived from the archive-relative key alone, so re-importing the same
      // archive — or the next export of the same library — derives the same
      // id and `media.add_asset`'s COALESCE merge completes a half-done pair.
      captureGroupId: paired ? `takeout:${sha256Hex(key).slice(0, 32)}` : null,
    } satisfies TakeoutMediaEntry;
  });

  return { media, metadata };
}
