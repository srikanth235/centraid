import { pendingChipLabel } from "../../_shared/pending-overlay.ts";
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

/** The shared pending-write overlay's attention grammar (issue #738): a row
 *  in one of these statuses persists until the member explicitly dismisses
 *  it — never auto-removed, never silently disappearing. */
const DISMISSIBLE_PENDING_STATUSES = new Set(["denied", "conflict", "failed"]);

export function ExpenseRow({
  row,
  currency,
  groupSuffix = false,
  onOpen,
  onDismiss,
  onCancel,
}: {
  row: LedgerRow;
  currency: string;
  groupSuffix?: boolean;
  onOpen: (row: LedgerRow) => void;
  /**
   * Settle an attention row (denied/conflict/failed, issue #738's status
   * grammar) out of the model for good (issue #731 m6, extended by #738) —
   * the model's `enrichCommons()` otherwise keeps re-showing a denied
   * Commons row on every enrichment forever, since it never ages out of
   * `commonsIntents()` on its own the way an executed write does. Omitted
   * for a still-waiting row and every non-pending row — only a settled
   * attention row is ever dismissible.
   */
  onDismiss?: (row: LedgerRow) => void;
  /**
   * Cancel a durable Commons intent that has not executed yet (issue #731
   * goal 2). Meaningful only while the row is still `parked` — once the
   * steward (or the peer sweep) has settled it one way or another,
   * cancelling is no longer an available choice, so the control disappears
   * rather than lingering as a no-op.
   */
  onCancel?: (row: LedgerRow) => void;
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
  // Every attention state (issue #738's status grammar: denied/conflict/
  // failed) gets its own honest label and stays dismissible; a still-waiting
  // row (queued/sending/parked) is never dismissible.
  const dismissible = DISMISSIBLE_PENDING_STATUSES.has(row.pendingStatus ?? "");
  const cancellable = row.pendingStatus === "parked";
  const pendingLabel = row.pendingStatus
    ? pendingChipLabel(row.pendingStatus)
    : row.parked
      ? "waiting"
      : "pending";
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
        {cancellable && onCancel ? (
          <button
            type="button"
            className={styles.dismiss}
            onClick={(event) => {
              // The row itself is a plain (non-button) wrapper while pending —
              // stopPropagation is cheap insurance if that ever changes.
              event.stopPropagation();
              onCancel(row);
            }}
          >
            Cancel
          </button>
        ) : null}
        {dismissible && onDismiss ? (
          <button
            type="button"
            className={styles.dismiss}
            onClick={(event) => {
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

  // A pending/parked/denied/expired/cancelled row has no detail popover to
  // open (there is no receipt or server row yet), so it is never itself a
  // button — the Cancel/Dismiss controls are real interactive content, and a
  // <button> may not nest another <button>.
  return pending ? (
    <div className={`${styles.exrow} kit-pending`}>{inner}</div>
  ) : (
    <button type="button" className={styles.exrow} onClick={() => onOpen(row)}>
      {inner}
    </button>
  );
}
