import {
  definePendingProjection,
  pendingDelete,
  pendingPatch,
  pendingTombstone,
  pendingUpsert,
  stablePendingRowId,
} from "../_shared/pending-overlay.js";

// Only columns that live on `media.asset`. Caption `title` is on
// `core.content_item`; `archived` is the action input that the vault
// turns into `archived_at`. Projecting either onto the asset shape
// throws `Unknown column` in `prepareReplicaWrite` and aborts the
// durable write before the vault ever sees it.
const ASSET_FIELDS = ["captured_at", "favorite"] as const;
const asset = (input: Readonly<Record<string, unknown>>) =>
  pendingPatch("media.asset", input.asset_id, input, ASSET_FIELDS);
const album = (input: Readonly<Record<string, unknown>>) =>
  pendingPatch(
    "core.collection",
    input.album_id,
    { name: input.title ?? input.name },
    ["name"]
  );

export const photosPendingProjection = definePendingProjection({
  appId: "photos",
  revisions: {
    "rename-album": ["create-album"],
  },
  actions: {
    upload: {
      excluded: true,
      reason:
        "Photo byte custody and upload use the custody/transfer engine, not row overlay.",
    },
    "update-asset": ({ input }) => asset(input),
    // `media.delete_asset` sets `deleted_at`; `purge_asset` removes the row.
    "delete-asset": ({ input }) =>
      pendingTombstone("media.asset", input.asset_id),
    restore: ({ input }) => asset(input),
    "purge-asset": ({ input }) => pendingDelete("media.asset", input.asset_id),
    "create-album": ({ input, intentId }) => {
      const albumId = stablePendingRowId(intentId, "album");
      return [
        pendingUpsert("core.collection", albumId, {
          collection_id: albumId,
          name: typeof input.title === "string" ? input.title : "Pending album",
        }),
      ];
    },
    "rename-album": ({ input }) => album(input),
    "set-album-cover": ({ input }) => album(input),
    "delete-album": ({ input }) =>
      pendingDelete("core.collection", input.album_id),
    "restore-album": ({ input }) => album(input),
    // Membership is a relation, but its visible anchor is the photograph.
    // Keep that anchor on-screen until canonical collection_entry settlement.
    "add-to-album": ({ input }) =>
      pendingPatch("media.asset", input.asset_id, input),
    "remove-from-album": {
      excluded: true,
      reason:
        "The membership row is core.collection_entry, keyed by a surrogate entry_id the payload does not carry; the album and asset ids alone cannot address it.",
    },
    // Changing review_state optimistically would filter the only visible row
    // out of the queue. Project status onto it without guessing settlement.
    "answer-face": ({ input }) =>
      pendingPatch("media.face_region", input.region_id, input),
    "set-place": ({ input }) => asset(input),
    "name-place": {
      excluded: true,
      reason:
        "A name lands on the core.place row, not an asset; no tile or grid cell projects a pending place row, and every surface re-phrases from the row itself when the write settles.",
    },
    "tag-asset": ({ input }) => asset(input),
    "untag-asset": {
      excluded: true,
      reason: "The tag id does not identify its asset row.",
    },
    "request-enrichment": ({ input }) =>
      pendingPatch("media.asset", input.entity_id, input),
  },
});
