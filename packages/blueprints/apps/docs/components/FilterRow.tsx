// The filter row (Docs spec §4.2, `filterBlock`) — clearable dropdown pills,
// each independently toggleable, plus a "Clear filters" link that only appears
// once at least one filter is set.
//
// A pill is a `<details>`/`<summary>` disclosure rather than a hand-rolled
// popover: it opens on click and on Enter, closes on Escape, is reachable by
// keyboard with no JavaScript at all, and never needs a document-level click
// listener that another overlay could swallow. What it opens is a radio group,
// because an axis holds ONE value — "Modified: Today" and "Modified: This
// year" cannot both be true of the same set.
//
// WHICH PILLS EXIST IS A DATA QUESTION, not a layout one (`liveAxes`): §4.2
// names four properties, and this drive can answer three of them outright and
// the People axis only where the rows carry real shares. See filters.ts for why
// an unanswerable pill is worse than a missing one — and why `rows` has to be
// the drive's whole set rather than the filtered one.
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
  /** The drive's own rows BEFORE the filters narrow them — the People axis'
   *  options are derived from what they are shared with. */
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
