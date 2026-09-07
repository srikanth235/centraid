/**
 * The Journal PLACE (#834 R-journal): the only query door including the
 * journal scheme (`library`/`search` exclude it). Read-only; every read is
 * bounded, and a DENIAL IS A VALUE: translated into the empty shape plus
 * `vaultDenied`, not a throw.
 */

import { readJournalNoteIds } from "../../_shared/journal-scheme.ts";
import { inList, readPages } from "../../_shared/paged-reads.ts";
import { decodeNoteBody } from "../note-body.ts";

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
  const window = Math.min(Math.max(Number(input?.limit) || 200, 20), 2000);
  try {
    const journalNoteIds = await readJournalNoteIds(ctx);
    if (journalNoteIds.size === 0)
      return { entries: [], truncated: false, window };

    const journalIn = inList("note_id", [...journalNoteIds]);
    const notes = await ctx.vault.page<NoteRow>({
      query: {
        name: "notes.journal.entries",
        select:
          "note_id, title, format, body_content_id, created_at, updated_at, deleted_at",
        from: "knowledge_note",
        // live rows, not the library's trash shelf
        where: `${journalIn.sql} AND deleted_at IS NULL`,
        bind: journalIn.bind,
        order: {
          sortColumn: "updated_at",
          pkColumn: "note_id",
          descending: true,
        },
      },
      limit: window,
    });
    // INCLUDE-ONLY is this query's whole contract: re-narrow in memory so an
    // over-wide read cannot put a non-journal note in the Journal place.
    const rows = notes.rows.filter(
      (note) => journalNoteIds.has(note.note_id) && note.deleted_at == null
    );
    if (rows.length === 0) return { entries: [], truncated: false, window };

    const contentIds = [
      ...new Set(rows.map((note) => note.body_content_id)),
    ].filter((id): id is string => Boolean(id));
    const contentIn =
      contentIds.length > 0 ? inList("content_id", contentIds) : null;
    const contents = contentIn
      ? await readPages<ContentRow>(ctx, {
          name: "notes.journal.bodies",
          select: "content_id, content_uri",
          from: "core_content_item",
          where: contentIn.sql,
          bind: contentIn.bind,
          order: {
            sortColumn: "content_id",
            pkColumn: "content_id",
            descending: false,
          },
        })
      : [];
    const uriById = new Map(
      contents.map((content) => [content.content_id, content.content_uri])
    );

    return {
      entries: rows.map((note) => {
        const body = decodeNoteBody(uriById.get(note.body_content_id ?? ""));
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
      // The page's own cursor, not a guess off the row count (#996 wave 4).
      truncated: notes.next !== undefined,
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
