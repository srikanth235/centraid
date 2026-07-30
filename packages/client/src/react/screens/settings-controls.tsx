import type { JSX, ReactNode } from "react";

import { cx } from "../ui/cx.js";

import drawerGroupCss from "../styles/drawerGroup.module.css";
import segCss from "../styles/seg.module.css";
import styles from "./settings-controls.module.css";

// Shared Settings control primitives — React ports of the vanilla
// drawerGroup / drawerRowH / makeSegmented (app-settings.ts),
// emitting the same classes so the global styles.css renders them identically.

export function DrawerGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={drawerGroupCss.group}>
      <div className={drawerGroupCss.groupLabel}>{label}</div>
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
