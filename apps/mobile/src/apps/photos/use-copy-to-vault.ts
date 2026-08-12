// *Share*, as ONE selection-bar handler (issue #726 P6).
//
// Four Photos shelves carry the same third target — the library's state
// views, an album, the duplicates shelf and its review — and wiring them one
// at a time would be four chances for the refusal grammar, the picker moment
// and the share call to drift apart, which is the defect `photos-selection.ts`
// exists to prevent one level up.
//
// The control always opens the Commons ShareSheet: one destination list holds
// people, invitations, and deliberate reusable named circles. The sheet sends
// the selected assets as real `media.asset` containers; there is no
// Photos-only copy override or silent legacy batch path.

import { useState } from "react";

import type { SelectionHandler } from "@centraid/blueprints/apps/_shared/selection-engine";

import { postStatus } from "../../kit/components/status-line";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import type { ShareSheetProps } from "../../kit/share/ShareSheet";
import type { VaultAsset } from "./photos-selection-writes";

export interface CopyToVault {
  /** Hand straight to `PhotosSelectionProps.share`. */
  handler: SelectionHandler;
  /** The control's caption. Static now — the sheet is what asks which
   *  destination, not the control (issue #726 P6). */
  copyLabel: string;
  /** True while the share sheet should be on screen. */
  picking: boolean;
  dismiss: () => void;
  /** Spread onto `<ShareSheet visible={picking} onClose={dismiss} {...sheetProps} />`. */
  sheetProps: Omit<ShareSheetProps, "visible" | "onClose">;
}

export function useCopyToVault(
  /** Resolved lazily: the selection at the moment the target is pressed. */
  selected: () => readonly VaultAsset[],
  onDone: () => void
): CopyToVault {
  const { session, vaultId } = useReplica();
  const [picking, setPicking] = useState(false);
  const targets = selected();
  const sourceVaultId = targets[0]?.sourceVaultId ?? vaultId ?? "";
  const hasMixedSources = targets.some(
    (asset) => (asset.sourceVaultId ?? vaultId ?? "") !== sourceVaultId
  );

  const handler: SelectionHandler = session
    ? hasMixedSources
      ? {
          unavailableReason:
            "Select photos from one vault at a time before sharing.",
        }
      : { run: () => setPicking(true) }
    : {
        unavailableReason:
          "Not connected to a gateway, so nothing can be shared from here.",
      };

  return {
    handler,
    copyLabel: "Share",
    picking,
    dismiss: () => setPicking(false),
    sheetProps: {
      sourceVaultId,
      noun: "Photos",
      itemType: "media.asset",
      itemIds: targets.map((asset) => asset.assetId),
      onDone: (outcome) => {
        postStatus(outcome.message);
        if (outcome.ok) onDone();
      },
    },
  };
}
