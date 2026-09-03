import type { ReactNode } from "react";

import { virtualItemAria } from "../../_shared/virtual-window.ts";
import { virtualBlockProps } from "../../_shared/VirtualWindow.tsx";
import { purgeCountdown } from "../format.ts";
import {
  TRASH_EMPTY,
  TRASH_HEAD,
  TRASH_META,
  TRASH_PURGE,
  TRASH_RESTORE,
} from "../route-copy.ts";
import type { LockerRow } from "../types.ts";
import { ItemRow, Section } from "./Rows.tsx";
import { WindowedRows } from "./Windowed.tsx";

import styles from "./Rows.module.css";

const TRASH_ROW_RUNG = 88;

export interface TrashScreenProps {
  rows: readonly LockerRow[];
  loaded: boolean;
  onRestore: (itemId: string) => void;
  onPurge: (itemId: string) => void;
}

export function TrashScreen(props: TrashScreenProps): ReactNode {
  return (
    <div className={styles.sections}>
      <Section
        label={TRASH_HEAD}
        meta={TRASH_META}
        count={props.rows.length}
        loaded={props.loaded}
        empty={
          <div className="kit-empty" data-variant="trash">
            <div className="kit-empty-card">
              <div className="kit-empty-title">{TRASH_EMPTY}</div>
            </div>
          </div>
        }
      >
        {/* Windowed (#883 C4). Here the LIST ITEM is the row and its act
            together — a purge separated from the title it purges is the one
            arrangement this screen may not draw — so the `<li>` is
            `.trashRow`, and it carries the block index and the true set size
            the DOM no longer states. */}
        <WindowedRows
          className={styles.list}
          fallbackHeight={TRASH_ROW_RUNG}
          rows={props.rows}
        >
          {(row, position) => (
            <li
              key={row.item_id}
              className={styles.trashRow}
              {...virtualBlockProps(position.index)}
              {...virtualItemAria(position.index, position.setSize)}
            >
              <ItemRow
                row={row}
                status={null}
                {...(purgeCountdown(row.purge_at)
                  ? { meta: purgeCountdown(row.purge_at) }
                  : {})}
                verb={{
                  label: TRASH_RESTORE,
                  run: () => props.onRestore(row.item_id),
                }}
              />
              {/* Destructive is OUTLINED in `--net`, never filled, and it sits
                  below the row's one quiet verb rather than beside it: two
                  equally weighted acts on a row ask a question. */}
              <div className={styles.trashActs}>
                <button
                  type="button"
                  className="kit-btn"
                  data-net="true"
                  onClick={() => props.onPurge(row.item_id)}
                >
                  {TRASH_PURGE}
                </button>
              </div>
            </li>
          )}
        </WindowedRows>
      </Section>
    </div>
  );
}
