// The row's ONE state slot (Docs spec §4.1) — the rendering half of
// `rowStateMark` (view-copy.ts).
//
// "The state slot shows AT MOST ONE thing, in this order." (§4.1, verbatim.)
// The ladder itself is a pure function in view-copy.ts; this component is the
// DOM for whatever that function returned and holds no rule of its own. That
// split is deliberate: expressed inline, three of those conditions could be
// true at once, and a row would carry three marks.
//
// "Never a sentence on a row: the caption under the set carries the prose,
// once." (§4.1, verbatim.) So the last rung renders as a GLYPH with a real —
// visually hidden — name, never as text; the same idiom `Shared.tsx`'s
// `CustodyDot` uses, and for the same reason: an `aria-label` on a faked
// `role="img"` announces the same thing while inventing a role.
import type { ReactNode } from "react";

import { canRender } from "../format.ts";
import type { DriveDoc } from "../types.ts";
import { rowStateMark } from "../view-copy.ts";
import type { RowStateInput } from "../view-copy.ts";

import styles from "./RowStateSlot.module.css";

/**
 * What THIS drive can honestly say about a row. Every field is read from the
 * projection or from a state the app already holds — nothing here is a guess:
 *
 *  * `cannotRender` — the kind table (§10.1), via `format.canRender`;
 *  * `inTrash`/`purgeInDays` — the row's own purge date;
 *  * `offline`/`bytesOnDevice` — `libraryReachability` plus blob custody;
 *  * `deviceOnly` — `custody_state`, the one custody state a member can lose
 *    something to.
 */
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
  /**
   * What stands in the slot when the ladder has nothing to say. The one thing
   * that ever goes here is the custody dot's own exception mark ("missing —
   * needs attention"), which the ladder has no rung for: it is a fact about
   * BYTES rather than about what opening the row would do. It renders only in
   * the ladder's silence, so the slot still shows at most one thing.
   */
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
