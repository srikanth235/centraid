import { safeDocumentUrl } from "../_shared/untrusted.ts";
// Formatting + file-type helpers — pure functions of their arguments; none
// hold or mutate app state. Split out of app.tsx so both the
// orchestrator (currentRows' type filter, the upload size-skip message, the
// empty-row copy) and the row/details/quick-look components can call these
// directly instead of threading them all as props.
import { fmtBytes as fmtBytesBase } from "./kit.ts";
import type { CustodyInfo, DocFields, TypeMeta } from "./types.ts";

// The drive shows an em dash for absent sizes everywhere it prints bytes.
export const fmtBytes = (n: number | null | undefined): string =>
  fmtBytesBase(n, "—");

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

export function typeMeta(mediaType: string | null | undefined): TypeMeta {
  const t = String(mediaType ?? "").toLowerCase();
  if (t === "application/pdf")
    return { label: "PDF", name: "PDF document", cat: "pdf", cv: "--kind-pdf" };
  if (t.startsWith("video/"))
    return { label: "VID", name: "Video", cat: "media", cv: "--kind-media" };
  if (t.startsWith("audio/"))
    return { label: "AUD", name: "Audio", cat: "media", cv: "--kind-media" };
  if (t.startsWith("image/"))
    return { label: "IMG", name: "Image", cat: "image", cv: "--kind-image" };
  if (
    t.includes("spreadsheet") ||
    t === "application/vnd.ms-excel" ||
    t === "text/csv" ||
    t === "application/vnd.oasis.opendocument.spreadsheet"
  )
    return {
      label: "XLS",
      name: "Spreadsheet",
      cat: "sheet",
      cv: "--kind-sheet",
    };
  if (
    t.includes("presentation") ||
    t === "application/vnd.ms-powerpoint" ||
    t === "application/vnd.oasis.opendocument.presentation"
  )
    return {
      label: "PPT",
      name: "Presentation",
      cat: "slide",
      cv: "--kind-slide",
    };
  if (
    t.includes("word") ||
    t === "application/msword" ||
    t === "application/vnd.oasis.opendocument.text" ||
    t === "application/rtf" ||
    t.startsWith("text/")
  )
    return { label: "DOC", name: "Document", cat: "doc", cv: "--kind-doc" };
  return { label: "FILE", name: "File", cat: "other", cv: "--text-faint" };
}

// The vault's own edit_document precondition (media_type LIKE 'text/%',
// packages/vault/src/commands/documents.ts) — kept in exact lockstep so the
// Edit affordance only ever shows where the command would actually accept
// it. Anything else (including a scanned PDF or an image) takes the
// Replace-file door instead.
export function isTextEditable(doc: DocFields): boolean {
  return /^text\//iu.test(String(doc.media_type ?? ""));
}

// Decode a data: URI's text payload directly, without a network round trip.
// The in-place editor (components/Editor.tsx) needs this for any document
// whose bytes stayed inline (issue #296: small text bodies never rewrite to
// a blob: route) — `fetch()`-ing a data: URI is blocked by the app's own
// CSP (`connect-src` inherits `default-src 'self'`; only `img-src`
// explicitly allows `data:`, which is why an `<img src="data:...">` works
// but a fetch of the same URI does not), so this is the only door, not an
// optimization. UTF-8 safe: base64 payloads decode through a real
// TextDecoder rather than the classic (and multi-byte-unsafe) `atob()`
// alone.
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
 * The document's OWN prose, when the bytes are already in hand client-side.
 *
 * A small text body never rewrites to a blob route (issue #296), so it rides
 * along on `content_uri` as a `data:` URI — the same bytes the Download link
 * hands the owner. Reading it costs no round trip and no consent beyond the
 * read that produced the row, which is why the card and the quick look can
 * show the real document instead of a decorative mock of one. Returns null
 * for a non-text document, and for a text document whose bytes live behind a
 * `blob:` route (that needs an async fetch, which the editor owns).
 */
export function inlineText(doc: DocFields): string | null {
  if (!isTextEditable(doc)) return null;
  const text = decodeDataUri(doc.content_uri);
  return text && text.trim() ? text : null;
}

/**
 * A prose excerpt of a markdown/plain-text body: the syntax characters are
 * stripped so a card shows sentences rather than `## ` and `**`, and the
 * result is a single soft-wrapped paragraph the reading register can set.
 * Deliberately NOT a markdown renderer — a 104px thumbnail has no room for
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
 * Can Docs SHOW this kind at all (spec §10.1's `render` column)?
 *
 * "A kind is a fact about the bytes. Whether Docs can SET it is a separate
 * fact, and the facts panel exists for the difference." (§10.1 comment,
 * verbatim.) The three kinds it cannot show are Word, Spreadsheet and Deck —
 * so a row of one says "cannot be shown" BEFORE the member taps it, and the
 * rail answers what the viewer cannot.
 *
 * Keyed off `typeMeta`'s own category rather than a second media-type table:
 * two tables would eventually disagree, and the one that disagreed would be
 * the one telling a member their document is unopenable.
 */
export function canRender(doc: DocFields): boolean {
  const { cat } = typeMeta(doc.media_type);
  if (cat === "sheet" || cat === "slide") return false;
  if (cat !== "doc") return cat !== "other";
  // The `doc` category holds both text kinds (which render) and the binary
  // word-processor kinds (which do not).
  return String(doc.media_type ?? "").startsWith("text/");
}
/**
 * The FILL sibling of a kind's text rung (`--kind-pdf` → `--kind-pdf-fill`).
 *
 * `cv` is the kind as TEXT — a solved, deepened/lifted shade (see the two-rung
 * note in Chrome.module.css). Painting a decorative bar or a tint with it makes
 * the thumbnail read as a muddier version of its own label; worse, tinting a
 * surface with the ink that lands on it walks the background toward the
 * foreground and eats the contrast the solve just bought. Fills read the raw
 * palette hue instead, which is what the palette is for.
 */
export function fillVar(cv: string): string {
  return `${cv}-fill`;
}

/** A kind tint — always built from the FILL rung, never from the text one, so
 *  a label painted `var(cv)` keeps its measured ratio on top of it. */
export function tintBg(cv: string, pct: number): string {
  return `color-mix(in oklab, var(${fillVar(cv)}) ${pct}%, transparent)`;
}

// The row list's empty-state copy USED to live here as `emptyStateFor`: one
// flat cascade of nav/search/type combinations, rendered through `.kit-empty`.
// It is gone. §4.6 says there are exactly FIVE empty states and that they are
// distinguishable — a new drive, an empty folder, an empty shelf, a filter
// with no matches, a search with no matches — and only the first is a
// whole-screen state. That model lives in `view-copy.ts` (the copy),
// `view-state.ts` (which variant, and whether a read has even landed) and
// `components/EmptyState.tsx` (the block). Nothing here needed to know about
// `AppState` any more, which is why this module is pure again.

// The blob custody projection (issue #352 phase 4, blob/custody.ts) in
// owner-facing words + a tone the CSS keys off (custody-ok/custody-warn/
// custody-danger) — mirrors the photos app's own custodyMeta exactly.
// Returns null for a custody-less row (an inline `data:` document whose
// bytes never left vault.db, or the standing sweep hasn't run yet) — the
// caller renders nothing rather than claim a state the vault never
// asserted.
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

// Per-row altitude (docs/blueprint-seats.md "Byte custody vocabulary"): a
// row mark exists for the EXCEPTION only, never the norm. `replicated` and
// `remote-only` are where bytes are designed to live — a dot on every row
// (including the steady state) would caption the norm in prose under every
// document, the anti-pattern Apple Photos and Google Photos both rejected
// and mobile's `tile-overlays.ts` `stateOverlay` already encodes. `pending-
// offsite` is the transient window between local-only and replicated, so it
// falls through with the same nothing `stateOverlay` gives `queued`/
// `uploading`. `local-only` is the one state a member can lose something to;
// `missing` is a distinct integrity failure (bytes on NEITHER tier) rather
// than a custody-location fact, but it is genuinely actionable, so it keeps
// its row dot too. The full four-state story stays in `custodyMeta` above,
// read by Details.tsx's per-item chip (the on-demand altitude).
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

// Real activity (issue #352 phase 4, queries/activity.ts): consent.provenance
// stamps `prov_activity` as `command.<command name>` (execution.ts) — this is
// the owner-facing gloss for every command documents.ts registers. An
// unrecognized activity (a future command this map hasn't caught up with
// yet) still renders honestly instead of vanishing: its raw name, cleaned up.
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

// `agent_kind` (consent.provenance, W3C PROV agent class) in the same
// owner/agent framing the rest of the app uses for who acted.
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
  return typeMeta(doc.media_type).label.toLowerCase();
}
