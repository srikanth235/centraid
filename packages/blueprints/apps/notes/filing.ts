// Notebooks and tags projected from raw vault rows — no IO, no JSX. Both
// seats read this one derivation: the pointer seats through `queries/library`
// and the phone straight off its replica.
//
// NOTEBOOKS ARE WHERE A NOTE LIVES; TAGS ARE HOW IT IS SEEN. Deleting a
// notebook unfiles its notes and destroys none; removing a tag drops ONE edge
// and never the shared concept, which other subjects still carry.
import type { NoteTag, Notebook } from "./types.ts";

export type VaultRow = Record<string, unknown>;

const NOTE_TYPE = "knowledge.note";

function text(row: VaultRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function order(row: VaultRow, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value ?? 0) || 0;
}

/** A notebook plus the notes standing in it. */
export interface NotebookShelf extends Notebook {
  noteIds: readonly string[];
}

export interface NotebookRows {
  /** `core.collection` rows. */
  collections: readonly VaultRow[];
  /** `core.collection_entry` rows. */
  entries: readonly VaultRow[];
  /** Membership is counted over these ids only, so a count can never promise
   *  a note the place cannot open (journal ids never reach here — R-journal). */
  visible?: ReadonlySet<string>;
}

export function projectNotebooks(rows: NotebookRows): NotebookShelf[] {
  const members = new Map<string, string[]>();
  for (const collection of rows.collections) {
    const id = text(collection, "collection_id");
    if (id) members.set(id, []);
  }
  for (const entry of rows.entries) {
    if (text(entry, "target_type") !== NOTE_TYPE) continue;
    const noteId = text(entry, "target_id");
    const list = members.get(text(entry, "collection_id"));
    if (!noteId || !list) continue;
    if (rows.visible && !rows.visible.has(noteId)) continue;
    if (!list.includes(noteId)) list.push(noteId);
  }
  return rows.collections
    .flatMap((collection): NotebookShelf[] => {
      const id = text(collection, "collection_id");
      if (!id) return [];
      return [
        {
          notebook_id: id,
          name: text(collection, "name") || "Notebook",
          sort_order: order(collection, "sort_order"),
          noteIds: members.get(id) ?? [],
        },
      ];
    })
    .sort(
      (left, right) =>
        (left.sort_order ?? 0) - (right.sort_order ?? 0) ||
        (left.name ?? "").localeCompare(right.name ?? "")
    );
}

/** Filed nowhere. An unfiled note is not a lesser note — it still opens. */
export function unfiledNoteIds(
  noteIds: readonly string[],
  shelves: readonly NotebookShelf[]
): string[] {
  const filed = new Set(shelves.flatMap((shelf) => [...shelf.noteIds]));
  return noteIds.filter((id) => !filed.has(id));
}

export function notebookIdsOfNote(
  noteId: string,
  shelves: readonly NotebookShelf[]
): string[] {
  return shelves
    .filter((shelf) => shelf.noteIds.includes(noteId))
    .map((shelf) => shelf.notebook_id);
}

export interface TagShelf {
  concept_id: string;
  label: string;
  /** One edge per tagged note. Removing one removes THIS note's edge only. */
  edges: ReadonlyArray<{ tag_id: string; note_id: string }>;
}

export interface TagRows {
  /** `core.tag` rows. */
  tags: readonly VaultRow[];
  /** `core.concept` rows, for the shared label. */
  concepts: readonly VaultRow[];
  visible?: ReadonlySet<string>;
}

/**
 * The house vocabulary, alphabetical. A concept whose every edge fell outside
 * `visible` is DROPPED rather than shown with a zero — the same re-narrowing
 * `queries/library.ts` performs, so a journal-only tag cannot leak back in.
 */
export function projectTagShelves(rows: TagRows): TagShelf[] {
  const labels = new Map<string, string>();
  for (const concept of rows.concepts) {
    const id = text(concept, "concept_id");
    if (id) labels.set(id, text(concept, "pref_label"));
  }
  const shelves = new Map<string, { tag_id: string; note_id: string }[]>();
  for (const tag of rows.tags) {
    if (text(tag, "target_type") !== NOTE_TYPE) continue;
    const noteId = text(tag, "target_id");
    const conceptId = text(tag, "concept_id");
    const tagId = text(tag, "tag_id");
    if (!noteId || !conceptId || !tagId) continue;
    if (rows.visible && !rows.visible.has(noteId)) continue;
    const edges = shelves.get(conceptId);
    if (edges) edges.push({ tag_id: tagId, note_id: noteId });
    else shelves.set(conceptId, [{ tag_id: tagId, note_id: noteId }]);
  }
  return [...shelves.entries()]
    .map(([conceptId, edges]) => ({
      concept_id: conceptId,
      label: labels.get(conceptId) || "?",
      edges,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function tagsOfNote(
  noteId: string,
  shelves: readonly TagShelf[]
): NoteTag[] {
  return shelves.flatMap((shelf) =>
    shelf.edges.flatMap((edge) =>
      edge.note_id === noteId
        ? [
            {
              tag_id: edge.tag_id,
              concept_id: shelf.concept_id,
              label: shelf.label,
            },
          ]
        : []
    )
  );
}
