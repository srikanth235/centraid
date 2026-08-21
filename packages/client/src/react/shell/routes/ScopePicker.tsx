import type { JSX } from "react";

import type { OwnerScope } from "../ownerScope.js";

import styles from "./ScopePicker.module.css";

// "Which vault?" — the explicit target every creation flow names (issue #599,
// Decision 14).
//
// The switcher this replaces made the answer AMBIENT: whatever vault the
// sidebar happened to point at was where a new conversation, app or install
// silently landed, and the only way to see that was to read the sidebar head.
// Naming the target at the point of creation is the whole reason the switcher
// could be retired.
//
// Rules the component enforces, so no call site has to remember them:
//   * vaults this owner cannot write to are not offerable targets;
//   * with only one writable vault there is nothing to choose, so the picker
//     collapses to a plain statement of where the thing will land;
//   * the default selection is the owner's own vault, never the last one used.

export interface ScopePickerProps {
  /** Every vault the owner owns (own vault first). */
  scopes: OwnerScope[];
  /** The currently chosen target. */
  value: string | undefined;
  onChange: (scopeId: string) => void;
  /** Leading text — e.g. "New conversation in". */
  label: string;
  /** Renders as a fixed statement rather than a control: the choice is already
   *  made and can no longer change (an existing conversation's vault). */
  locked?: boolean;
}

export default function ScopePicker({
  scopes,
  value,
  onChange,
  label,
  locked,
}: ScopePickerProps): JSX.Element | null {
  const writable = scopes.filter((s) => s.canWrite);
  const selected =
    writable.find((s) => s.id === value) ?? scopes.find((s) => s.id === value);
  if (scopes.length === 0) return null;
  if (locked || writable.length < 2) {
    const name = selected?.label ?? writable[0]?.label ?? scopes[0]?.label;
    if (!name) return null;
    return (
      <span className={styles.fixed}>
        {label} <span className={styles.fixedName}>{name}</span>
      </span>
    );
  }
  return (
    <span className={styles.picker}>
      <span className={styles.label} id="scope-picker-label">
        {label}
      </span>
      <select
        className={styles.select}
        aria-labelledby="scope-picker-label"
        value={selected?.id ?? writable[0]!.id}
        onChange={(e) => onChange(e.currentTarget.value)}
      >
        {writable.map((scope) => (
          <option key={scope.id} value={scope.id}>
            {scope.label}
          </option>
        ))}
      </select>
    </span>
  );
}
