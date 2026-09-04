import {
  definePendingProjection,
  pendingDelete,
  pendingPatch,
  pendingTombstone,
  pendingUpsert,
  stablePendingRowId,
} from "../_shared/pending-overlay.js";

export const docsPendingProjection = definePendingProjection({
  appId: "docs",
  revisions: {
    rename: ["upload"],
    edit: ["upload"],
    replace: ["upload"],
    "rename-folder": ["create-folder"],
  },
  actions: {
    upload: ({ input, intentId }) => {
      const documentId = stablePendingRowId(intentId, "document");
      const contentId = stablePendingRowId(intentId, "content");
      return [
        pendingUpsert("core.document", documentId, {
          document_id: documentId,
          current_content_id: contentId,
          title:
            typeof input.title === "string" ? input.title : "Pending document",
          deleted_at: null,
        }),
        pendingUpsert("core.content_item", contentId, {
          content_id: contentId,
          title:
            typeof input.title === "string" ? input.title : "Pending document",
          media_type: "application/octet-stream",
        }),
      ];
    },
    rename: ({ input }) =>
      pendingPatch("core.document", input.document_id, input, ["title"]),
    move: ({ input }) =>
      pendingPatch("core.document", input.document_id, input),
    // `core.trash_document` sets `deleted_at`; the overlay stamps it so the
    // document leaves every list the moment the member taps trash.
    trash: ({ input }) => pendingTombstone("core.document", input.document_id),
    restore: ({ input }) =>
      pendingPatch("core.document", input.document_id, input),
    star: ({ input }) =>
      pendingPatch("core.document", input.document_id, input),
    unstar: ({ input }) =>
      pendingPatch("core.document", input.document_id, input),
    tag: ({ input }) => pendingPatch("core.document", input.document_id, input),
    untag: {
      excluded: true,
      reason: "The tag id does not identify its document row.",
    },
    edit: ({ input }) =>
      pendingPatch("core.document", input.document_id, input, ["title"]),
    replace: ({ input }) =>
      pendingPatch("core.document", input.document_id, input, ["title"]),
    "restore-version": ({ input }) =>
      pendingPatch("core.document", input.document_id, input),
    "create-folder": ({ input, intentId }) => {
      const folderId = stablePendingRowId(intentId, "folder");
      return [
        pendingUpsert("core.concept", folderId, {
          concept_id: folderId,
          pref_label:
            typeof input.name === "string" ? input.name : "Pending folder",
        }),
      ];
    },
    "rename-folder": ({ input }) =>
      pendingPatch(
        "core.concept",
        input.folder_id,
        { pref_label: input.name },
        ["pref_label"]
      ),
    "delete-folder": ({ input }) =>
      pendingDelete("core.concept", input.folder_id),
  },
});
