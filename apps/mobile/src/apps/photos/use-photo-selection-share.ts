// *Share*, as ONE selection-bar handler (#825).
//
// Four Photos shelves carry the same third target — the library's state views,
// an album, the duplicates shelf and its review — and wiring them one at a
// time would be four chances for the refusal grammar, the picker moment and
// the share call to drift apart.
//
// The control opens the ONE grant kit (`kit/share/GrantSheet.tsx`) over the
// selected photograph as a standing `media.asset` grant. Photos does not
// assemble a destination list, name a source vault, or reach the replica
// session to place a batch of items — the door, the capability verbs and
// every sentence belong to the kit.
//
// TWO REFUSALS ARE THIS FILE'S OWN, and both are honest rather than silent:
// a selection from more than one photograph (a grant stands over one subject —
// an album is how many photographs travel together), and a selection spanning
// two vaults, which was never one subject either.

import type { SelectionHandler } from "@centraid/blueprints/apps/_shared/selection-engine";
import { ONE_AT_A_TIME } from "@centraid/blueprints/apps/photos/grant-audiences";

import { postStatus } from "../../kit/components/status-line";
import type { GrantSheetProps } from "../../kit/share/GrantSheet";
import { usePhotoGrantEntry } from "./photo-grants";
import type { VaultAsset } from "./photos-selection-writes";

export interface PhotoSelectionShare {
  /** Hand straight to `PhotosSelectionProps.share`. */
  handler: SelectionHandler;
  /** The control's caption. The sheet is what asks who, not the control. */
  copyLabel: string;
  /** True while the grant sheet should be on screen. */
  visible: boolean;
  dismiss: () => void;
  /** Spread onto `<GrantSheet visible={visible} onClose={dismiss} {...sheetProps} />`. */
  sheetProps: Omit<GrantSheetProps, "visible" | "onClose">;
}

export function usePhotoSelectionShare(
  /** Resolved lazily: the selection at the moment the target is pressed. */
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
      // OBJECT-FIRST: the sheet is opened over this one photograph. An empty
      // id never reaches the door — the handler above refuses first.
      subject: { subjectType: "media.asset", subjectId: only?.assetId ?? "" },
      onStatus: (message) => {
        postStatus(message);
        onDone();
      },
    },
  };
}
