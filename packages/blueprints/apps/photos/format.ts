import { fmtBytes, localDayKey } from "@centraid/design/elements";

import {
  fmtDay as sharedFmtDay,
  mediaClock as clock,
} from "../_shared/format-kit.ts";
import type { Asset, ExifRow } from "./types.ts";

export function dayKey(iso: string | number | Date | null | undefined): string {
  return iso ? localDayKey(iso) : "";
}

export function fmtDay(key: string): string {
  return sharedFmtDay(key, {
    absolute: { day: "numeric", month: "short", weekday: "short" },
    undated: "Undated",
  });
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

export { mediaClock as clock } from "../_shared/format-kit.ts";

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
  }
  if (asset.width && asset.height) {
    rows.push({
      label: "Dimensions",
      value: `${asset.width} × ${asset.height}`,
    });
  }
  if (Number.isFinite(Number(asset.duration_s))) {
    rows.push({ label: "Duration", value: clock(Number(asset.duration_s)) });
  }
  const size = fmtBytes(assetBytes(asset));
  if (size) rows.push({ label: "File size", value: size });
  const captured = asset.captured_at ?? asset.taken_at;
  if (captured) {
    const d = new Date(captured);
    if (!Number.isNaN(d.getTime())) {
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

export { custodyMeta } from "../_shared/format-kit.ts";

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
