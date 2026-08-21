// Filter chips (v9 §8, issue #765).
//
// A pill row that toggles what you are LOOKING at. It is not
// `styles/seg.module.css`: the segmented control is a sunken track with one
// raised segment and exactly one answer; chips wrap, carry a count each, and
// several can be true at once.
import type { JSX } from "react";

import type { ChipData } from "@centraid/design/blocks";

import { cx } from "./cx.js";

import styles from "./ChipsBlock.module.css";

/** `id` + `label` + `on`, documented once in the shared contract. This kit adds
 *  no chip fields of its own — the handler is on the group, not the chip. */
export type ChipDef = ChipData;

export interface ChipsBlockProps {
  chips: readonly ChipDef[];
  onPick: (id: string) => void;
  /**
   * The numeric register — Analytics' 7 / 30 / 90 window picker. Tabular,
   * isolated and ltr, so the window never reorders under RTL.
   */
  mono?: boolean;
  /** Names the group. Chips carry visible text, so the GROUP takes the label
   *  and the chips do not. */
  ariaLabel: string;
  className?: string;
}

/** Pill filter chips — the `full`-state and window pickers. */
export default function ChipsBlock({
  chips,
  onPick,
  mono,
  ariaLabel,
  className,
}: ChipsBlockProps): JSX.Element {
  return (
    // `<fieldset>` is the native element behind `role="group"` and the a11y
    // profile prefers the element to the role; its UA box is reset in
    // styles.css. Same swap `AppBand` made for the section capsule.
    <fieldset
      aria-label={ariaLabel}
      className={cx(styles.chips, className)}
      data-mono={mono ? "true" : undefined}
    >
      {chips.map((chip) => (
        <button
          aria-pressed={chip.on ?? false}
          className={styles.chip}
          key={chip.id}
          onClick={() => onPick(chip.id)}
          type="button"
        >
          {chip.label}
        </button>
      ))}
    </fieldset>
  );
}
