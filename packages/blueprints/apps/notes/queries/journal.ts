/**
 * The Journal PLACE (#834 R-journal): the only query door including the
 * journal scheme (`library`/`search` exclude it). Read-only; every read is
 * bounded, and a DENIAL IS A VALUE: translated into the empty shape plus
 * `vaultDenied`, not a throw.
 */

import { readJournalNoteIds } from "../../_shared/journal-scheme.ts";

interface NoteRow {
  note_id: string;
  title?: string;
  format?: string;
  created_at?: string;
  updated_at?: string;
  body_content_id?: string;
  deleted_at?: string | null;
}

interface ContentRow {
  content_id: string;
  content_uri?: string;
}

/** Inline `data:` bodies decoded; anything else is opaque, as in library. */
function decodeBody(uri: unknown): string {
  if (typeof uri !== "string" || !uri.startsWith("data:"))
    return "(external content)";
  const comma = uri.indexOf(",");
  if (comma === -1) return "(external content)";
  const meta = uri.slice(0, comma);
  const payload = uri.slice(comma + 1);
  try {
    if (meta.includes(";base64")) {
      return typeof Buffer === "undefined"
        ? atob(payload)
        : Buffer.from(payload, "base64").toString("utf8");
    }
    return decodeURIComponent(payload);
  } catch {
    return "(external content)";
  }
}

// Preview + checklist tally, never a whole body — the derivations `library`
// ships, inlined (a query handler is a standalone module).
const CHECK_RE = /^\s*[-*] \[(?<mark> |x|X)\]\s?(?<text>.*)$/u;

function previewOf(body: string): string {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (out.length >= 6) break;
    const check = CHECK_RE.exec(line);
    if (check) {
      out.push(
        (/x/iu.test(check.groups?.mark ?? "") ? "☑ " : "☐ ") +
          (check.groups?.text ?? "")
      );
      continue;
    }
    if (/^#{1,3}\s+/u.test(line)) continue;
    const item = /^\s*(?:[-*]|\d+\.)\s+(?<text>.*)$/u.exec(line);
    if (item) {
      out.push("• " + (item.groups?.text ?? ""));
      continue;
    }
    if (line.trim() === "") continue;
    out.push(line);
  }
  const text = out
    .join("\n")
    .replace(/\*\*(?<bold>.+?)\*\*/gu, "$<bold>")
    .replace(/\*(?<italic>.+?)\*/gu, "$<italic>")
    .replace(/`(?<code>.+?)`/gu, "$<code>");
  return text.length > 200 ? text.slice(0, 200) : text;
}

function checkOf(body: string): { total: number; done: number } {
  let total = 0;
  let done = 0;
  for (const line of body.split("\n")) {
    const match = CHECK_RE.exec(line);
    if (!match) continue;
    total += 1;
    if (/x/iu.test(match.groups?.mark ?? "")) done += 1;
  }
  return { total, done };
}

export default async function journalHandler({ input, ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  const window = Math.min(Math.max(Number(input?.limit) || 200, 20), 2000);
  try {
    const journalNoteIds = await readJournalNoteIds(ctx.vault, purpose);
    if (journalNoteIds.size === 0)
      return { entries: [], truncated: false, window };

    const ids = [...journalNoteIds];
    const notes = await ctx.vault.read({
      entity: "knowledge.note",
      where: [
        { column: "note_id", op: "in", value: ids },
        { column: "deleted_at", op: "is-null" }, // live rows, not the library's trash shelf
      ],
      orderBy: { column: "updated_at", dir: "desc" },
      limit: window,
      purpose,
    });
    // INCLUDE-ONLY is this query's whole contract: re-narrow in memory so an
    // over-wide read cannot put a non-journal note in the Journal place.
    const rows = ((notes.rows ?? []) as unknown as NoteRow[]).filter(
      (note) => journalNoteIds.has(note.note_id) && note.deleted_at == null
    );
    if (rows.length === 0) return { entries: [], truncated: false, window };

    const contentIds = [
      ...new Set(rows.map((note) => note.body_content_id)),
    ].filter((id): id is string => Boolean(id));
    const contents =
      contentIds.length > 0
        ? await ctx.vault.read({
            entity: "core.content_item",
            where: [{ column: "content_id", op: "in", value: contentIds }],
            limit: contentIds.length,
            purpose,
          })
        : { rows: [] };
    const uriById = new Map(
      ((contents.rows ?? []) as unknown as ContentRow[]).map((content) => [
        content.content_id,
        content.content_uri,
      ])
    );

    return {
      entries: rows.map((note) => {
        const body = decodeBody(uriById.get(note.body_content_id ?? ""));
        return {
          note_id: note.note_id,
          title: note.title,
          format: note.format,
          created_at: note.created_at,
          updated_at: note.updated_at,
          deleted_at: null,
          preview: previewOf(body),
          check: checkOf(body),
        };
      }),
      // Full slice means there is more behind it, as in the library window.
      truncated: ((notes.rows ?? []) as unknown[]).length >= window,
      window,
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      entries: [],
      truncated: false,
      window,
      vaultDenied: { code: e.code, message: e.message },
    };
  }
}
