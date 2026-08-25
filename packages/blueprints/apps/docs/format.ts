// Formatting + file-type helpers. Pure functions of their arguments: none hold
// or mutate app state, so both the orchestrator and the row/details/quick-look
// components call them directly instead of threading them as props.
import { formatBytes } from "@centraid/design";

import { safeDocumentUrl } from "../_shared/untrusted.ts";
import type { CustodyInfo, DocFields, TypeMeta } from "./types.ts";

// Token-layer `formatBytes`, never `@centraid/design/elements`: Metro pulls this
// file into the phone bundle and the elements subpath is DOM-only.
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

export function purgeCountdown(iso: string | null | undefined): string {
  if (!iso) return "";
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
  if (Number.isNaN(days)) return "";
  if (days <= 0) return "purges today";
  if (days === 1) return "purges tomorrow";
  return `purges in ${days} days`;
}

/**
 * THE KIND TABLE: one entry per kind, each carrying the shape it wears.
 *
 * FOUR SHAPES ACROSS EIGHT KINDS, deliberately. A member is being told "page",
 * "picture", "table", "plays"; the exact format is the Kind column's job one
 * field to the right, and eight lookalike outlines would make the row's leading
 * edge harder to scan, not easier.
 */
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
    // A deck is a table of contents more than a page.
    glyph: "sheet",
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

/** What the MEDIA TYPE says, when it says anything. */
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

/**
 * WHAT THE FILENAME SAYS, whenever the media type says nothing. Not
 * belt-and-braces: an Office file is a ZIP container, so a gateway that sniffs
 * bytes stores `application/octet-stream` for every `.xlsx`/`.docx`/`.pptx`.
 * The extension is the member's own statement, and the only one on hand.
 */
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

/**
 * `name` is the KIND'S OWN WORD, a noun a member would use — "PDF", not "PDF
 * document": the subject is already known to be a document, and the column has
 * 96px.
 *
 * The MEDIA TYPE is asked first and the FILENAME second, never the reverse: a
 * stored type is what the vault knows, an extension is what somebody typed.
 */
export function typeMeta(
  mediaType: string | null | undefined,
  /** Pass it wherever there is one. */
  name?: string | null
): TypeMeta {
  const t = String(mediaType ?? "").toLowerCase();
  const kind =
    kindFromMediaType(t) ?? kindFromName(String(name ?? "")) ?? "other";
  return KINDS[kind];
}

// The vault's own edit_document precondition (media_type LIKE 'text/%'), kept
// in exact lockstep so Edit only shows where the command would accept it.
// Anything else takes the Replace-file door.
export function isTextKind(doc: DocFields): boolean {
  return /^text\//iu.test(String(doc.media_type ?? ""));
}

// THE ONLY DOOR, not an optimization: `fetch()`-ing a `data:` URI is blocked by
// the app's CSP (`connect-src` inherits `default-src 'self'`; only `img-src`
// allows `data:`), and small text bodies never rewrite to a blob route (#296).
// UTF-8 safe — base64 decodes through TextDecoder, never `atob()` alone.
export function decodeDataUri(uri: string | null | undefined): string | null {
  const s = String(uri ?? "");
  if (!s.startsWith("data:")) return null;
  const comma = s.indexOf(",");
  if (comma < 0) return null;
  const meta = s.slice(0, comma);
  const payload = s.slice(comma + 1);
  try {
    if (meta.includes(";base64")) {
      const binary = atob(payload);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      return new TextDecoder("utf-8").decode(bytes);
    }
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

/**
 * The document's OWN prose, when the bytes are already in hand: a small text
 * body rides on `content_uri` as a `data:` URI (#296), so reading it costs no
 * round trip and no consent beyond the read that produced the row. Null for a
 * non-text document, and for one behind a `blob:` route — that needs an async
 * fetch the editor owns.
 */
export function inlineText(doc: DocFields): string | null {
  if (!isTextKind(doc)) return null;
  const text = decodeDataUri(doc.content_uri);
  return text && text.trim() ? text : null;
}

/**
 * Deliberately NOT a markdown renderer: a 104px thumbnail has no room for
 * structure, and half-rendered structure is worse than none.
 */
export function textExcerpt(body: string, max = 220): string {
  const plain = body
    .replace(/^---\n[\s\S]*?\n---\n/u, "") // YAML front matter
    .replace(/```[\s\S]*?```/gu, " ") // fenced code
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ") // images
    .replace(/\[(?<label>[^\]]*)\]\([^)]*\)/gu, "$<label>") // links → their text
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "") // ATX headings
    .replace(/^\s{0,3}>\s?/gmu, "") // block quotes
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gmu, "") // list markers
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gmu, " ") // thematic breaks
    .replace(/[*_~`]/gu, "") // inline emphasis / code
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

/**
 * Can Docs SHOW this kind (§10.1)? A row that cannot says so BEFORE the member
 * taps it, and the rail answers what the viewer cannot.
 *
 * Keyed off `typeMeta`'s category, never a second media-type table: two tables
 * would eventually disagree, and the one that disagreed would be the one telling
 * a member their document is unopenable.
 */
export function canRender(doc: DocFields): boolean {
  const { cat } = typeMeta(doc.media_type, doc.title);
  if (cat === "sheet" || cat === "slide") return false;
  if (cat !== "doc") return cat !== "other";
  // `doc` holds both text kinds (render) and binary word-processor kinds (not).
  return String(doc.media_type ?? "").startsWith("text/");
}
/**
 * The FILL sibling of a kind's text rung. `cv` is the kind as TEXT — a solved
 * shade — so tinting a surface with it walks the background toward the
 * foreground and eats the contrast the solve bought. Fills read the raw palette
 * hue instead.
 */
export function fillVar(cv: string): string {
  return `${cv}-fill`;
}

/** Always from the FILL rung, never the text one, so a label painted `var(cv)`
 *  keeps its measured ratio on top of it. */
export function tintBg(cv: string, pct: number): string {
  return `color-mix(in oklab, var(${fillVar(cv)}) ${pct}%, transparent)`;
}

// NO EMPTY-STATE COPY LIVES HERE. §4.6's five distinguishable empty states live
// in `view-copy.ts`, `view-state.ts` and `components/EmptyState.tsx`; a cascade
// of nav/search/type combinations here would be a sixth answer, and would drag
// `AppState` into a pure module.

// The blob custody projection in owner-facing words plus a CSS tone; mirrors
// the photos app's custodyMeta exactly. Null for a custody-less row, so the
// caller renders nothing rather than claim a state the vault never asserted.
const CUSTODY_META: Record<string, CustodyInfo> = {
  "local-only": { label: "On this device only", tone: "warn" },
  replicated: { label: "Backed up", tone: "ok" },
  "remote-only": { label: "Only in the cloud", tone: "warn" },
  missing: { label: "Missing — needs attention", tone: "danger" },
};

export function custodyMeta(
  state: string | null | undefined
): CustodyInfo | null {
  return (state ? CUSTODY_META[state] : undefined) ?? null;
}

// Per-row altitude (docs/blueprint-seats.md "Byte custody vocabulary"): a row
// mark exists for the EXCEPTION only, never the norm. `replicated`,
// `remote-only` and the transient `pending-offsite` are where bytes are designed
// to live, so they get nothing. `local-only` is the one state a member can lose
// something to; `missing` is an integrity failure on NEITHER tier and actionable,
// so it keeps its dot. The full story stays in `custodyMeta` above.
const CUSTODY_ROW_EXCEPTIONS: ReadonlySet<string> = new Set([
  "local-only",
  "missing",
]);

export function custodyRowMark(
  state: string | null | undefined
): CustodyInfo | null {
  if (!state || !CUSTODY_ROW_EXCEPTIONS.has(state)) return null;
  return CUSTODY_META[state] ?? null;
}

// The owner-facing gloss for every command documents.ts registers
// (consent.provenance stamps `command.<name>`). An unrecognized activity still
// renders honestly — its raw name, cleaned up — instead of vanishing.
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

// `agent_kind` in the same owner/agent framing the app uses for who acted.
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
