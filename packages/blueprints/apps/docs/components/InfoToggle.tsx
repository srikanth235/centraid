// THE RAIL TOGGLE — the info button on the toolbar row, beside `List`/`Grid`.
//
// The handoff draws it (`showInfoBtn` / `infoBtnAct` / `infoBtnStyle`), and it
// is the ONLY way the details rail opens at a desk: 34px square, an info
// glyph, on the LEADING side of the arrangement pair. Its `aria-pressed` is
// the whole control — the rail is a thing that is showing or not showing, not
// a thing you launch, so this is a toggle and never a "View details" verb.
//
// WHY THE RAIL HAS A SWITCH AT ALL, rather than only a row's kebab → Details:
// the rail is pinned open beside the set and follows whichever row is picked
// ("Everything here is about one row. Select another and the rail follows
// it"). A member comparing two documents' facts flips between rows; they do
// not open and close a drawer twice, and a modal drawer over a scrim would
// cover the set it is describing.
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
