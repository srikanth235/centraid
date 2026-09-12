// The viewer bottom row's enabled/reason table (#1015 B10). Its own module
// because `viewer-model.ts` is at its line ceiling, and because this is the
// one contract the row is judged on.

import type { ViewerActionId } from "./viewer-model";
import { viewerWriteRefusal } from "./viewer-model";

/**
 * THE BOTTOM ROW'S ENABLED/REASON TABLE, as data (#1015 B10).
 *
 * Every one of the five is either live or visibly refused with a reason: the
 * toolbar used to render all five identically, so four of them looked armed
 * and silently did nothing. Held here rather than in the component so the
 * contract — "no action is enabled without being able to run, and none is
 * disabled without a reason" — is assertable without a renderer.
 */
export interface ViewerToolbarState {
  enabled: boolean;
  /** Why it refuses. Always present when `enabled` is false. */
  reason?: string;
}

export function viewerToolbarStates(input: {
  writable: boolean;
  hasVaultAsset: boolean;
  /** Crop/rotate are raster on a still; a video has no non-destructive editor. */
  editable: boolean;
  /** A commons item this member has not kept yet — the only thing Copy copies. */
  canSaveToMyVault: boolean;
  /** The viewer only offers Edit where the caller handed it one. */
  hasEditor: boolean;
}): Record<ViewerActionId, ViewerToolbarState> {
  const refusal = viewerWriteRefusal(input);
  const writable = refusal === undefined;
  const editEnabled = writable && input.editable && input.hasEditor;
  return {
    copy: input.canSaveToMyVault
      ? { enabled: true }
      : { enabled: false, reason: "This photograph is already yours" },
    edit: editEnabled
      ? { enabled: true }
      : {
          enabled: false,
          reason: writable
            ? input.editable
              ? "There is no editor for this photograph here"
              : "Crop and rotate work on photographs, not on this kind of media"
            : refusal,
        },
    favorite: writable
      ? { enabled: true }
      : { enabled: false, reason: refusal },
    info: { enabled: true },
    trash: writable ? { enabled: true } : { enabled: false, reason: refusal },
  };
}
