import { sha256Hex } from "../ids.js";

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

const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  "mp4",
  "mov",
  "m4v",
  "webm",
  "avi",
]);

const YEAR_FOLDER = /^(?:photos from )?(?:19|20)\d{2}$/u;
const STRUCTURAL_FOLDERS: ReadonlySet<string> = new Set([
  "takeout",
  "google photos",
]);

const MIN_TRUNCATED_STEM = 40;

const MIN_EPOCH_S = 1;
const MAX_EPOCH_S = 32_503_680_000;

export interface SidecarFacts {
  capturedAt: string | null;
  latitude: number | null;
  longitude: number | null;
  caption: string | null;
  favorite: boolean;
}

export const NO_SIDECAR_FACTS: SidecarFacts = {
  capturedAt: null,
  latitude: null,
  longitude: null,
  caption: null,
  favorite: false,
};

export interface TakeoutMediaEntry {
  path: string;
  sidecarPath: string | null;
  sidecar: SidecarFacts;
  album: string | null;
  captureGroupId: string | null;
}

export interface TakeoutPlan {
  media: TakeoutMediaEntry[];
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

export function parseTakeoutSidecar(text: string): SidecarFacts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
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
  let best: { stem: string; path: string } | null = null;
  for (const [stem, path] of siblings) {
    if (!stems.some((candidate) => stem.startsWith(`${candidate}.`))) continue;
    if (best === null || stem.length < best.stem.length) best = { stem, path };
  }
  if (best) return best.path;
  for (const [stem, path] of siblings) {
    if (stem.length < MIN_TRUNCATED_STEM) continue;
    if (!fileName.startsWith(stem)) continue;
    if (best === null || stem.length > best.stem.length) best = { stem, path };
  }
  return best?.path ?? null;
}

function pairingKey(path: string): string {
  const fileName = fileNameOf(path);
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return `${directoryOf(path)}/${stem
    .replace(/\(\d+\)$/u, "")
    .replace(/-edited$/u, "")
    .toLowerCase()}`;
}

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
      captureGroupId: paired ? `takeout:${sha256Hex(key).slice(0, 32)}` : null,
    } satisfies TakeoutMediaEntry;
  });

  return { media, metadata };
}
