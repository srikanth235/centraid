// Photos' pending-write projection (issue #738) — pure config, scope-kit
// style, consumed by `createPendingOverlayModel` in outcomes.ts. Record-only,
// single-item writes whose entity/columns the client already knows without an
// extra read: `media.media_asset`'s own favorite/archived/captured_at/
// deleted_at/purge_at columns (issue #419 moved favorite off a core.tag
// mirror onto a plain column, so — unlike People's/Docs' stars — this one has
// no missing-concept-id gap).
//
// Deliberately undeclared:
//   - `title` (update-asset's caption field) lives on core.content_item,
//     keyed by the asset's current_content_id — a second entity this
//     declaration would need threaded through for one rarely-batched field.
//   - `purge-asset` is permanent and irreversible (no undo grammar anywhere
//     in trash-actions.ts); it reads honestly only as a live round trip.
//   - `add-to-album`/`remove-from-album` mint/target a core.collection_entry
//     row whose id and running-order `position` are server-computed
//     (addToAlbum's `MAX(position)+1`) and whose scope can differ from the
//     asset's own (issue #599: "Albums live in the member's own scope") —
//     disproportionate per-item wiring for what the brief scopes as optional;
//     the batch runners stay as-is.
//   - face/place/tag actions and every upload path: none are the
//     favorite/trash record-shaped writes this pass targets.
import type { PendingProjectionDeclaration } from "../_shared/pending-overlay.ts";

function stringField(
  input: Record<string, unknown>,
  key: string
): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

export const photosPendingProjection: PendingProjectionDeclaration = {
  appId: "photos",
  actions: {
    // media.update_asset's own field-by-field UPDATE (packages/vault/src/
    // commands/media.ts): only the columns present move. `favorite`/
    // `archived` arrive as 0/1 integers (both toggleFavorite and
    // runBatchFavorite send `favorite` this way already); `archived` maps
    // onto the timestamp column the same way the command does.
    "update-asset"(input) {
      const assetId = stringField(input, "asset_id");
      if (!assetId) return [];
      const values: Record<string, unknown> = {};
      if (typeof input.favorite === "number") values.favorite = input.favorite;
      if (typeof input.captured_at === "string")
        values.captured_at = input.captured_at;
      if (typeof input.archived === "number") {
        values.archived_at =
          input.archived === 1 ? new Date().toISOString() : null;
      }
      if (Object.keys(values).length === 0) return [];
      return [
        {
          op: "upsert",
          entity: "media.media_asset",
          rowId: assetId,
          values,
        },
      ];
    },

    // media.delete_asset/restore_asset flip the standard soft-delete pair.
    // The real purge_at is a settlement detail (~30 days out); clearing it
    // to null on restore is exact either way.
    "delete-asset"(input) {
      const assetId = stringField(input, "asset_id");
      if (!assetId) return [];
      return [
        {
          op: "upsert",
          entity: "media.media_asset",
          rowId: assetId,
          values: { deleted_at: new Date().toISOString() },
        },
      ];
    },
    restore(input) {
      const assetId = stringField(input, "asset_id");
      if (!assetId) return [];
      return [
        {
          op: "upsert",
          entity: "media.media_asset",
          rowId: assetId,
          values: { deleted_at: null, purge_at: null },
        },
      ];
    },
  },
};
