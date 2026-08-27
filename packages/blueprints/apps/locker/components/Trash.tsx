// TRASH (README-Locker §6, "Trash"; FLOWS.md "Trash and purge").
//
// THIRTY DAYS, WITH THE STAR AND THE TAGS — which is what makes a restore
// LOSSLESS, and why this screen lists a purge DATE rather than offering an
// Empty button. A member emptying a trash is a member making one decision
// about many items; a countdown per row is the same information without the
// decision.
//
// A PURGE IS IRREVERSIBLE, so it is confirmed, and the confirm names the
// consequence rather than asking "are you sure". Asked for on a device that is
// not the owner's it PARKS — and the app says so rather than appearing to have
// done it, which is the whole of the parked state in this app.
//
// Offline this screen works: trash, restore and purge are metadata, and
// metadata queues (writes.ts). Nothing here is a secret and nothing here needs
// a permit.
import type { ReactNode } from "react";

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

import styles from "./Rows.module.css";

export interface TrashScreenProps {
  rows: readonly LockerRow[];
  /** Has the trash read landed? Nothing is empty until one has. */
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
        {props.rows.map((row) => (
          <div key={row.item_id} className={styles.trashRow}>
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
          </div>
        ))}
      </Section>
    </div>
  );
}
