// The row's ONE state slot (Docs spec §4.1): at most one thing, ladder order.
// Rules live in `rowStateMark`; this renders its verdict.
import type { ReactNode } from "react";

import { canRender } from "../format.ts";
import type { DriveDoc } from "../types.ts";
import { rowStateMark } from "../view-copy.ts";
import type { RowStateInput } from "../view-copy.ts";

import styles from "./RowStateSlot.module.css";

// Fields only from the projection or held state — never a guess.
export function rowStateFor(
  doc: DriveDoc,
  { trashed, offline }: { trashed: boolean; offline: boolean }
): RowStateInput {
  const purgeAt = doc.purge_at ? Date.parse(doc.purge_at) : Number.NaN;
  const purgeInDays = Number.isNaN(purgeAt)
    ? null
    : Math.max(0, Math.ceil((purgeAt - Date.now()) / 86_400_000));
  return {
    cannotRender: !canRender(doc),
    inTrash: trashed,
    purgeInDays,
    offline,
    bytesOnDevice:
      doc.custody_state === "local-only" || doc.custody_state === "replicated",
    deviceOnly: doc.custody_state === "local-only",
  };
}

export function RowStateSlot({
  input,
  fallback = null,
}: {
  input: RowStateInput;
  /** Renders only when the ladder says nothing. */
  fallback?: ReactNode;
}): ReactNode {
  const mark = rowStateMark(input);
  if (!mark) return fallback;
  if (mark.kind === "glyph") {
    return (
      <span className={styles.glyph} title={mark.text}>
        <svg
          aria-hidden="true"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="5" y="2.5" width="14" height="19" rx="2.5" />
          <path d="M10.5 18.5h3" />
        </svg>
        <span className="kit-sr-only">{mark.text}</span>
      </span>
    );
  }
  return (
    <span className={styles.slot} data-net={String(mark.net)}>
      {mark.text}
    </span>
  );
}
