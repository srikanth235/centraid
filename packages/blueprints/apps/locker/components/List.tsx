// THE ITEMS ROUTE (README-Locker §1, §5) — the browsable half of the app.
//
// What is on this screen is METADATA: titles, usernames, addresses and tags.
// The status line says so in the frame above, and the window's foot says how
// much of the vault this is. Nothing here is a secret, which is why every row
// can be drawn without a permit and why opening one costs one.
//
// DAY ONE IS AN OFFER, NOT AN ABSENCE. `Nothing is kept here yet` carries two
// ways in — the import and one login by hand — because the first item is the
// one that proves the reveal is worth its cost. A filter that matches nothing
// is a DIFFERENT state and says so on its own terms.
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

import styles from "./Rows.module.css";

export interface LockerListProps {
  /** The rows this filter shows, already sorted by `format.rowsFor`. */
  rows: readonly LockerRow[];
  /** How many rows the whole window holds, whatever this filter shows. Day one
   *  is a fact about the WINDOW; "nothing matches" is a fact about the lens. */
  windowCount: number;
  /** Has a read landed? Nothing is empty until one has. */
  loaded: boolean;
  /** Older items exist beyond the window. */
  truncated: boolean;
  onOpen: (itemId: string) => void;
  /** The row's one quiet verb: copy the username, which is metadata and needs
   *  no permit. Omitted for a row with nothing to copy. */
  onCopyUsername: (row: LockerRow) => void;
  onShowMore: () => void;
  onImport: () => void;
  onAdd: () => void;
}

/** The day-one block: one sentence, one more that says why, and two ways in. */
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

/** A lens with nothing under it. Its own sentence, and no act: the way out of
 *  an empty filter is the filter, which is already on screen. */
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
  // Two different facts, and they look nothing alike: an empty VAULT offers a
  // first move; an empty LENS says only that this lens is empty.
  if (empty && props.windowCount === 0) {
    return <DayOne onImport={props.onImport} onAdd={props.onAdd} />;
  }
  if (empty) return <NoMatch />;

  return (
    <div className={styles.sections}>
      <div className={styles.section}>
        {props.rows.map((row) => (
          <ItemRow
            key={row.item_id}
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
        ))}
      </div>

      {showsWindowEnd(props.loaded, props.rows.length) ? (
        <div className={styles.windowEnd}>
          <span className={styles.num}>
            {windowEndCopy(props.windowCount, props.truncated)}
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
