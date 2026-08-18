import {
  definePendingProjection,
  pendingPatch,
  pendingUpsert,
  stablePendingRowId,
} from "../_shared/pending-overlay.js";

const asset = (input: Readonly<Record<string, unknown>>) =>
  pendingPatch("media.asset", input.asset_id, input, [
    "title",
    "captured_at",
    "favorite",
    "archived",
  ]);
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
    "delete-asset": ({ input }) => asset(input),
    restore: ({ input }) => asset(input),
    "purge-asset": ({ input }) => asset(input),
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
    "delete-album": ({ input }) => album(input),
    "restore-album": ({ input }) => album(input),
    // Membership is a relation, but its visible anchor is the photograph.
    // Keep that anchor on-screen until canonical collection_entry settlement.
    "add-to-album": ({ input }) =>
      pendingPatch("media.asset", input.asset_id, input),
    "remove-from-album": ({ input }) =>
      pendingPatch("media.asset", input.asset_id, input),
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

export default photosPendingProjection;
