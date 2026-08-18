// The view pair — `List` / `Grid`, on the toolbar row above the shelf strip.
//
// THE HANDOFF DRAWS IT AS WORDS, not as two icon squares: `densBtns:
// [['list','List'],['grid','Grid']]` inside a `densWrapStyle` track, at the
// trailing edge of the `barRow` that sits between the frame's app bar and the
// strip. A segmented control changes what you LOOK AT, never what happens
// (`segTrack`/`segItem` in the system's own control recipes) — which is why it
// is a track of quiet words and never takes the fill a commit takes.
//
// Two words also say what two glyphs only imply. A four-square and a
// three-line icon are a convention a member has to already know; "List" and
// "Grid" are the two things the set can be, spelled out, in the 38px the
// handoff gives each of them.
import type { ReactNode } from "react";

import type { AppState } from "../types.ts";

import styles from "./ViewToggle.module.css";

const VIEWS: readonly { id: AppState["view"]; label: string }[] = [
  { id: "list", label: "List" },
  { id: "grid", label: "Grid" },
];

export function ViewToggle({
  view,
  onSelectView,
}: {
  view: AppState["view"];
  onSelectView: (view: AppState["view"]) => void;
}): ReactNode {
  return (
    // A `<fieldset>`, which IS the element behind `role="group"` — the a11y
    // profile prefers the element to the attribute, and the kit's row block
    // makes the same call. These stay two aria-pressed buttons rather than
    // radios: they are two ways of looking at one set, so the pressed state is
    // what carries the choice.
    <fieldset aria-label="View" className={styles.track}>
      {VIEWS.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={styles.item}
          aria-label={`${entry.label} view`}
          aria-pressed={view === entry.id}
          onClick={() => onSelectView(entry.id)}
        >
          {entry.label}
        </button>
      ))}
    </fieldset>
  );
}
