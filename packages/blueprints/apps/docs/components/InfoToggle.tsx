// THE RAIL TOGGLE — the info button on the toolbar row, beside `List`/`Grid`.
//
// The handoff draws it (`showInfoBtn` / `infoBtnAct` / `infoBtnStyle`), and it
// is the ONLY way the details rail opens at a desk: 34px square, an info
// glyph, on the LEADING side of the arrangement pair. Its `aria-pressed` is
// the whole control — the rail is a thing that is showing or not showing, not
// a thing you launch, so this is a toggle and never a "View details" verb.
//
// WHY IT MATTERS THAT THE RAIL HAS A SWITCH AT ALL. Before this, the details
// rail existed but had exactly one door: a row's kebab → Details. That made
// the facts about a document something a member had to go and fetch, one row
// at a time, through a menu — and it opened as a MODAL drawer over a scrim,
// so the set it was describing was covered by the description. The handoff's
// rail is the opposite thing: pinned open beside the set, following whichever
// row is picked ("Everything here is about one row. Select another and the
// rail follows it"). A member who wants to compare two documents' facts flips
// between rows; they do not open and close a drawer twice.
//
// The handoff withholds it on the compact form factor (`showInfoBtn: !mob`)
// and while a set is picked (`&& !sel`): there is no width for a 308px column
// beside the set on a phone, and while the toolbar is carrying the selection
// bar this slot is not the arrangement slot at all.
import type { ReactNode } from "react";

import { I } from "../icons.ts";
import { Icon } from "./Shared.tsx";

import styles from "./InfoToggle.module.css";

export function InfoToggle({
  on,
  onToggle,
}: {
  /** The rail is showing. */
  on: boolean;
  onToggle: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className={styles.info}
      // "Details" is what the rail is called in its own head and in the row
      // menu that also opens it. One name for one surface.
      aria-label="Details"
      aria-pressed={on}
      onClick={onToggle}
    >
      <Icon svg={I.info!} />
    </button>
  );
}
