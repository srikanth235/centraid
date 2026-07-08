import type { JSX, ReactNode } from 'react';

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
    <div className="drawer-group">
      <div className="drawer-group-label">{label}</div>
      <div className="drawer-group-body">{children}</div>
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
    <div className={full ? 'drawer-row drawer-row-full' : 'drawer-row drawer-row-grid'}>
      <div className="drawer-row-head">
        <span className="drawer-row-label">{label}</span>
        <span className="drawer-row-hint">{hint}</span>
      </div>
      <div className="drawer-row-control">{children}</div>
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
      className="cd-switch"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      data-on={String(on)}
      onClick={() => onToggle(!on)}
    >
      <span className="cd-switch-thumb" />
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
    <div className="seg" role="tablist" aria-label={ariaLabel}>
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
