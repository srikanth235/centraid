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
      // An id the write already carries is REUSED, never re-minted, so a
      // revision keeps the row it already showed (#922 G2).
      const documentId =
        typeof input.document_id === "string" && input.document_id.length > 0
          ? input.document_id
          : stablePendingRowId(intentId, "document");
      const contentId = stablePendingRowId(intentId, "content");
      return {
        // The id the projection minted rides the write (#922 G2).
        input: { document_id: documentId },
        optimistic: [
          pendingUpsert("core.document", documentId, {
            document_id: documentId,
            current_content_id: contentId,
            title:
              typeof input.title === "string"
                ? input.title
                : "Pending document",
            deleted_at: null,
          }),
          pendingUpsert("core.content_item", contentId, {
            content_id: contentId,
            title:
              typeof input.title === "string"
                ? input.title
                : "Pending document",
            media_type: "application/octet-stream",
          }),
        ],
      };
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
      // An id the write already carries is REUSED, never re-minted, so a
      // revision keeps the row it already showed (#922 G2).
      const folderId =
        typeof input.folder_id === "string" && input.folder_id.length > 0
          ? input.folder_id
          : stablePendingRowId(intentId, "folder");
      return {
        // The id the projection minted rides the write (#922 G2).
        input: { folder_id: folderId },
        optimistic: [
          pendingUpsert("core.concept", folderId, {
            concept_id: folderId,
            pref_label:
              typeof input.name === "string" ? input.name : "Pending folder",
          }),
        ],
      };
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
