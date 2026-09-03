import type { ReactNode } from "react";

import { CLEAR_FILTERS } from "../drive-copy.ts";
import { liveAxes, liveOptions } from "../filters.ts";
import type { DriveFilters } from "../filters.ts";
import { I } from "../icons.ts";
import type { DriveDoc } from "../types.ts";
import { Icon } from "./Shared.tsx";

import styles from "./FilterRow.module.css";

export function FilterRow({
  filters,
  rows,
  onSelect,
  onClear,
}: {
  filters: DriveFilters;
  rows: readonly DriveDoc[];
  onSelect: (axis: keyof DriveFilters, option: string | null) => void;
  onClear: () => void;
}): ReactNode {
  const axes = liveAxes(rows);
  const anySet = Object.values(filters).some((value) => value !== null);
  return (
    <div className={styles.row}>
      {axes.map((axis) => {
        const key = axis.id as keyof DriveFilters;
        const current = filters[key] ?? null;
        return (
          <details key={axis.id} className={styles.pill}>
            <summary className={styles.summary} data-set={String(!!current)}>
              <span className={styles.pillLabel}>
                {current ? `${axis.label}: ${current}` : axis.label}
              </span>
              {/* The catalog's chevron, not the `⌄` character: U+2304 carries
                  its ink low in its own em box, so centring the box leaves the
                  glyph sitting below the label it belongs to. A vector aligns
                  and scales with the control. */}
              <span className={styles.chev}>
                <Icon svg={I.chevDown!} />
              </span>
            </summary>
            <div className={styles.menu}>
              <fieldset className={styles.options}>
                <legend className="kit-sr-only">{axis.label}</legend>
                {liveOptions(axis, rows).map((option) => (
                  <label key={option} className={styles.option}>
                    <input
                      type="radio"
                      name={`docs-filter-${axis.id}`}
                      checked={current === option}
                      onChange={() => onSelect(key, option)}
                    />
                    <span>{option}</span>
                  </label>
                ))}
              </fieldset>
              {current ? (
                <button
                  type="button"
                  className={`kit-plain-btn ${styles.clearOne}`}
                  onClick={() => onSelect(key, null)}
                >
                  Clear {axis.label.toLowerCase()}
                </button>
              ) : null}
            </div>
          </details>
        );
      })}
      {/* "…a 'Clear filters' text link that only appears once ≥1 filter is
          set" (§4.2). Absent, not disabled: there is nothing to clear. */}
      {anySet ? (
        <button
          type="button"
          className={`kit-plain-btn ${styles.clearAll}`}
          onClick={onClear}
        >
          {CLEAR_FILTERS}
        </button>
      ) : null}
    </div>
  );
}
