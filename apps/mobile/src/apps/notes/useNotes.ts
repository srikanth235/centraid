import { useMemo } from "react";

import {
  JOURNAL_ENTRY_NOTATION,
  JOURNAL_SCHEME_URI,
} from "@centraid/blueprints/apps/_shared/journal-scheme";
import {
  projectNotebooks,
  projectTagShelves,
} from "@centraid/blueprints/apps/notes/filing";

import {
  combineReplicaQueryStates,
  useReplicaQuery,
} from "../../kit/hooks/useReplicaQuery";
import { buildNotes } from "./notes-model";

export function useNotes() {
  const notes = useReplicaQuery(
    "notes",
    useMemo(() => ({ entity: "knowledge.note" }), [])
  );
  const bodyIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of notes.rows) {
      if (typeof row.body_content_id === "string" && row.body_content_id) {
        ids.add(row.body_content_id);
      }
    }
    return [...ids];
  }, [notes.rows]);
  const contents = useReplicaQuery(
    "notes",
    useMemo(
      () =>
        bodyIds.length === 0
          ? {
              entity: "core.content_item",
              where: [{ column: "content_id", op: "eq", value: "__none__" }],
              limit: 1,
            }
          : {
              entity: "core.content_item",
              where: [{ column: "content_id", op: "in", value: bodyIds }],
              limit: Math.max(bodyIds.length, 1),
            },
      [bodyIds]
    )
  );
  const links = useReplicaQuery(
    "notes",
    useMemo(() => ({ entity: "core.link" }), [])
  );
  const anchors = useReplicaQuery(
    "notes",
    useMemo(() => ({ entity: "core.link_anchor" }), [])
  );
  const schemes = useReplicaQuery(
    "notes",
    useMemo(() => ({ entity: "core.concept_scheme" }), [])
  );
  const concepts = useReplicaQuery(
    "notes",
    useMemo(() => ({ entity: "core.concept" }), [])
  );
  const tags = useReplicaQuery(
    "notes",
    useMemo(() => ({ entity: "core.tag" }), [])
  );
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
  const collections = useReplicaQuery(
    "notes",
    useMemo(() => ({ entity: "core.collection" }), [])
  );
  const placements = useReplicaQuery(
    "notes",
    useMemo(
      () => ({
        entity: "core.collection_entry",
        where: [{ column: "target_type", op: "eq", value: "knowledge.note" }],
      }),
      []
    )
  );
  const built = useMemo(
    () => buildNotes(notes.rows, contents.rows, links.rows, anchors.rows),
    [anchors.rows, contents.rows, links.rows, notes.rows]
  );
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
    chainRows: useMemo(
      () => ({
        links: links.rows,
        concepts: concepts.rows,
        schemes: schemes.rows,
      }),
      [concepts.rows, links.rows, schemes.rows]
    ),
    ...combineReplicaQueryStates([
      notes,
      contents,
      links,
      anchors,
      schemes,
      concepts,
      tags,
      collections,
      placements,
    ]),
  };
}
