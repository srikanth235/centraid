// A group or friend ledger: the group's per-member balance panel (friend
// view has none — a friend ledger is just the two of you) plus the expense
// list itself.
import { first, money } from "../format.ts";
import type { LedgerRow, Member, ViewData } from "../types.ts";
import { ExpenseRow } from "./ExpenseRow.tsx";
import { ExplistSkeleton, KitAvatar } from "./Shared.tsx";

import styles from "./Ledger.module.css";
import shared from "./shared.module.css";

function BalChip({ m, currency }: { m: Member; currency: string }) {
  const v = m.net_minor ?? 0;
  const who = m.is_me ? "You" : first(m.name);
  const verb = m.is_me
    ? { g: "get back", o: "owe" }
    : { g: "gets back", o: "owes" };
  const text =
    Math.abs(v) < 1
      ? `${who} — settled`
      : v > 0
        ? `${who} ${verb.g} ${money(v, currency)}`
        : `${who} ${verb.o} ${money(v, currency)}`;
  return (
    <span className={styles.balchip}>
      <KitAvatar
        name={m.name}
        size="22px"
        color={m.color}
        initials={m.initials}
      />
      <span>
        {text}
        {m.departed ? " · Departed" : ""}
      </span>
    </span>
  );
}

export function Ledger({
  view,
  viewData,
  currency,
  onOpenDetail,
  onAddExpense,
}: {
  view: "group" | "friend";
  viewData: ViewData | null;
  currency: string;
  onOpenDetail: (row: LedgerRow) => void;
  onAddExpense: () => void;
}) {
  if (!viewData) return <ExplistSkeleton rows={5} />;

  const members = view === "group" ? (viewData.members ?? []) : [];
  const ledger = viewData.ledger ?? [];

  return (
    <>
      {members.length > 0 ? (
        <div className={styles.balpanel}>
          {members.map((m) => (
            <BalChip key={m.party_id} m={m} currency={currency} />
          ))}
        </div>
      ) : null}

      {ledger.length === 0 ? (
        <div className="kit-empty">
          <div className="kit-empty-title">No expenses yet</div>
          <div className="kit-empty-sub">
            Add the first expense to start this ledger.
          </div>
          <button type="button" className="kit-btn" onClick={onAddExpense}>
            Add expense
          </button>
        </div>
      ) : (
        <div className={shared.explist}>
          {ledger.map((row) => (
            <ExpenseRow
              key={row.expense_id}
              row={row}
              currency={currency}
              onOpen={onOpenDetail}
            />
          ))}
        </div>
      )}
    </>
  );
}
