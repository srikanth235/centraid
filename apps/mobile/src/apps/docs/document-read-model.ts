// One document's read surface, as facts (Docs handoff Part 2 §6–§8;
// #821).
//
// `DocumentRead` is ONE route that forks by kind — "the fork is a fact about
// the document, not two places" (navigation.ts). The fork itself lives here,
// pure and testable, on the shared kind model (`format.ts`), so the phone and
// the web cannot disagree about which kinds read as text, which stand on the
// stage, and which get the facts panel:
//
//   * `reading` — text kinds (`isTextKind`, the vault's own edit precondition):
//     real prose at the reading measure.
//   * `stage`  — kinds Docs can render but not set (PDF, image, audio, video):
//     the dark stage, a mode with its own exit.
//   * `facts`  — kinds Docs cannot set OR show (Word, spreadsheet, deck,
//     unknown): "the facts panel is the answer, not a lossy converter."
//
// Also here: the RN-safe text decode for inline `data:` bodies (format.ts's
// own `decodeDataUri` reaches for `atob`, which Hermes does not have — see
// INTEGRATION-NOTES.md), and the gateway byte route for everything else.
//
// Deliberately free of react and react-native imports.

import {
  canRender,
  fmtBytes,
  isTextKind,
  typeMeta,
} from "@centraid/blueprints/apps/docs/format";
import type { DocFields } from "@centraid/blueprints/apps/docs/types";

export type ReadSurface = "reading" | "stage" | "facts";

/** Which of the three read surfaces this document gets — see the header. */
export function readSurfaceFor(doc: DocFields): ReadSurface {
  if (isTextKind(doc)) return "reading";
  if (canRender(doc)) return "stage";
  return "facts";
}

// ───────────────────────────────────────────────────────────────────────────
// Inline text bodies, decoded without `atob` (Hermes ships neither `atob`
// nor a guaranteed TextDecoder). The vault mints text content as
// `data:text/…;charset=utf-8,` + encodeURIComponent (blob/mint.ts), so the
// percent path is the real one; the base64 branch exists for foreign data
// URIs and decodes through percent-escapes so multi-byte UTF-8 survives.
// ───────────────────────────────────────────────────────────────────────────

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

/** The text payload of a `data:` URI, or `null` when there is none to have. */
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
    // UTF-8 via percent-escapes: portable where TextDecoder is not.
    return decodeURIComponent(
      bytes.map((b) => `%${b.toString(16).padStart(2, "0")}`).join("")
    );
  } catch {
    return null;
  }
}

/**
 * Where this document's bytes can be fetched from — the gateway's blob route,
 * the same one Photos reads originals through (timeline-engine.ts). `null`
 * when the bytes ride inline (`data:`) or the seat has no gateway to ask.
 */
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

// ───────────────────────────────────────────────────────────────────────────
// The reading view's status sentence (§6): `Version 7 · edited two hours ago`.
// The sample's third clause — "only you have opened this" — is WITHHELD:
// nothing in this product records an opening (that is a design boundary, not
// a gap), so no surface may claim to know who has.
// ───────────────────────────────────────────────────────────────────────────

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** `edited two hours ago`, in words a byline can carry. Empty when the stamp
 *  is unreadable — an absent clause, never an invented one. */
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

/** `Version 7 · edited two hours ago` — the version clause only when a real
 *  chain count exists (the replica's `core.link` walk), never a guess. */
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

// ───────────────────────────────────────────────────────────────────────────
// The facts panel (§7) — every row a replica fact, and the two rows the
// phone cannot fill are absent with the absence explained by the screen.
// ───────────────────────────────────────────────────────────────────────────

export interface FactRow {
  key: string;
  value: string;
  /** A consequence, drawn in the `net` tone. */
  net?: boolean;
}

/**
 * What the facts panel says about a kind Docs cannot set: the kind, the
 * size, where the bytes are, and what can and cannot be done. "Open
 * elsewhere" is a control beside these, not a row.
 */
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
