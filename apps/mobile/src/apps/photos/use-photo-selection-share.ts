// Photos share handler for all four shelves (#825): one grant-kit sheet over a single photo; refuses multi-photo/cross-vault selections.

import type { SelectionHandler } from "@centraid/blueprints/apps/_shared/selection-engine";
import { ONE_AT_A_TIME } from "@centraid/blueprints/apps/photos/grant-audiences";

import { postStatus } from "../../kit/components/status-line";
import type { GrantSheetProps } from "../../kit/share/GrantSheet";
import { usePhotoGrantEntry } from "./photo-grants";
import type { VaultAsset } from "./photos-selection-writes";

export interface PhotoSelectionShare {
  handler: SelectionHandler;
  copyLabel: string;
  visible: boolean;
  dismiss: () => void;
  sheetProps: Omit<GrantSheetProps, "visible" | "onClose">;
}

export function usePhotoSelectionShare(
  selected: () => readonly VaultAsset[],
  onDone: () => void
): PhotoSelectionShare {
  const share = usePhotoGrantEntry(postStatus);
  const targets = selected();
  const only = targets.length === 1 ? targets[0] : undefined;

  const handler: SelectionHandler = only
    ? { run: share.request }
    : { unavailableReason: ONE_AT_A_TIME };

  return {
    handler,
    copyLabel: "Share",
    visible: share.visible,
    dismiss: share.dismiss,
    sheetProps: {
      audiences: share.audiences,
      // OBJECT-FIRST: handler refuses first; no empty id reaches the door.
      subject: { subjectType: "media.asset", subjectId: only?.assetId ?? "" },
      onStatus: (message) => {
        postStatus(message);
        onDone();
      },
    },
  };
}
