import type { JSX } from "react";

import type { ChipData } from "@centraid/design/blocks";

import { cx } from "./cx.js";

import styles from "./ChipsBlock.module.css";

export type ChipDef = ChipData;

export interface ChipsBlockProps {
  chips: readonly ChipDef[];
  onPick: (id: string) => void;
  mono?: boolean;
  ariaLabel: string;
  className?: string;
}

export default function ChipsBlock({
  chips,
  onPick,
  mono,
  ariaLabel,
  className,
}: ChipsBlockProps): JSX.Element {
  return (
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
