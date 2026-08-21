/**
 * The Journal PLACE: the People-journal entries, and only those.
 *
 * Journal is a place, never an interleave (#834 R-journal). `library`,
 * `search` and `link-targets` EXCLUDE the journal scheme; this query is the
 * one door that includes it, and it includes nothing else — the same marker
 * set, read the other way round. An owner's journal is written in People and
 * read here; nothing in Notes writes one, so this handler is read-only and
 * the app offers no verb over these rows beyond opening them.
 *
 * Every read is bounded: the marker resolution is three `eq`-narrowed reads
 * (`_shared/journal-scheme.ts`), the notes are `in`-bounded by the marker's
 * own id set and capped by `limit`, and the bodies are `in`-bounded by the
 * note rows that survived. There is no whole-table walk in any branch.
 *
 * A DENIAL IS A VALUE, NOT A THROW: `readJournalNoteIds` throws rather than
 * answering "nothing is a journal entry", and this handler translates that
 * into the empty shape plus `vaultDenied`, which is what the consent gate
 * renders.
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

/** Canonical bodies live inline as `data:` URIs; anything else is opaque to
 *  this projection, exactly as it is to `library`. */
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

// The card needs a preview and a checklist tally, never a whole body — the
// same two derivations `library` ships, inlined for the same reason (a query
// handler is a standalone module).
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
        // A trashed journal entry is in the trash, which is the library's
        // shelf — this place shows what is live.
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "updated_at", dir: "desc" },
      limit: window,
      purpose,
    });
    // Re-narrowed in memory: the read is already `in`-bounded, but INCLUDE-ONLY
    // is the whole contract of this query, so a read that answered wider than
    // it was asked must not put a non-journal note into the Journal place.
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
      // Measured against what the vault returned, the same honesty the
      // library window keeps: a full slice means there is more behind it.
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
