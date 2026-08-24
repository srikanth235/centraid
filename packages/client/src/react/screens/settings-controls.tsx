import type { JSX, ReactNode } from "react";

import { cx } from "../ui/cx.js";

import drawerGroupCss from "../styles/drawerGroup.module.css";
import segCss from "../styles/seg.module.css";
import styles from "./settings-controls.module.css";

// Shared Settings control primitives. They emit the class names global
// styles.css targets — renaming a class here silently unstyles every Settings
// pane.

export function DrawerGroup({
  label,
  meta,
  children,
}: {
  label: string;
  /** A count the head states about its own rows (`3 of 4 on`). */
  meta?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={drawerGroupCss.group}>
      <div className={drawerGroupCss.groupHead}>
        <span className={drawerGroupCss.groupLabel}>{label}</span>
        {meta ? <span className={drawerGroupCss.groupMeta}>{meta}</span> : null}
      </div>
      <div className={drawerGroupCss.groupBody}>{children}</div>
    </div>
  );
}

export function DrawerRow({
  label,
  hint,
  full = false,
  children,
}: {
  label: string;
  hint: string;
  full?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={
        full ? cx(styles.row, styles.rowFull) : cx(styles.row, styles.rowGrid)
      }
    >
      <div className={styles.rowHead}>
        <span className={styles.rowLabel}>{label}</span>
        <span className={styles.rowHint}>{hint}</span>
      </div>
      <div className={styles.rowControl}>{children}</div>
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  selected,
  onSelect,
  ariaLabel,
  labels,
}: {
  options: readonly T[];
  selected: T;
  onSelect: (v: T) => void;
  ariaLabel?: string;
  /** Display text per option. Defaults to the option value itself, which the
   *  seg styles capitalize — supply this when the stored value is not the
   *  words to show (`system` → `Match system`). */
  labels?: Partial<Record<T, string>>;
}): JSX.Element {
  return (
    <div className={segCss.seg} role="tablist" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          role="tab"
          aria-selected={opt === selected}
          data-active={String(opt === selected)}
          data-value={opt}
          onClick={() => onSelect(opt)}
        >
          {labels?.[opt] ?? opt}
        </button>
      ))}
    </div>
  );
}
