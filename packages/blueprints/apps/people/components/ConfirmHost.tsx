// The two modal confirms, and the copy that goes with each.
//
// TWO, NOT THE HANDOFF'S THREE. Trash and Merge are modal because one is a
// disappearance the member must recognise and the other cannot be undone at
// all; the handoff's third — revoking a vault link — has nothing to revoke in
// this contract, so it is absent rather than stubbed.
//
// Everything else in the app reports on the status line with `Undo`, which is
// the rule this component is the exception to: a dialog is for an act whose
// reverse write does not exist.
import type { ReactNode } from "react";

import { CONFIRMS, VERBS } from "../people-copy.ts";
import type { ConfirmState } from "../types.ts";
import { ConfirmPanel } from "./Shared.tsx";

export function ConfirmHost({
  confirm,
  subjectName,
  sourceName,
  onCancel,
  onConfirm,
}: {
  confirm: ConfirmState | null;
  /** The person the act is about — the one being trashed, or the survivor. */
  subjectName: string | null;
  /** The duplicate being merged in, while the act is a merge. */
  sourceName: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  if (!confirm || !subjectName) return null;
  const merging = confirm.kind === "merge";
  // A merge with no duplicate picked has nothing to confirm, so the dialog
  // does not open rather than opening with a blank in its own title.
  if (merging && !sourceName) return null;
  return (
    <ConfirmPanel
      title={
        merging
          ? CONFIRMS.merge.title(sourceName ?? "", subjectName)
          : CONFIRMS.trash.title(subjectName)
      }
      body={merging ? CONFIRMS.merge.body : CONFIRMS.trash.body}
      verb={merging ? CONFIRMS.merge.verb : CONFIRMS.trash.verb}
      cancelLabel={VERBS.cancel}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
