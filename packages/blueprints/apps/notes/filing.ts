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

export interface NotebookShelf extends Notebook {
  noteIds: readonly string[];
}

export interface NotebookRows {
  collections: readonly VaultRow[];
  entries: readonly VaultRow[];
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
  edges: ReadonlyArray<{ tag_id: string; note_id: string }>;
}

export interface TagRows {
  tags: readonly VaultRow[];
  concepts: readonly VaultRow[];
  visible?: ReadonlySet<string>;
}

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
