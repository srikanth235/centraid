/**
 * Note search as a vault projection: the FTS5 index inside the vault does
 * the matching (title + canonical body), so the app never pulls the whole
 * knowledge.note table to grep it — vault data has no upper bound. Only the
 * matched rows are joined with their decoded bodies and notebook names,
 * mirroring the library projection's shape row-for-row so the UI renders
 * either list with the same code.
 *
 * People-journal entries are EXCLUDED from the hits (#834 R-journal): the
 * Journal place is their one home in Notes. The exclusion runs over the ranked
 * hits, so an all-journal search answers an empty list, not a filtered one.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 */

import { readJournalNoteIds } from "../../_shared/journal-scheme.ts";
import { decodeNoteBody } from "../note-body.ts";

interface NoteRow {
  note_id: string;
  title?: string;
  format?: string;
  pinned?: number;
  created_at?: string;
  updated_at?: string;
  body_content_id?: string;
  _snippet?: string;
}

interface AttachmentRow {
  attachment_id: string;
  target_type: string;
  target_id: string;
  content_id: string;
  role?: string;
  is_primary?: number;
}

interface ContentRow {
  content_id: string;
  content_uri?: string;
  media_type?: string;
  title?: string;
  byte_size?: number;
}

interface PlacementRow {
  target_id: string;
  collection_id: string;
}

interface CollectionRow {
  collection_id: string;
  name?: string;
}

/** The shared attachment projection — see library.ts for the shape's home. */
function attachmentsBySubject(
  subjectType: string,
  attachments: AttachmentRow[],
  contentById: Map<string, ContentRow>
) {
  // Blob-backed bytes serve as same-origin URLs (#296).
  const srcOf = (c: ContentRow | undefined) =>
    typeof c?.content_uri === "string" && c.content_uri.startsWith("blob:")
      ? `/centraid/_vault/blobs/${c.content_id}`
      : c?.content_uri;
  const bySubject = new Map<string, Array<Record<string, unknown>>>();
  for (const a of attachments) {
    if (a.target_type !== subjectType) continue;
    const content = contentById.get(a.content_id);
    if (!bySubject.has(a.target_id)) bySubject.set(a.target_id, []);
    bySubject.get(a.target_id)!.push({
      attachment_id: a.attachment_id,
      content_id: a.content_id,
      role: a.role,
      is_primary: a.is_primary,
      media_type: content?.media_type ?? "application/octet-stream",
      title: content?.title ?? null,
      content_uri: srcOf(content) ?? "",
      byte_size: content?.byte_size ?? 0,
    });
  }
  for (const list of bySubject.values()) {
    list.sort(
      (x, y) => (Number(y.is_primary) || 0) - (Number(x.is_primary) || 0)
    );
  }
  return bySubject;
}

// Same list-row discipline as library.ts: a short preview + the checklist
// tally, never the whole body (#404).
const CHECK_RE = /^\s*[-*] \[(?<mark> |x|X)\]\s?(?<text>.*)$/u;

function previewOf(body: unknown): string {
  const lines = String(body ?? "").split("\n");
  const out: string[] = [];
  for (const line of lines) {
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
    const li = /^\s*(?:[-*]|\d+\.)\s+(?<text>.*)$/u.exec(line);
    if (li) {
      out.push("• " + (li.groups?.text ?? ""));
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

function checkOf(body: unknown): { total: number; done: number } {
  let total = 0;
  let done = 0;
  for (const line of String(body ?? "").split("\n")) {
    const m = CHECK_RE.exec(line);
    if (!m) continue;
    total += 1;
    if (/x/iu.test(m.groups?.mark ?? "")) done += 1;
  }
  return { total, done };
}

export default async function searchHandler({ input, ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  const term = String(input?.term ?? "").trim();
  if (!term) return { notes: [] };
  try {
    const [matches, journalNoteIds] = await Promise.all([
      ctx.vault.search({
        entity: "knowledge.note",
        query: term,
        // Trashed notes (#308: delete is reversible) never match.
        where: [{ column: "deleted_at", op: "is-null" }],
        limit: 100,
        purpose,
      }),
      readJournalNoteIds(ctx.vault, purpose),
    ]);
    // Journal entries drop out of the ranked hits before anything is joined
    // to them (#834 R-journal), so no journal body is decoded or previewed.
    const hits = ((matches.rows ?? []) as unknown as NoteRow[]).filter(
      (note) => !journalNoteIds.has(note.note_id)
    );
    if (hits.length === 0) return { notes: [] };
    const noteIds = hits.map((n) => n.note_id);
    const [placements, notebooks, attachments] = await Promise.all([
      ctx.vault.read({
        acceptTruncation: true,
        entity: "core.collection_entry",
        where: [
          { column: "target_type", op: "eq", value: "knowledge.note" },
          { column: "target_id", op: "in", value: noteIds },
        ],
        purpose,
      }),
      // Notebooks are collections (#274) — the one curation mechanism.
      ctx.vault.read({
        acceptTruncation: true,
        entity: "core.collection",
        purpose,
      }),
      ctx.vault.read({
        acceptTruncation: true,
        entity: "core.attachment",
        where: [
          { column: "target_type", op: "eq", value: "knowledge.note" },
          { column: "target_id", op: "in", value: noteIds },
        ],
        purpose,
      }),
    ]);
    // One bounded pull covers both the note bodies and any attachment bytes.
    const attachmentRows = (attachments.rows ??
      []) as unknown as AttachmentRow[];
    const contentIds = [
      ...new Set([
        ...hits.map((n) => n.body_content_id),
        ...attachmentRows.map((a) => a.content_id),
      ]),
    ].filter((id): id is string => Boolean(id));
    const contents = await ctx.vault.read({
      acceptTruncation: true,
      entity: "core.content_item",
      where: [{ column: "content_id", op: "in", value: contentIds }],
      purpose,
    });
    const contentById = new Map(
      ((contents.rows ?? []) as unknown as ContentRow[]).map((c) => [
        c.content_id,
        c,
      ])
    );
    const attByNote = attachmentsBySubject(
      "knowledge.note",
      attachmentRows,
      contentById
    );
    const nameByNotebook = new Map(
      ((notebooks.rows ?? []) as unknown as CollectionRow[]).map((nb) => [
        nb.collection_id,
        nb.name,
      ])
    );
    const notebooksByNote = new Map<string, string[]>();
    for (const p of (placements.rows ?? []) as unknown as PlacementRow[]) {
      if (!notebooksByNote.has(p.target_id))
        notebooksByNote.set(p.target_id, []);
      notebooksByNote.get(p.target_id)!.push(p.collection_id);
    }
    // Vault order is rank order (best match first) — keep it.
    const notes = hits.map((n) => {
      const notebookIds = notebooksByNote.get(n.note_id) ?? [];
      const decoded = decodeNoteBody(
        contentById.get(n.body_content_id ?? "")?.content_uri
      );
      return {
        note_id: n.note_id,
        title: n.title,
        format: n.format,
        pinned: n.pinned,
        created_at: n.created_at,
        updated_at: n.updated_at,
        preview: previewOf(decoded),
        check: checkOf(decoded),
        notebook_ids: notebookIds,
        notebook_names: notebookIds.map(
          (id) => nameByNotebook.get(id) ?? "Notebook"
        ),
        attachments: attByNote.get(n.note_id) ?? [],
        snippet: typeof n._snippet === "string" ? n._snippet : "",
      };
    });
    return { notes };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { notes: [], vaultDenied: { code: e.code, message: e.message } };
  }
}
