// One document's read surface (#821). The kind fork lives on the shared model
// (`format.ts`) so phone and web agree. No react/react-native imports.

import {
  canRender,
  fmtBytes,
  isTextKind,
  typeMeta,
} from "@centraid/blueprints/apps/docs/format";
import type { DocFields } from "@centraid/blueprints/apps/docs/types";

export type ReadSurface = "reading" | "stage" | "facts";

export function readSurfaceFor(doc: DocFields): ReadSurface {
  if (isTextKind(doc)) return "reading";
  if (canRender(doc)) return "stage";
  return "facts";
}

// ─── inline data: bodies ─────
// Hermes ships neither `atob` nor a guaranteed TextDecoder, so decode by hand.

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Bytes(payload: string): number[] | null {
  const clean = payload.replace(/[=\s]+$/u, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE64_ALPHABET.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes;
}

export function decodeTextDataUri(
  uri: string | null | undefined
): string | null {
  const s = String(uri ?? "");
  if (!s.startsWith("data:")) return null;
  const comma = s.indexOf(",");
  if (comma < 0) return null;
  const meta = s.slice(0, comma);
  const payload = s.slice(comma + 1);
  try {
    if (!meta.includes(";base64")) return decodeURIComponent(payload);
    const bytes = base64Bytes(payload);
    if (bytes === null) return null;
    return decodeURIComponent(
      bytes.map((b) => `%${b.toString(16).padStart(2, "0")}`).join("")
    );
  } catch {
    return null;
  }
}

export function docBytesUrl(
  doc: { content_id: string; content_uri?: string | null },
  gatewayBase: string | undefined,
  vaultId: string | undefined
): string | null {
  if (String(doc.content_uri ?? "").startsWith("data:")) return null;
  if (!gatewayBase || !vaultId) return null;
  return `${gatewayBase}/centraid/_gateway/blobs/${encodeURIComponent(
    vaultId
  )}/${encodeURIComponent(doc.content_id)}`;
}

// Nothing records an opening — no clause may claim who has opened a document.

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Empty when the stamp is unreadable — an absent clause, never an invented one. */
export function editedAgo(iso: string, now: number = Date.now()): string {
  const stamp = Date.parse(iso);
  if (Number.isNaN(stamp)) return "";
  const delta = Math.max(0, now - stamp);
  if (delta < MINUTE_MS) return "edited moments ago";
  if (delta < HOUR_MS) {
    const minutes = Math.floor(delta / MINUTE_MS);
    return `edited ${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  }
  if (delta < DAY_MS) {
    const hours = Math.floor(delta / HOUR_MS);
    return `edited ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  const days = Math.floor(delta / DAY_MS);
  if (days === 1) return "edited yesterday";
  return `edited ${days} days ago`;
}

export function readStatus(
  versionCount: number | null,
  updatedAt: string,
  now: number = Date.now()
): string {
  const ago = editedAgo(updatedAt, now);
  const clauses = [
    ...(versionCount !== null && versionCount > 0
      ? [`Version ${versionCount}`]
      : []),
    ...(ago ? [ago] : []),
  ];
  return clauses.join(" · ");
}

export interface FactRow {
  key: string;
  value: string;
  /** Drawn in the `net` tone. */
  net?: boolean;
}

/** "Open elsewhere" is a control beside these rows, not a row. */
export function factsRows(
  doc: DocFields & { byte_size?: number | null; custody_state?: string | null },
  custodyLabel: string | null
): FactRow[] {
  const kind = typeMeta(doc.media_type, doc.title);
  return [
    { key: "Kind", value: kind.name },
    { key: "Size", value: fmtBytes(doc.byte_size) },
    {
      key: "Where the bytes are",
      value: custodyLabel ?? "not swept yet",
      ...(doc.custody_state === "missing" ? { net: true } : {}),
    },
    {
      key: "What Docs does",
      value:
        "Holds, versions and files it — rename, move, star and trash all work on this kind",
    },
    {
      key: "What Docs will not do",
      value: `Docs cannot render ${kind.name} and converts nothing — a lossy copy would be a different document.`,
      net: true,
    },
  ];
}
