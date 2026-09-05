import {
  definePendingProjection,
  pendingDelete,
  pendingInputValues,
  pendingPatch,
  pendingTombstone,
  pendingUpsert,
  stablePendingRowId,
} from "../_shared/pending-overlay.js";

const NOTE_FIELDS = ["title", "pinned", "notebook_id"] as const;

export const notesPendingProjection = definePendingProjection({
  appId: "notes",
  revisions: {
    "edit-note": ["create-note"],
    "move-note": ["create-note"],
    "rename-notebook": ["create-notebook"],
  },
  actions: {
    "create-note": ({ input, intentId }) => {
      // An id the write already carries is REUSED, never re-minted, so a
      // revision keeps the row it already showed (#922 G2).
      const noteId =
        typeof input.note_id === "string" && input.note_id.length > 0
          ? input.note_id
          : stablePendingRowId(intentId, "note");
      const contentId = stablePendingRowId(intentId, "body");
      return {
        // The id the projection minted rides the write (#922 G2).
        input: { note_id: noteId },
        optimistic: [
          pendingUpsert("knowledge.note", noteId, {
            note_id: noteId,
            body_content_id: contentId,
            pinned: 0,
            deleted_at: null,
            ...pendingInputValues(input, NOTE_FIELDS),
          }),
          pendingUpsert("core.content_item", contentId, {
            content_id: contentId,
            title:
              typeof input.title === "string" ? input.title : "Pending note",
            media_type: "text/markdown",
          }),
        ],
      };
    },
    "edit-note": ({ input }) =>
      pendingPatch("knowledge.note", input.note_id, input, NOTE_FIELDS),
    "move-note": ({ input }) =>
      pendingPatch("knowledge.note", input.note_id, input, ["notebook_id"]),
    "create-notebook": ({ input, intentId }) => {
      // An id the write already carries is REUSED, never re-minted, so a
      // revision keeps the row it already showed (#922 G2).
      const notebookId =
        typeof input.notebook_id === "string" && input.notebook_id.length > 0
          ? input.notebook_id
          : stablePendingRowId(intentId, "notebook");
      return {
        // The id the projection minted rides the write (#922 G2).
        input: { notebook_id: notebookId },
        optimistic: [
          pendingUpsert("core.collection", notebookId, {
            collection_id: notebookId,
            name:
              typeof input.name === "string" ? input.name : "Pending notebook",
            sort_order: 0,
          }),
        ],
      };
    },
    "rename-notebook": ({ input }) =>
      pendingPatch("core.collection", input.notebook_id, input, ["name"]),
    "delete-notebook": ({ input }) =>
      pendingDelete("core.collection", input.notebook_id),
    // `knowledge.delete_note` sets `deleted_at`; the note leaves the library
    // and the notebook at once instead of lingering with a badge.
    "delete-note": ({ input }) =>
      pendingTombstone("knowledge.note", input.note_id),
    "restore-note": ({ input }) =>
      pendingPatch("knowledge.note", input.note_id, input),
    "restore-note-version": ({ input }) =>
      pendingPatch("knowledge.note", input.note_id, input),
    link: ({ input }) => pendingPatch("knowledge.note", input.note_id, input),
    attach: ({ input }) =>
      pendingPatch("knowledge.note", input.subject_id, input),
    detach: {
      excluded: true,
      reason: "The attachment id does not identify its note row.",
    },
    "add-tag": ({ input }) =>
      pendingPatch("knowledge.note", input.note_id, input),
    "remove-tag": {
      excluded: true,
      reason: "The tag id does not identify its note row.",
    },
    // The row this action mints belongs to Tasks and its id is minted at the
    // vault, so there is no Notes row to hang a pending chip on. Excluded, not
    // missing.
    "send-to-tasks": {
      excluded: true,
      reason: "Tasks owns the task this mints; Notes keeps no copy to project.",
    },
  },
});
