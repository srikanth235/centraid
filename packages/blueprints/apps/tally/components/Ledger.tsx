// A group or friend ledger: the group's per-member balance panel (friend
// view has none — a friend ledger is just the two of you) plus the expense
// list itself.
import { first, money } from '../format.ts';
import type { LedgerRow, Member, ViewData } from '../types.ts';
import { ExpenseRow } from './ExpenseRow.tsx';
import { ExplistSkeleton, KitAvatar } from './Shared.tsx';
import styles from './Ledger.module.css';
import shared from './shared.module.css';

function BalChip({ m, currency }: { m: Member; currency: string }) {
  const v = m.net_minor ?? 0;
  const who = m.is_me ? 'You' : first(m.name);
  const verb = m.is_me ? { g: 'get back', o: 'owe' } : { g: 'gets back', o: 'owes' };
  const text =
    Math.abs(v) < 1
      ? `${who} — settled`
      : v > 0
        ? `${who} ${verb.g} ${money(v, currency)}`
        : `${who} ${verb.o} ${money(v, currency)}`;
  return (
    <span className={styles.balchip}>
      <KitAvatar name={m.name} size="22px" color={m.color} initials={m.initials} />
      <span>{text}</span>
    </span>
  );
}

export function Ledger({
  view,
  viewData,
  currency,
  onOpenDetail,
}: {
  view: 'group' | 'friend';
  viewData: ViewData | null;
  currency: string;
  onOpenDetail: (row: LedgerRow) => void;
}) {
  if (!viewData) return <ExplistSkeleton rows={5} />;

  const members = view === 'group' ? (viewData.members ?? []) : [];
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
        <div className={shared.explist}>
          <div className={shared.emptyRow} style={{ padding: '40px 16px' }}>
            No expenses yet. Add one to get started.
          </div>
        </div>
      ) : (
        <div className={shared.explist}>
          {ledger.map((row) => (
            <ExpenseRow key={row.expense_id} row={row} currency={currency} onOpen={onOpenDetail} />
          ))}
        </div>
      )}
    </>
  );
}
