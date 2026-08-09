// *Share*, as ONE selection-bar handler (issue #726 P6).
//
// Four Photos shelves carry the same third target — the library's state
// views, an album, the duplicates shelf and its review — and wiring them one
// at a time would be four chances for the refusal grammar, the picker moment
// and the share call to drift apart, which is the defect `photos-selection.ts`
// exists to prevent one level up.
//
// REPLACES the P0 sole-destination shortcut this file used to implement
// directly (a live control that placed straight into the one other writable
// vault, or opened `CopyToVaultPicker` when several existed). The control now
// ALWAYS opens `kit/share/ShareSheet.tsx` — ONE destination list holding both
// the member's own other vaults and every linked person (issue #726 P6) — so
// a household with a linked person and no second OWNED vault is no longer
// told there is "nowhere to copy to". The batch write itself is unchanged:
// `batchCopyToVault` already uses the real `/edges` door (`session.place`),
// so `ShareSheet`'s `giveMany` override reuses it rather than looping
// per-item calls the tested batch helper already does better (progress text,
// concurrency via `runSelectionBatch`).

import { useCallback, useState } from "react";

import type { SelectionHandler } from "@centraid/blueprints/apps/_shared/selection-engine";

import { postStatus } from "../../kit/components/status-line";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { surfaceWriteFailure } from "../../kit/replica/write-outcome";
import type { ShareSheetProps } from "../../kit/share/ShareSheet";
import {
  batchCopyToVault,
  copyOutcomeMessage,
} from "./photos-selection-writes";
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

  const giveMany = useCallback(
    async (destination: {
      vaultId: string;
      label: string;
    }): Promise<{ ok: boolean; message: string }> => {
      if (!session)
        return { ok: false, message: "Not connected to a gateway." };
      try {
        const outcome = await batchCopyToVault(
          session,
          selected(),
          destination.vaultId,
          vaultId
        );
        onDone();
        return {
          ok: outcome.refused.length === 0,
          message: copyOutcomeMessage(outcome, destination.label),
        };
      } catch (error) {
        surfaceWriteFailure(error, `Photos not given to ${destination.label}`);
        return {
          ok: false,
          message: `Photos not given to ${destination.label}.`,
        };
      }
    },
    [onDone, selected, session, vaultId]
  );

  const handler: SelectionHandler = session
    ? { run: () => setPicking(true) }
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
      sourceVaultId: vaultId ?? "",
      noun: "Photos",
      verbs: ["give"],
      itemType: "media.media_asset",
      giveMany,
      // `ShareSheet` closes itself (calls `onClose`/`dismiss`) right after
      // this fires — only the status line is this hook's to post.
      onDone: (outcome) => postStatus(outcome.message),
    },
  };
}
