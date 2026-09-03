import type { JSX, ReactNode } from "react";

import { cx } from "../ui/cx.js";

import drawerGroupCss from "../styles/drawerGroup.module.css";
import segCss from "../styles/seg.module.css";
import styles from "./settings-controls.module.css";

export function DrawerGroup({
  label,
  meta,
  children,
}: {
  label: string;
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
  className,
}: {
  options: readonly T[];
  selected: T;
  onSelect: (v: T) => void;
  ariaLabel?: string;
  labels?: Partial<Record<T, ReactNode>>;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cx(segCss.seg, className)}
      role="tablist"
      aria-label={ariaLabel}
    >
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          className={segCss.segOption}
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
