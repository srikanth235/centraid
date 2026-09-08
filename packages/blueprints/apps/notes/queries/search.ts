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
import { inList, readPages } from "../../_shared/paged-reads.ts";
import {
  ownerKey,
  readRepresentations,
} from "../../_shared/representation-reads.ts";
import type { RepresentationIndex } from "../../_shared/representation-reads.ts";
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
  byte_size?: number;
}

interface PlacementRow {
  entry_id: string;
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
  contentById: Map<string, ContentRow>,
  representations: RepresentationIndex
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
      // The ATTACHMENT's own reading of the bytes (#996, R20(b)).
      media_type:
        representations.byOwner.get(
          ownerKey("core.attachment", a.attachment_id)
        ) ??
        representations.byContent.get(a.content_id) ??
        "application/octet-stream",
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
      }),
      readJournalNoteIds(ctx),
    ]);
    // Journal entries drop out of the ranked hits before anything is joined
    // to them (#834 R-journal), so no journal body is decoded or previewed.
    const hits = ((matches.rows ?? []) as unknown as NoteRow[]).filter(
      (note) => !journalNoteIds.has(note.note_id)
    );
    if (hits.length === 0) return { notes: [] };
    const noteIds = hits.map((n) => n.note_id);
    // Every join is `in`-bounded by the ranked hits, so each is walked to the
    // end of that set rather than taking one window of it (#996 wave 4, R8).
    const hitIn = inList("target_id", noteIds);
    const [placementRows, notebookRows, attachmentRows] = await Promise.all([
      readPages<PlacementRow>(ctx, {
        name: "notes.search.placements",
        select: "entry_id, target_type, target_id, collection_id",
        from: "core_collection_entry",
        where: `target_type = ? AND ${hitIn.sql}`,
        bind: ["knowledge.note", ...hitIn.bind],
        order: {
          sortColumn: "entry_id",
          pkColumn: "entry_id",
          descending: false,
        },
      }),
      // Notebooks are collections (#274) — the one curation mechanism. Owner-
      // curated and small, hence a walk with a stated ceiling.
      readPages<CollectionRow>(ctx, {
        name: "notes.search.notebooks",
        select: "collection_id, name",
        from: "core_collection",
        order: {
          sortColumn: "collection_id",
          pkColumn: "collection_id",
          descending: false,
        },
      }),
      readPages<AttachmentRow>(ctx, {
        name: "notes.search.attachments",
        select:
          "attachment_id, target_type, target_id, content_id, role, is_primary",
        from: "core_attachment",
        where: `target_type = ? AND ${hitIn.sql}`,
        bind: ["knowledge.note", ...hitIn.bind],
        order: {
          sortColumn: "attachment_id",
          pkColumn: "attachment_id",
          descending: false,
        },
      }),
    ]);
    // One bounded pull covers both the note bodies and any attachment bytes.
    const contentIds = [
      ...new Set([
        ...hits.map((n) => n.body_content_id),
        ...attachmentRows.map((a) => a.content_id),
      ]),
    ].filter((id): id is string => Boolean(id));
    const contentIn =
      contentIds.length > 0 ? inList("content_id", contentIds) : null;
    const contents = contentIn
      ? await readPages<ContentRow>(ctx, {
          name: "notes.search.contents",
          select: "content_id, content_uri, byte_size",
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
    const contentById = new Map(contents.map((c) => [c.content_id, c]));
    const representations = await readRepresentations({ ctx, contentIds });
    const attByNote = attachmentsBySubject(
      "knowledge.note",
      attachmentRows,
      contentById,
      representations
    );
    const nameByNotebook = new Map(
      notebookRows.map((nb) => [nb.collection_id, nb.name])
    );
    const notebooksByNote = new Map<string, string[]>();
    for (const p of placementRows) {
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
