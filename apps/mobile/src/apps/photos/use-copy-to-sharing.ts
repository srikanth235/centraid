// *Copy to Sharing*, as ONE selection-bar handler (issue #712, A3/A5).
//
// Four Photos shelves carry the same third target — the library's state views,
// an album, the duplicates shelf and its review — and before this pass all four
// passed the same constant, `NO_SHARE_DESTINATION_REASON`, into a permanently
// disabled control. Wiring them one at a time would have been four chances for
// the refusal grammar, the picker moment and the placement call to drift apart,
// which is the defect `photos-selection.ts` exists to prevent one level up.
//
// So the whole behaviour is here, once:
//
//   * pointer resolves     → a live control that places `media.media_asset`
//                            into the target and reports determinate counts.
//   * pointer unset, but
//     candidates exist     → a live control that opens the FIRST-SHARE PICKER
//                            (A3) at the moment of intent, writes the pointer,
//                            and then places. Never a disabled control that
//                            sends the member to Settings for a preference.
//   * nowhere at all       → disabled, carrying `kit/share`'s sentence
//                            verbatim (either "There is nowhere to share to on
//                            this device yet." or "Where your shares go isn't
//                            open on this device.").
//
// The picker itself is the frame's (`kit/share/ShareTargetPicker.tsx`) because
// the pointer is the frame's; this hook only decides when it is asked for.

import { useCallback, useState } from "react";

import { postStatus } from "../../kit/components/status-line";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { surfaceWriteFailure } from "../../kit/replica/write-outcome";
import { useShareTarget } from "../../kit/share/use-share-target";
import type { ShareTargetCandidate } from "../../kit/share/use-share-target";
import type { SelectionHandler } from "./photos-selection";
import {
  batchCopyToSharing,
  sharingOutcomeMessage,
} from "./photos-selection-writes";
import type { VaultAsset } from "./photos-selection-writes";

export interface CopyToSharing {
  /** Hand straight to `PhotosSelectionProps.share`. */
  handler: SelectionHandler;
  /** True while the first-share picker should be on screen. */
  picking: boolean;
  candidates: readonly ShareTargetCandidate[];
  choose: (vaultId: string) => void;
  dismiss: () => void;
}

export function useCopyToSharing(
  /** Resolved lazily: the selection at the moment the target is pressed. */
  selected: () => readonly VaultAsset[],
  onDone: () => void
): CopyToSharing {
  const { session, vaultId } = useReplica();
  const target = useShareTarget();
  const [picking, setPicking] = useState(false);

  const run = useCallback(
    (destination: ShareTargetCandidate): void => {
      if (!session) return;
      void batchCopyToSharing(session, selected(), destination.vaultId, vaultId)
        .then((outcome) => {
          postStatus(sharingOutcomeMessage(outcome, destination.label));
          onDone();
        })
        .catch((error: unknown) =>
          surfaceWriteFailure(error, "Photos not copied into Sharing")
        );
    },
    [onDone, selected, session, vaultId]
  );

  const choose = useCallback(
    (chosenVaultId: string): void => {
      const candidate = target.candidates.find(
        (entry) => entry.vaultId === chosenVaultId
      );
      setPicking(false);
      if (!candidate) return;
      // Persist FIRST, then place: the member answered "where do my shares go",
      // and that answer outlives this one share whether or not the placement
      // lands.
      target.choose(chosenVaultId);
      run(candidate);
    },
    [run, target]
  );

  const handler: SelectionHandler = session
    ? target.reason
      ? { unavailableReason: target.reason }
      : target.target
        ? { run: () => run(target.target!) }
        : target.hydrated
          ? { run: () => setPicking(true) }
          : // The pointer has not been read yet. Not a refusal — a moment.
            { unavailableReason: "Reading where your shares go…" }
    : {
        unavailableReason:
          "Not connected to a gateway, so nothing can be shared from here.",
      };

  return {
    handler,
    picking,
    candidates: target.candidates,
    choose,
    dismiss: () => setPicking(false),
  };
}
