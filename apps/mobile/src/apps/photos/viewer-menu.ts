import { photosArchiveVerb } from "@centraid/blueprints/apps/photos/shared-copy";

import type { MenuGroup } from "../../kit/components/AnchoredMenu";
import { READ_ONLY_VAULT_REASON } from "./viewer-model";

export const NOT_IN_A_VAULT_YET_REASON =
  "This photograph is not in a vault yet.";

function writeRefusalReason(input: {
  writable: boolean;
  hasVaultAsset: boolean;
}): string | undefined {
  if (!input.writable) return READ_ONLY_VAULT_REASON;
  if (!input.hasVaultAsset) return NOT_IN_A_VAULT_YET_REASON;
  return undefined;
}

export interface ViewerOverflowMenuInput {
  writable: boolean;
  hasVaultAsset: boolean;
  archived: boolean;
  albums: readonly { id: string; label: string }[];
  onSlideshow: () => void;
  onAddToAlbum: () => void;
  onMakeKeyPhoto: () => void;
  onAdjustLocation: () => void;
  onHide: () => void;
  onDownload: () => void;
  onSendCopy: () => void;
  onDelete: () => void;
}

export function viewerOverflowMenuGroups(
  input: ViewerOverflowMenuInput
): MenuGroup[] {
  const addToAlbumReason = writeRefusalReason(input);
  const canAddToAlbum = addToAlbumReason === undefined;
  const hideReason = writeRefusalReason(input);
  const canHide = hideReason === undefined;
  const archiveVerb = photosArchiveVerb(input.archived);
  const makeKeyPhotoReason = writeRefusalReason(input);
  const canMakeKeyPhoto = makeKeyPhotoReason === undefined;

  return [
    {
      key: "mode",
      rows: [
        {
          key: "hide",
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
          label: canAddToAlbum
            ? "Add to Album"
            : `Add to Album — ${addToAlbumReason}`,
          icon: "FolderPlus",
          disabled: !canAddToAlbum,
          onSelect: input.onAddToAlbum,
        },
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
          label: "Adjust Location",
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
