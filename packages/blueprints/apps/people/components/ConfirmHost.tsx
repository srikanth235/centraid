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
  subjectName: string | null;
  sourceName: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  if (!confirm || !subjectName) return null;
  const merging = confirm.kind === "merge";
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
