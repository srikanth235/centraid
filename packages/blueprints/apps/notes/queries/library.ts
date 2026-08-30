/**
 * The notes projection as a BOUNDED recent window (#262): newest by
 * updated_at plus every pinned note, never the whole table; `truncated` tells
 * the UI to offer a wider one. People-journal entries are EXCLUDED (#834
 * R-journal) — they must never reach the library, the trash shelf, or the tag
 * chips derived from it, though opening one by id still works. A consent
 * denial is a first-class outcome, not an error.
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
  deleted_at?: string | null;
  purge_at?: string | null;
}

interface CollectionRow {
  collection_id: string;
  name?: string;
  sort_order?: number;
}

interface PlacementRow {
  target_id: string;
  collection_id: string;
}

interface AttachmentRow {
  attachment_id: string;
  target_type: string;
  target_id: string;
  content_id: string;
  role?: string;
  is_primary?: number;
}

interface LinkRow {
  link_id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
}

interface TagRow {
  tag_id: string;
  concept_id: string;
  target_id: string;
}

interface ConceptRow {
  concept_id: string;
  pref_label: string;
}

interface AnchorRow {
  link_id: string;
  selector_json: string;
}

interface ContentRow {
  content_id: string;
  content_uri?: string;
  media_type?: string;
  title?: string;
  byte_size?: number;
}

interface CardRow extends Record<string, unknown> {
  type: string;
  id: string;
}

// A short preview + checklist tally, never the whole body (#404). Mirrors
// format.ts's previewText/checkStats — inlined, as handlers are standalone.
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
    if (/^#{1,3}\s+/u.test(line)) continue; // headings drop — the title carries them
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

/** The shared attachment-projection shape, keyed by target_id. */
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

export default async function libraryHandler({ input, ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  const window = Math.min(Math.max(Number(input?.limit) || 200, 20), 2000);
  try {
    // Pinned notes ride beside the window: a pin survives the note aging out.
    const [recent, pinnedNotes, trashedNotes, notebooks, journalNoteIds] =
      await Promise.all([
        ctx.vault.read({
          entity: "knowledge.note",
          // Trashed notes (#308: delete is reversible) stay out of the library.
          where: [{ column: "deleted_at", op: "is-null" }],
          orderBy: { column: "updated_at", dir: "desc" },
          limit: window,
          purpose,
        }),
        ctx.vault.read({
          entity: "knowledge.note",
          where: [
            { column: "pinned", op: "eq", value: 1 },
            { column: "deleted_at", op: "is-null" },
          ],
          orderBy: { column: "updated_at", dir: "desc" },
          limit: 200,
          purpose,
        }),
        ctx.vault.read({
          entity: "knowledge.note",
          where: [{ column: "deleted_at", op: "not-null" }],
          orderBy: { column: "deleted_at", dir: "desc" },
          limit: 200,
          purpose,
        }),
        // Notebooks are collections (#274) — the one curation mechanism.
        ctx.vault.read({ entity: "core.collection", purpose }),
        // Rides this Promise.all so the exclusion costs no extra round trip.
        readJournalNoteIds(ctx.vault, purpose),
      ]);
    const byId = new Map<string, NoteRow>();
    for (const n of [
      ...((recent.rows ?? []) as unknown as NoteRow[]),
      ...((pinnedNotes.rows ?? []) as unknown as NoteRow[]),
      ...((trashedNotes.rows ?? []) as unknown as NoteRow[]),
    ]) {
      byId.set(n.note_id, n);
    }
    // A collection may also hold photos and documents; this surface renders notes.
    const books = ((notebooks.rows ?? []) as unknown as CollectionRow[])
      .map((c) => ({
        notebook_id: c.collection_id,
        name: c.name,
        sort_order: c.sort_order,
      }))
      .toSorted((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    // Journal ids must never reach the joins below (#834 R-journal).
    const windowed = [...byId.values()].filter(
      (note) => !journalNoteIds.has(note.note_id)
    );
    if (windowed.length === 0) {
      return {
        notes: [],
        trash: [],
        notebooks: books,
        tags: [],
        truncated: false,
        window,
      };
    }
    const noteIds = windowed.map((n) => n.note_id);

    // Joins stay `in`-bounded by the window (#272).
    const [placements, attachments, links, backlinks, tags] = await Promise.all(
      [
        ctx.vault.read({
          entity: "core.collection_entry",
          where: [
            { column: "target_type", op: "eq", value: "knowledge.note" },
            { column: "target_id", op: "in", value: noteIds },
          ],
          purpose,
        }),
        ctx.vault.read({
          entity: "core.attachment",
          where: [
            { column: "target_type", op: "eq", value: "knowledge.note" },
            { column: "target_id", op: "in", value: noteIds },
          ],
          purpose,
        }),
        ctx.vault.read({
          entity: "core.link",
          where: [
            { column: "from_type", op: "eq", value: "knowledge.note" },
            { column: "from_id", op: "in", value: noteIds },
            { column: "valid_to", op: "is-null" },
          ],
          purpose,
        }),
        ctx.vault.read({
          entity: "core.link",
          where: [
            { column: "to_type", op: "eq", value: "knowledge.note" },
            { column: "to_id", op: "in", value: noteIds },
            { column: "valid_to", op: "is-null" },
          ],
          purpose,
        }),
        ctx.vault.read({
          entity: "core.tag",
          where: [
            { column: "target_type", op: "eq", value: "knowledge.note" },
            { column: "target_id", op: "in", value: noteIds },
          ],
          purpose,
        }),
      ]
    );
    // Re-narrowed in memory: tag→concept→chip is where a journal-only concept
    // would leak back in, so the exclusion is enforced here, not trusted (#834).
    const survivingIds = new Set(noteIds);
    const tagRows = ((tags.rows ?? []) as unknown as TagRow[]).filter((t) =>
      survivingIds.has(t.target_id)
    );
    const conceptIds = [...new Set(tagRows.map((t) => t.concept_id))];
    const concepts =
      conceptIds.length > 0
        ? await ctx.vault.read({
            entity: "core.concept",
            where: [{ column: "concept_id", op: "in", value: conceptIds }],
            purpose,
          })
        : { rows: [] };
    // Same re-narrowing one link on: a read may answer wider than it was asked.
    const wantedConcepts = new Set(conceptIds);
    const conceptRows = (
      (concepts.rows ?? []) as unknown as ConceptRow[]
    ).filter((c) => wantedConcepts.has(c.concept_id));
    const labelByConcept = new Map(
      conceptRows.map((c) => [c.concept_id, c.pref_label])
    );
    const tagsByNote = new Map<string, Array<Record<string, unknown>>>();
    for (const t of tagRows) {
      if (!tagsByNote.has(t.target_id)) tagsByNote.set(t.target_id, []);
      tagsByNote.get(t.target_id)!.push({
        tag_id: t.tag_id,
        concept_id: t.concept_id,
        label: labelByConcept.get(t.concept_id) ?? "?",
      });
    }
    const allTags = [
      ...new Map(
        conceptRows.map((c) => [c.concept_id, c.pref_label])
      ).entries(),
    ]
      .map(([concept_id, label]) => ({ concept_id, label }))
      .toSorted((a, b) => a.label.localeCompare(b.label));

    // Resolvable-if-linked: no media/finance read scopes are needed here.
    const linkRows = (links.rows ?? []) as unknown as LinkRow[];
    const backlinkRows = (backlinks.rows ?? []) as unknown as LinkRow[];
    const uniqueRefs = [
      ...new Map(
        [
          ...linkRows.map((l) => ({ type: l.to_type, id: l.to_id })),
          ...backlinkRows.map((l) => ({
            type: l.from_type,
            id: l.from_id,
          })),
        ].map((ref) => [`${ref.type}/${ref.id}`, ref])
      ).values(),
    ];
    // Standoff anchors (#282): ship the selector; resolving it is presentation.
    const [resolved, anchors] = await Promise.all([
      uniqueRefs.length > 0
        ? ctx.vault.resolve({ refs: uniqueRefs, purpose })
        : Promise.resolve({ cards: [] as Array<Record<string, unknown>> }),
      linkRows.length > 0
        ? ctx.vault.read({
            entity: "core.link_anchor",
            where: [
              {
                column: "link_id",
                op: "in",
                value: linkRows.map((l) => l.link_id),
              },
            ],
            purpose,
          })
        : Promise.resolve({ rows: [] }),
    ]);
    const cardByRef = new Map(
      ((resolved.cards ?? []) as unknown as CardRow[]).map((c) => [
        `${c.type}/${c.id}`,
        c,
      ])
    );
    const selectorByLink = new Map<string, unknown>();
    for (const a of (anchors.rows ?? []) as unknown as AnchorRow[]) {
      try {
        selectorByLink.set(a.link_id, JSON.parse(a.selector_json));
      } catch {
        // an unreadable selector is just an unanchored reference
      }
    }
    const referencesByNote = new Map<string, Array<Record<string, unknown>>>();
    for (const l of linkRows) {
      if (!referencesByNote.has(l.from_id)) referencesByNote.set(l.from_id, []);
      referencesByNote.get(l.from_id)!.push({
        link_id: l.link_id,
        selector: selectorByLink.get(l.link_id) ?? null,
        card: cardByRef.get(`${l.to_type}/${l.to_id}`) ?? {
          type: l.to_type,
          id: l.to_id,
          status: "unknown",
          title: null,
          subtitle: null,
          thumbnail_content_id: null,
        },
      });
    }
    const backlinksByNote = new Map<string, Array<Record<string, unknown>>>();
    for (const l of backlinkRows) {
      if (!backlinksByNote.has(l.to_id)) backlinksByNote.set(l.to_id, []);
      backlinksByNote.get(l.to_id)!.push({
        link_id: l.link_id,
        card: cardByRef.get(`${l.from_type}/${l.from_id}`) ?? {
          type: l.from_type,
          id: l.from_id,
          status: "unknown",
          title: null,
          subtitle: null,
          thumbnail_content_id: null,
        },
      });
    }
    const attachmentRows = (attachments.rows ??
      []) as unknown as AttachmentRow[];
    const contentIds = [
      ...new Set([
        ...windowed.map((n) => n.body_content_id),
        ...attachmentRows.map((a) => a.content_id),
      ]),
    ].filter((id): id is string => Boolean(id));
    const contents =
      contentIds.length > 0
        ? await ctx.vault.read({
            entity: "core.content_item",
            where: [{ column: "content_id", op: "in", value: contentIds }],
            purpose,
          })
        : { rows: [] };

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
      books.map((nb) => [nb.notebook_id, nb.name])
    );
    const notebooksByNote = new Map<string, string[]>();
    for (const p of (placements.rows ?? []) as unknown as PlacementRow[]) {
      if (!notebooksByNote.has(p.target_id))
        notebooksByNote.set(p.target_id, []);
      notebooksByNote.get(p.target_id)!.push(p.collection_id);
    }
    const rows = windowed
      .map((n) => {
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
          deleted_at: n.deleted_at ?? null,
          purge_at: n.purge_at ?? null,
          preview: previewOf(decoded),
          check: checkOf(decoded),
          notebook_ids: notebookIds,
          notebook_names: notebookIds.map(
            (id) => nameByNotebook.get(id) ?? "Notebook"
          ),
          attachments: attByNote.get(n.note_id) ?? [],
          references: referencesByNote.get(n.note_id) ?? [],
          backlinks: backlinksByNote.get(n.note_id) ?? [],
          tags: tagsByNote.get(n.note_id) ?? [],
        };
      })
      .toSorted(
        (a, b) =>
          (b.pinned ?? 0) - (a.pinned ?? 0) ||
          String(b.updated_at).localeCompare(String(a.updated_at))
      );

    // Measured PRE-exclusion on purpose (#834): the window is what the vault
    // returned, so `notes` may hold fewer rows than `window` while this is true.
    const truncated =
      ((recent.rows ?? []) as unknown as NoteRow[]).length >= window;
    return {
      notes: rows.filter((row) => row.deleted_at == null),
      trash: rows.filter((row) => row.deleted_at != null),
      notebooks: books,
      tags: allTags,
      truncated,
      window,
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      notes: [],
      trash: [],
      notebooks: [],
      vaultDenied: { code: e.code, message: e.message },
    };
  }
}
