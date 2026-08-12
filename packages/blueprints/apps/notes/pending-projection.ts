import {
  definePendingProjection,
  pendingInputValues,
  pendingPatch,
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
      const noteId = stablePendingRowId(intentId, "note");
      const contentId = stablePendingRowId(intentId, "body");
      return [
        pendingUpsert("knowledge.note", noteId, {
          note_id: noteId,
          body_content_id: contentId,
          pinned: 0,
          deleted_at: null,
          ...pendingInputValues(input, NOTE_FIELDS),
        }),
        pendingUpsert("core.content_item", contentId, {
          content_id: contentId,
          title: typeof input.title === "string" ? input.title : "Pending note",
          media_type: "text/markdown",
        }),
      ];
    },
    "edit-note": ({ input }) =>
      pendingPatch("knowledge.note", input.note_id, input, NOTE_FIELDS),
    "move-note": ({ input }) =>
      pendingPatch("knowledge.note", input.note_id, input, ["notebook_id"]),
    "create-notebook": ({ input, intentId }) => {
      const notebookId = stablePendingRowId(intentId, "notebook");
      return [
        pendingUpsert("core.collection", notebookId, {
          collection_id: notebookId,
          name:
            typeof input.name === "string" ? input.name : "Pending notebook",
          sort_order: 0,
        }),
      ];
    },
    "rename-notebook": ({ input }) =>
      pendingPatch("core.collection", input.notebook_id, input, ["name"]),
    "delete-notebook": ({ input }) =>
      pendingPatch("core.collection", input.notebook_id, input),
    "delete-note": ({ input }) =>
      pendingPatch("knowledge.note", input.note_id, input),
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
  },
});

export default notesPendingProjection;
