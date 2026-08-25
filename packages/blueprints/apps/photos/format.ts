// Pure formatting/predicate helpers over an asset row — no DOM, IO or state.
import { fmtBytes, localDayKey } from "@centraid/design/elements";

import type { Asset, CustodyMeta, ExifRow } from "./types.ts";

export function dayKey(iso: string | number | Date | null | undefined): string {
  // Local wall clock, never the UTC slice: an evening photo is not tomorrow's.
  return iso ? localDayKey(iso) : "";
}

export function fmtDay(key: string): string {
  if (!key) return "Undated";
  if (key === localDayKey(new Date())) return "Today";
  if (key === localDayKey(new Date(Date.now() - 86400000))) return "Yesterday";
  try {
    return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return key;
  }
}

export function fmtMonth(key: string): string {
  if (!key) return "Undated";
  try {
    return new Date(`${key}-01T00:00:00`).toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });
  } catch {
    return key;
  }
}

export function toLocalInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function assetBytes(asset: Asset): number | null {
  const recorded = asset.byte_size ?? asset.bytes ?? asset.size_bytes;
  if (typeof recorded === "number") return recorded;
  const uri = asset.content_uri;
  if (typeof uri === "string" && uri.startsWith("data:")) {
    const comma = uri.indexOf(",");
    if (comma > 0 && uri.slice(0, comma).includes("base64")) {
      return Math.round(((uri.length - comma - 1) * 3) / 4);
    }
  }
  return null;
}

// A key this vault never writes simply renders no row, so unpopulated camera
// fields are safe to list here.
const EXIF_LABELS: Record<string, string> = {
  make: "Camera make",
  model: "Camera model",
  lens: "Lens",
  iso: "ISO",
  f_number: "Aperture",
  aperture: "Aperture",
  exposure_time: "Shutter",
  shutter_speed: "Shutter",
  focal_length: "Focal length",
  codec: "Codec",
  title: "Embedded title",
  artist: "Artist",
};

/** Empty when nothing is known; the panel owns that copy. */
export function exifRows(asset: Asset): ExifRow[] {
  const rows: ExifRow[] = [];
  let exif: Record<string, unknown> | null = null;
  if (typeof asset.exif_json === "string") {
    try {
      exif = JSON.parse(asset.exif_json) as Record<string, unknown> | null;
    } catch {
      exif = null;
    }
  } else if (asset.exif_json && typeof asset.exif_json === "object") {
    exif = asset.exif_json;
  }
  if (exif) {
    const camera = [exif.make, exif.model].filter(Boolean).join(" ");
    if (camera) rows.push({ label: "Camera", value: camera });
    const aperture = exif.f_number ?? exif.aperture;
    const shutter = exif.exposure_time ?? exif.shutter_speed;
    const exposure = [
      exif.iso == null ? null : `ISO ${exif.iso}`,
      aperture == null ? null : `ƒ/${aperture}`,
      shutter ?? null,
      exif.focal_length == null ? null : `${exif.focal_length}mm`,
    ]
      .filter(Boolean)
      .join(" · ");
    if (exposure) rows.push({ label: "Exposure", value: exposure });
    const FOLDED = new Set([
      "make",
      "model",
      "iso",
      "f_number",
      "aperture",
      "exposure_time",
      "shutter_speed",
      "focal_length",
    ]);
    for (const [key, label] of Object.entries(EXIF_LABELS)) {
      if (FOLDED.has(key)) continue;
      if (exif[key] != null) rows.push({ label, value: String(exif[key]) });
    }
    // NO location row, ever: a place is a phrase (`place-phrase.ts`), and
    // coordinates never go to a map host to answer what the device can.
  }
  if (asset.width && asset.height) {
    rows.push({
      label: "Dimensions",
      value: `${asset.width} × ${asset.height}`,
    });
  }
  if (Number.isFinite(Number(asset.duration_s))) {
    const seconds = Math.round(Number(asset.duration_s));
    const minutes = Math.floor(seconds / 60);
    rows.push({
      label: "Duration",
      value: `${minutes}:${String(seconds % 60).padStart(2, "0")}`,
    });
  }
  const size = fmtBytes(assetBytes(asset));
  if (size) rows.push({ label: "File size", value: size });
  const captured = asset.captured_at ?? asset.taken_at;
  if (captured) {
    const d = new Date(captured);
    if (!Number.isNaN(d.getTime())) {
      // `dateStyle`/`timeStyle` cannot be mixed with `weekday` — Intl throws.
      rows.push({
        label: "Captured",
        value: d.toLocaleString(undefined, {
          dateStyle: "full",
          timeStyle: "short",
        }),
      });
    }
  }
  if (asset.media_type) rows.push({ label: "Type", value: asset.media_type });
  return rows;
}

// The blob custody projection in owner-facing words plus a tone the CSS keys
// off. A custody-less row gets null, and the caller draws nothing.
const CUSTODY_META: Record<string, CustodyMeta> = {
  "local-only": { label: "On this device only", tone: "warn" },
  // "warn", not "ok": a queued copy is not a copy.
  "pending-offsite": { label: "Copy queued, not finished", tone: "warn" },
  replicated: { label: "Backed up", tone: "ok" },
  "remote-only": { label: "Only in the cloud", tone: "warn" },
  missing: { label: "Missing — needs attention", tone: "danger" },
};

export function custodyMeta(
  state: string | null | undefined
): CustodyMeta | null {
  return CUSTODY_META[state ?? ""] ?? null;
}

export function isVideoAsset(asset: Asset): boolean {
  const uri = asset.content_uri;
  if (typeof uri === "string" && uri.startsWith("data:video")) return true;
  return (
    asset.kind === "video" ||
    String(asset.media_type ?? "").startsWith("video/")
  );
}

export function isAudioAsset(asset: Asset): boolean {
  const uri = asset.content_uri;
  if (typeof uri === "string" && uri.startsWith("data:audio")) return true;
  return (
    asset.kind === "audio" ||
    String(asset.media_type ?? "").startsWith("audio/")
  );
}

export const cls = (
  ...parts: Array<string | false | null | undefined>
): string => parts.filter(Boolean).join(" ");
