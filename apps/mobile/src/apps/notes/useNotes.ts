import { useMemo } from "react";

import {
  JOURNAL_ENTRY_NOTATION,
  JOURNAL_SCHEME_URI,
} from "@centraid/blueprints/apps/_shared/journal-scheme";
import { inList } from "@centraid/blueprints/apps/_shared/paged-reads";
import {
  projectNotebooks,
  projectTagShelves,
} from "@centraid/blueprints/apps/notes/filing";
import type { PageQuery } from "@centraid/core/page";

import { combineReplicaQueryStates } from "../../kit/hooks/replica-query-state";
import { useSeatPages } from "../../kit/hooks/useSeatPages";
import { buildNotes } from "./notes-model";
import {
  NOTES_ANCHORS,
  NOTES_COLLECTIONS,
  NOTES_CONCEPTS,
  NOTES_LINKS,
  NOTES_NOTES,
  NOTES_PLACEMENTS,
  NOTES_REVISIONS,
  NOTES_SCHEMES,
  NOTES_TAGS,
} from "./notes-queries";

export function useNotes() {
  const notes = useSeatPages("notes", NOTES_NOTES, {
    entity: "knowledge.note",
    rowIdColumn: "note_id",
  });
  // Bound the content_item read to the note body ids. An unbounded read is
  // capped at 1000 rows server-side, so at photo-scale vaults most note bodies
  // fall outside the window and render blank.
  const bodyIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of notes.rows) {
      if (typeof row.body_content_id === "string" && row.body_content_id) {
        ids.add(row.body_content_id);
      }
    }
    return [...ids];
  }, [notes.rows]);
  const contentQuery = useMemo<PageQuery | undefined>(() => {
    if (bodyIds.length === 0) return undefined;
    const ids = inList("content_id", bodyIds);
    return {
      name: "phone.notes.bodies",
      select: "content_id, content_uri, sha256, byte_size, language",
      from: "core_content_item",
      where: ids.sql,
      bind: ids.bind,
      order: {
        sortColumn: "content_id",
        pkColumn: "content_id",
        descending: false,
      },
    };
  }, [bodyIds]);
  const contents = useSeatPages("notes", contentQuery, {
    entity: "core.content_item",
    rowIdColumn: "content_id",
  });
  const links = useSeatPages("notes", NOTES_LINKS, {
    entity: "core.link",
    rowIdColumn: "link_id",
  });
  const anchors = useSeatPages("notes", NOTES_ANCHORS, {
    entity: "core.link_anchor",
    rowIdColumn: "anchor_id",
  });
  // The People-journal marker, resolved on this seat exactly as the web
  // queries resolve it: the scheme by URI, its `entry` concept, then the note
  // ids that concept tags. Journal is a PLACE and never an interleave, so the
  // library below is filtered by this set rather than merged with it.
  const schemes = useSeatPages("notes", NOTES_SCHEMES, {
    entity: "core.concept_scheme",
    rowIdColumn: "scheme_id",
  });
  const concepts = useSeatPages("notes", NOTES_CONCEPTS, {
    entity: "core.concept",
    rowIdColumn: "concept_id",
  });
  const tags = useSeatPages("notes", NOTES_TAGS, {
    entity: "core.tag",
    rowIdColumn: "tag_id",
  });
  const journalNoteIds = useMemo(() => {
    const schemeId = schemes.rows.find(
      (row) => row.uri === JOURNAL_SCHEME_URI
    )?.scheme_id;
    const markerId = concepts.rows.find(
      (row) =>
        row.scheme_id === schemeId && row.notation === JOURNAL_ENTRY_NOTATION
    )?.concept_id;
    if (!markerId) return new Set<string>();
    return new Set(
      tags.rows.flatMap((row) =>
        row.concept_id === markerId && typeof row.target_id === "string"
          ? [row.target_id]
          : []
      )
    );
  }, [concepts.rows, schemes.rows, tags.rows]);
  // Notebooks are collections (#274); the spine must name every one of them.
  const collections = useSeatPages("notes", NOTES_COLLECTIONS, {
    entity: "core.collection",
    rowIdColumn: "collection_id",
  });
  const placements = useSeatPages("notes", NOTES_PLACEMENTS, {
    entity: "core.collection_entry",
    rowIdColumn: "entry_id",
  });
  // A note's history is its own occurrences (#996, R20(a)) — one entity read
  // where the `revises` walk needed links, concepts and schemes.
  const revisions = useSeatPages("notes", NOTES_REVISIONS, {
    entity: "core.entity_revision",
    rowIdColumn: "revision_id",
  });
  const built = useMemo(
    () => buildNotes(notes.rows, contents.rows, links.rows, anchors.rows),
    [anchors.rows, contents.rows, links.rows, notes.rows]
  );
  // COUNTS PROMISE ONLY WHAT A PLACE CAN OPEN: a journal entry (R-journal) and
  // a trashed note count into no notebook and no tag.
  const visible = useMemo(
    () =>
      new Set(
        built.flatMap((note) =>
          note.trashed || journalNoteIds.has(note.rawId) ? [] : [note.rawId]
        )
      ),
    [built, journalNoteIds]
  );
  return {
    journalNoteIds,
    notes: built,
    visibleNoteIds: visible,
    notebooks: useMemo(
      () =>
        projectNotebooks({
          collections: collections.rows,
          entries: placements.rows,
          visible,
        }),
      [collections.rows, placements.rows, visible]
    ),
    tagShelves: useMemo(
      () =>
        projectTagShelves({
          tags: tags.rows,
          concepts: concepts.rows,
          visible,
        }),
      [concepts.rows, tags.rows, visible]
    ),
    chainRows: useMemo(() => ({ revisions: revisions.rows }), [revisions.rows]),
    ...combineReplicaQueryStates([
      notes,
      contents,
      links,
      anchors,
      revisions,
      schemes,
      concepts,
      tags,
      collections,
      placements,
    ]),
  };
}
