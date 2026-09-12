// The viewer's `···` — the anchored menu behind the chip (#712). An ANCHORED
// POPOVER, never a bottom sheet (`kit/components/AnchoredMenu.tsx`). Data only,
// so the row set and its refusals can be asserted without a renderer.
//
// THE OMISSIONS ARE CHECKED CLAIMS, not oversights. Copy and Duplicate have no
// clipboard-image path and no duplicate-asset write; Adjust Date & Time has no
// write at all (`PhotoInfoSheet.tsx`'s capture time is a read-out). A row that
// opens onto nothing is a promise the code cannot keep.
//
// Adjust location OPENS the info sheet rather than growing a second place
// editor here — `PhotoInfoSheet.tsx` already owns place.
//
// Album pickers are the consumer's own SHEET (`PhotosChoiceSheet`, #1015 D4),
// NEVER a nested submenu: the kit's `MenuSubmenuRow` carries no `disabled`
// field, so a submenu row cannot state "this vault is read-only" the way an
// action row can.
//
// Delete is here AND on the toolbar chip, as it is on iOS. The safety is the
// confirm step behind it, never the row being hard to find.

import { photosArchiveVerb } from "@centraid/blueprints/apps/photos/shared-copy";

import type { MenuGroup } from "../../kit/components/AnchoredMenu";
import { viewerWriteRefusal } from "./viewer-model";

/** The refusal ladder every writing row here climbs lives in `viewer-model.ts`
 *  (`viewerWriteRefusal`), shared with the bottom toolbar and
 *  `PhotoLightbox.tsx`'s `writeReason`, so this menu's copy cannot drift. */
const writeRefusalReason = viewerWriteRefusal;

export interface ViewerOverflowMenuInput {
  /** `PhotoAsset.canWrite`, the same flag the bottom toolbar reads. */
  writable: boolean;
  hasVaultAsset: boolean;
  /** `PhotoAsset.archived` — which label the row shows, Archive or Unarchive. */
  archived: boolean;
  /** THIS photograph's own album memberships (#721). Empty ⇒ "Make key photo"
   *  is omitted entirely, never shown permanently disabled: a row with nothing
   *  behind it is left out, not faked. */
  albums: readonly { id: string; label: string }[];
  onSlideshow: () => void;
  onAddToAlbum: () => void;
  /** Takes no argument on purpose: WHICH album is a picker concern the consumer
   *  owns, never this pure module's. */
  onMakeKeyPhoto: () => void;
  onAdjustLocation: () => void;
  onHide: () => void;
  onDownload: () => void;
  onSendCopy: () => void;
  onDelete: () => void;
}

/**
 * iOS' OWN GROUP ORDER — the group boundaries are the menu's grammar, so a row
 * must sit in the same band it does on the phone a member came from:
 *
 *   Copy · Duplicate · Hide · Slideshow / Add to album /
 *   Adjust Date & Time · Adjust location / Delete
 *
 * with the rows this vault cannot honestly carry struck out, plus one group iOS
 * has no equivalent for: Download · Send a copy, because this vault's bytes can
 * live on a gateway. Delete stays last — nothing is placed under the
 * destructive row.
 */
export function viewerOverflowMenuGroups(
  input: ViewerOverflowMenuInput
): MenuGroup[] {
  const addToAlbumReason = writeRefusalReason(input);
  const canAddToAlbum = addToAlbumReason === undefined;
  const hideReason = writeRefusalReason(input);
  const canHide = hideReason === undefined;
  const archiveVerb = photosArchiveVerb(input.archived);
  // Same refusal ladder as Add to Album. Album MEMBERSHIP is a third gate —
  // not a write refusal, so it omits the row below rather than folding in.
  const makeKeyPhotoReason = writeRefusalReason(input);
  const canMakeKeyPhoto = makeKeyPhotoReason === undefined;

  return [
    {
      key: "mode",
      rows: [
        {
          key: "hide",
          // One text slot — refusal rides after an em dash, same as Add to album.
          label: canHide ? archiveVerb : `${archiveVerb} — ${hideReason}`,
          icon: "Archive",
          disabled: !canHide,
          onSelect: input.onHide,
        },
        {
          key: "slideshow",
          label: "Slideshow",
          icon: "Play",
          onSelect: input.onSlideshow,
        },
      ],
    },
    {
      key: "album",
      rows: [
        {
          key: "add-to-album",
          // `MenuActionRow` has exactly ONE text slot, so a refusal rides after
          // an em dash rather than becoming a second, shorter phrasing of the
          // read-only truth (the drift `READ_ONLY_VAULT_REASON` forbids).
          label: canAddToAlbum
            ? "Add to album"
            : `Add to album — ${addToAlbumReason}`,
          icon: "FolderPlus",
          disabled: !canAddToAlbum,
          onSelect: input.onAddToAlbum,
        },
        // Only when the photograph is in an album already — see `albums`.
        ...(input.albums.length
          ? [
              {
                key: "make-key-photo",
                label: canMakeKeyPhoto
                  ? "Make key photo"
                  : `Make key photo — ${makeKeyPhotoReason}`,
                icon: "Star",
                disabled: !canMakeKeyPhoto,
                onSelect: input.onMakeKeyPhoto,
              },
            ]
          : []),
      ],
    },
    {
      key: "adjust",
      rows: [
        {
          key: "adjust-location",
          label: "Adjust location",
          icon: "Pin",
          onSelect: input.onAdjustLocation,
        },
      ],
    },
    {
      key: "export",
      rows: [
        {
          key: "download",
          label: "Download",
          icon: "Download",
          onSelect: input.onDownload,
        },
        {
          key: "send-copy",
          label: "Send a copy",
          icon: "Send",
          onSelect: input.onSendCopy,
        },
      ],
    },
    {
      key: "destructive",
      rows: [
        {
          key: "delete",
          label: "Delete",
          icon: "trash-2",
          destructive: true,
          disabled: !canHide,
          onSelect: input.onDelete,
        },
      ],
    },
  ];
}
