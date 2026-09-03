import type { JSX } from "react";

import type { OwnerScope } from "../ownerScope.js";

import styles from "./ScopePicker.module.css";

export interface ScopePickerProps {
  scopes: OwnerScope[];
  value: string | undefined;
  onChange: (scopeId: string) => void;
  label: string;
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
