import type { ReactNode } from "react";

import { showsEmptyState } from "../../_shared/view-state-kit.ts";
import { showsWindowEnd, windowEndCopy } from "../format.ts";
import type { LockerRow } from "../types.ts";
import {
  DAY_ONE_ADD,
  DAY_ONE_BODY,
  DAY_ONE_IMPORT,
  DAY_ONE_TITLE,
  NO_MATCH,
  SHOW_MORE,
} from "../view-copy.ts";
import { ItemRow } from "./Rows.tsx";
import { WindowedRows } from "./Windowed.tsx";

import styles from "./Rows.module.css";

export interface LockerListProps {
  rows: readonly LockerRow[];
  windowCount: number;
  total: number | null;
  loaded: boolean;
  truncated: boolean;
  onOpen: (itemId: string) => void;
  onCopyUsername: (row: LockerRow) => void;
  onShowMore: () => void;
  onImport: () => void;
  onAdd: () => void;
}

function DayOne({
  onImport,
  onAdd,
}: {
  onImport: () => void;
  onAdd: () => void;
}): ReactNode {
  return (
    <div className="kit-empty" data-variant="day-one">
      <div className="kit-empty-card">
        <div className="kit-empty-title">{DAY_ONE_TITLE}</div>
        <div className="kit-empty-sub">{DAY_ONE_BODY}</div>
        <div className={styles.screenActs}>
          <button type="button" className="kit-btn" onClick={onImport}>
            {DAY_ONE_IMPORT}
          </button>
          <button type="button" className="kit-btn" onClick={onAdd}>
            {DAY_ONE_ADD}
          </button>
        </div>
      </div>
    </div>
  );
}

function NoMatch(): ReactNode {
  return (
    <div className="kit-empty" data-variant="no-match">
      <div className="kit-empty-card">
        <div className="kit-empty-title">{NO_MATCH}</div>
      </div>
    </div>
  );
}

export function LockerList(props: LockerListProps): ReactNode {
  const empty = showsEmptyState({
    loaded: props.loaded,
    count: props.rows.length,
  });
  if (empty && props.windowCount === 0) {
    return <DayOne onImport={props.onImport} onAdd={props.onAdd} />;
  }
  if (empty) return <NoMatch />;

  return (
    <div className={styles.sections}>
      {/* Windowed (#883 C4): the ask is capped at 2,000, so the screen costs a
          viewport rather than the whole window. */}
      <WindowedRows className={styles.list} rows={props.rows}>
        {(row, position) => (
          <ItemRow
            key={row.item_id}
            position={position}
            row={row}
            onOpen={props.onOpen}
            {...(row.subtitle && row.type === "login"
              ? {
                  verb: {
                    label: "Copy username",
                    run: () => props.onCopyUsername(row),
                  },
                }
              : {})}
          />
        )}
      </WindowedRows>

      {showsWindowEnd(props.loaded, props.rows.length) ? (
        <div className={styles.windowEnd}>
          <span className={styles.num}>
            {windowEndCopy(props.windowCount, props.truncated, props.total)}
          </span>
          {props.truncated ? (
            <button
              type="button"
              className="kit-btn"
              onClick={props.onShowMore}
            >
              {SHOW_MORE}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
