import { formatBytes } from "@centraid/design";

import { custodyMeta, decodeDataUri } from "../_shared/format-kit.ts";
import { safeDocumentUrl } from "../_shared/untrusted.ts";
import type { CustodyInfo, DocFields, TypeMeta } from "./types.ts";

// The drive's trash clock, the custody table and the inline-prose decoder are
// the format kit's (#883 B4), re-exported so each seat has one import path.
export {
  custodyMeta,
  decodeDataUri,
  purgeCountdown,
} from "../_shared/format-kit.ts";

// Token-layer `formatBytes`: Metro pulls this into the phone bundle, and
// `@centraid/design/elements` is DOM-only.
export const fmtBytes = (n: number | null | undefined): string =>
  !n || !Number.isFinite(Number(n)) || n < 0 ? "—" : formatBytes(n);

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const m = d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    return d.getFullYear() === new Date().getFullYear()
      ? m
      : `${m}, ${d.getFullYear()}`;
  } catch {
    return String(iso).slice(0, 10);
  }
}

export function fmtFull(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return String(iso).slice(0, 10);
  }
}

/** Four glyphs across eight kinds — eight lookalike outlines make the row's leading edge harder to scan. */
const KINDS = {
  pdf: {
    label: "PDF",
    name: "PDF",
    cat: "pdf",
    cv: "--kind-pdf",
    glyph: "doc",
  },
  image: {
    label: "IMG",
    name: "Image",
    cat: "image",
    cv: "--kind-image",
    glyph: "image",
  },
  video: {
    label: "VID",
    name: "Video",
    cat: "media",
    cv: "--kind-media",
    glyph: "media",
  },
  audio: {
    label: "AUD",
    name: "Audio",
    cat: "media",
    cv: "--kind-media",
    glyph: "media",
  },
  sheet: {
    label: "XLS",
    name: "Spreadsheet",
    cat: "sheet",
    cv: "--kind-sheet",
    glyph: "sheet",
  },
  slide: {
    label: "PPT",
    name: "Presentation",
    cat: "slide",
    cv: "--kind-slide",
    glyph: "sheet", // deck is a TOC, not a page
  },
  doc: {
    label: "DOC",
    name: "Document",
    cat: "doc",
    cv: "--kind-doc",
    glyph: "doc",
  },
  other: {
    label: "FILE",
    name: "File",
    cat: "other",
    cv: "--text-faint",
    glyph: "other",
  },
} as const satisfies Record<string, TypeMeta>;

type KindId = keyof typeof KINDS;

function kindFromMediaType(t: string): KindId | null {
  if (t === "application/pdf") return "pdf";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  if (t.startsWith("image/")) return "image";
  if (
    t.includes("spreadsheet") ||
    t === "application/vnd.ms-excel" ||
    t === "text/csv" ||
    t === "application/vnd.oasis.opendocument.spreadsheet"
  )
    return "sheet";
  if (
    t.includes("presentation") ||
    t === "application/vnd.ms-powerpoint" ||
    t === "application/vnd.oasis.opendocument.presentation"
  )
    return "slide";
  if (
    t.includes("word") ||
    t === "application/msword" ||
    t === "application/vnd.oasis.opendocument.text" ||
    t === "application/rtf" ||
    t.startsWith("text/")
  )
    return "doc";
  return null;
}

/** Fallback when media type is silent: Office files sniff as ZIP/`octet-stream`. */
const KIND_BY_EXTENSION: Readonly<Record<string, KindId>> = {
  pdf: "pdf",
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  heic: "image",
  heif: "image",
  tif: "image",
  tiff: "image",
  bmp: "image",
  svg: "image",
  mp4: "video",
  mov: "video",
  m4v: "video",
  webm: "video",
  avi: "video",
  mkv: "video",
  mp3: "audio",
  m4a: "audio",
  wav: "audio",
  aac: "audio",
  flac: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  xlsx: "sheet",
  xls: "sheet",
  xlsm: "sheet",
  ods: "sheet",
  csv: "sheet",
  tsv: "sheet",
  numbers: "sheet",
  pptx: "slide",
  ppt: "slide",
  odp: "slide",
  key: "slide",
  docx: "doc",
  doc: "doc",
  odt: "doc",
  rtf: "doc",
  pages: "doc",
  md: "doc",
  markdown: "doc",
  txt: "doc",
  text: "doc",
  log: "doc",
  json: "doc",
  xml: "doc",
};

function kindFromName(name: string): KindId | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot >= name.length - 1) return null;
  return KIND_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** Media type first, filename second — never reverse. */
export function typeMeta(
  mediaType: string | null | undefined,
  name?: string | null
): TypeMeta {
  const t = String(mediaType ?? "").toLowerCase();
  const kind =
    kindFromMediaType(t) ?? kindFromName(String(name ?? "")) ?? "other";
  return KINDS[kind];
}

// Lockstep with edit_document (`media_type LIKE 'text/%'`). Else Replace-file.
export function isTextKind(doc: DocFields): boolean {
  return /^text\//iu.test(String(doc.media_type ?? ""));
}

/** Inline `data:` prose (#296). Null for non-text or `blob:` (editor owns that fetch). */
export function inlineText(doc: DocFields): string | null {
  if (!isTextKind(doc)) return null;
  const text = decodeDataUri(doc.content_uri);
  return text && text.trim() ? text : null;
}

/** Not a markdown renderer: 104px thumbnail has no room for structure. */
export function textExcerpt(body: string, max = 220): string {
  const plain = body
    .replace(/^---\n[\s\S]*?\n---\n/u, "")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[(?<label>[^\]]*)\]\([^)]*\)/gu, "$<label>")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s{0,3}>\s?/gmu, "")
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gmu, "")
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gmu, " ")
    .replace(/[*_~`]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max).trimEnd()}…` : plain;
}

export function loadable(uri: string | null | undefined): boolean {
  return safeDocumentUrl(uri) !== null;
}
export function isImage(doc: DocFields): boolean {
  return (
    String(doc.media_type ?? "").startsWith("image/") &&
    loadable(doc.content_uri)
  );
}
export function isVideo(doc: DocFields): boolean {
  return (
    String(doc.media_type ?? "").startsWith("video/") &&
    loadable(doc.content_uri)
  );
}
export function isAudio(doc: DocFields): boolean {
  return (
    String(doc.media_type ?? "").startsWith("audio/") &&
    loadable(doc.content_uri)
  );
}
export function isMedia(doc: DocFields): boolean {
  return isVideo(doc) || isAudio(doc);
}

/** Showable (§10.1)? Key off `typeMeta` category — never a second media-type table. */
export function canRender(doc: DocFields): boolean {
  const { cat } = typeMeta(doc.media_type, doc.title);
  if (cat === "sheet" || cat === "slide") return false;
  if (cat !== "doc") return cat !== "other";
  // `doc` = text (render) and binary word-processor (not).
  return String(doc.media_type ?? "").startsWith("text/");
}
/** Fill sibling of the text rung. `cv` is a solved TEXT shade — filling with it eats contrast. */
export function fillVar(cv: string): string {
  return `${cv}-fill`;
}

/** Fill rung, never the text one — a label painted `var(cv)` keeps its measured ratio. */
export function tintBg(cv: string, pct: number): string {
  return `color-mix(in oklab, var(${fillVar(cv)}) ${pct}%, transparent)`;
}

// No empty-state copy here — it lives in view-copy/view-state/EmptyState.

// Row mark for exceptions only: `local-only` (loss) and `missing` (integrity).
// Norms get nothing.
const CUSTODY_ROW_EXCEPTIONS: ReadonlySet<string> = new Set([
  "local-only",
  "missing",
]);

export function custodyRowMark(
  state: string | null | undefined
): CustodyInfo | null {
  if (!state || !CUSTODY_ROW_EXCEPTIONS.has(state)) return null;
  return custodyMeta(state);
}

const ACTIVITY_LABELS: Record<string, string> = {
  "command.core.add_document": "Uploaded",
  "command.core.rename_document": "Renamed",
  "command.core.move_document": "Moved to a different folder",
  "command.core.trash_document": "Moved to trash",
  "command.core.restore_document": "Restored from trash",
  "command.core.star_document": "Starred",
  "command.core.unstar_document": "Star removed",
  "command.core.edit_document": "Edited",
  "command.core.replace_document_content": "Replaced with a new file",
  "command.core.restore_document_version": "Restored an earlier version",
};

export function activityLabel(activity: string | null | undefined): string {
  const known = activity ? ACTIVITY_LABELS[activity] : undefined;
  if (known) return known;
  const cleaned = String(activity ?? "")
    .replace(/^command\.core\./u, "")
    .replace(/_/gu, " ")
    .trim();
  return cleaned || "Activity";
}

const AGENT_KIND_LABELS: Record<string, string> = {
  owner: "You",
  app: "This app",
  ai_agent: "An AI agent",
  import: "An import",
};

export function actorLabel(agentKind: string | null | undefined): string {
  return (agentKind ? AGENT_KIND_LABELS[agentKind] : undefined) ?? "Someone";
}

export function extOf(doc: DocFields): string {
  const t = String(doc.title ?? "");
  const dot = t.lastIndexOf(".");
  if (dot > 0 && dot < t.length - 1)
    return `.${t.slice(dot + 1).toLowerCase()}`;
  return typeMeta(doc.media_type, doc.title).label.toLowerCase();
}
