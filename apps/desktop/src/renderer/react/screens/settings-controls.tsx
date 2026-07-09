import type { JSX, ReactNode } from 'react';
import styles from './settings-controls.module.css';
import { cx } from '../ui/cx.js';
import segCss from '../styles/seg.module.css';
import drawerGroupCss from '../styles/drawerGroup.module.css';

// Shared Settings control primitives — React ports of the vanilla
// drawerGroup / drawerRowH / makeSwitch / makeSegmented (app-settings.ts),
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
    <div className={full ? cx(styles.row, styles.rowFull) : cx(styles.row, styles.rowGrid)}>
      <div className="drawer-row-head">
        <span className={styles.rowLabel}>{label}</span>
        <span className={styles.rowHint}>{hint}</span>
      </div>
      <div className={styles.rowControl}>{children}</div>
    </div>
  );
}

export function Switch({
  on,
  onToggle,
  ariaLabel,
}: {
  on: boolean;
  onToggle: (next: boolean) => void;
  ariaLabel?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className={styles.switch}
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      data-on={String(on)}
      onClick={() => onToggle(!on)}
    >
      <span className={styles.switchThumb} />
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  selected,
  onSelect,
  ariaLabel,
}: {
  options: readonly T[];
  selected: T;
  onSelect: (v: T) => void;
  ariaLabel?: string;
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
          onClick={() => onSelect(opt)}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}
