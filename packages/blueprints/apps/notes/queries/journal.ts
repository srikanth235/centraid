import { readJournalNoteIds } from "../../_shared/journal-scheme.ts";
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
