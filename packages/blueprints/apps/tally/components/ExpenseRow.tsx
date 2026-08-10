import { displayText } from "../../_shared/untrusted.ts";
// One expense row from a decorated ledger/search row (already carries
// splits). Shared by Ledger.tsx (group/friend view) and Search.tsx —
// `groupSuffix` folds the group name into the sub line for search results,
// like the prototype does.
import { MS, cat, first, money, tint, todayKey } from "../format.ts";
import type { LedgerRow } from "../types.ts";

import styles from "./ExpenseRow.module.css";
import shared from "./shared.module.css";

const TONE = {
  pos: shared.pos!,
  neg: shared.neg!,
  muted: shared.muted!,
} as const;

export function ExpenseRow({
  row,
  currency,
  groupSuffix = false,
  onOpen,
  onDismiss,
}: {
  row: LedgerRow;
  currency: string;
  groupSuffix?: boolean;
  onOpen: (row: LedgerRow) => void;
  /**
   * Settle a `denied` durable Commons intent out of the overlay for good
   * (issue #731 m6) — `refreshCommonsExpenses` otherwise keeps re-showing it
   * on every refresh forever, since a denial (unlike an executed write)
   * never ages out of `commonsIntents()` on its own. Omitted for
   * `pending`/`parked` rows and every settled, non-optimistic row — only a
   * `denied` row is ever dismissible.
   */
  onDismiss?: (row: LedgerRow) => void;
}) {
  const c = cat(row.category);
  const d = new Date((row.spent_on || todayKey()) + "T12:00:00");
  let rLabel: string;
  let amt: string;
  let cls: "pos" | "neg" | "muted";
  let sub: string;
  if (row.your_role === "lent") {
    rLabel = "you lent";
    amt = money(row.your_amount_minor, currency);
    cls = "pos";
    sub = "you paid " + money(row.amount_minor, currency);
  } else if (row.your_role === "borrowed") {
    rLabel = "you borrowed";
    amt = money(row.your_amount_minor, currency);
    cls = "neg";
    sub =
      displayText(first(row.paid_by_name)) +
      " paid " +
      money(row.amount_minor, currency);
  } else {
    rLabel = "not involved";
    amt = money(row.amount_minor, currency);
    cls = "muted";
    sub = displayText(first(row.paid_by_name)) + " paid";
  }
  if (groupSuffix && row.group_name)
    sub = `${sub} · ${displayText(row.group_name)}`;

  // Optimistic / parked rows (issue #404): the kit's shared pending
  // treatment — accent rail on the row, spinning mono chip where the role
  // label sits — and no detail popover (there is no receipt or server row to
  // show yet; the doorbell refresh swaps in the real one).
  const pending = Boolean(row.pending);
  const denied = row.intentStatus === "denied";
  const pendingLabel = denied ? "denied" : row.parked ? "waiting" : "pending";
  const inner = (
    <>
      <span className={styles.exdate}>
        <span className={styles.mo}>{MS[d.getMonth()]}</span>
        <span className={styles.dy}>{String(d.getDate())}</span>
      </span>
      <span className={shared.excat} style={{ background: tint(c.color) }}>
        {c.icon}
      </span>
      <span className={styles.exmain}>
        <span className={styles.exdesc}>{displayText(row.description)}</span>
        <span className={styles.exsub}>
          {sub}
          {row.receipt ? " · receipt" : ""}
          {row.pendingReason ? ` · ${displayText(row.pendingReason)}` : ""}
        </span>
      </span>
      <span className={styles.exright}>
        {pending ? (
          <span className="kit-pending-chip" title={row.pendingReason}>
            {pendingLabel}
          </span>
        ) : (
          <span className={styles.exlabel}>{rLabel}</span>
        )}
        <span className={`${styles.examt} ${TONE[cls]}`}>{amt}</span>
        {denied && onDismiss ? (
          <button
            type="button"
            className={styles.dismiss}
            onClick={(event) => {
              // The row itself is a plain (non-button) wrapper while pending —
              // stopPropagation is cheap insurance if that ever changes.
              event.stopPropagation();
              onDismiss(row);
            }}
          >
            Dismiss
          </button>
        ) : null}
      </span>
    </>
  );

  // A pending/parked/denied row has no detail popover to open (there is no
  // receipt or server row yet), so it is never itself a button — a denied
  // row's Dismiss control is real interactive content, and a <button> may
  // not nest another <button>.
  return pending ? (
    <div className={`${styles.exrow} kit-pending`}>{inner}</div>
  ) : (
    <button type="button" className={styles.exrow} onClick={() => onOpen(row)}>
      {inner}
    </button>
  );
}
