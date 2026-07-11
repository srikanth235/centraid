// A group or friend ledger: the group's per-member balance panel (friend
// view has none — a friend ledger is just the two of you) plus the expense
// list itself.
import { first, money } from '../format.js';
import { ExpenseRow } from './ExpenseRow.jsx';
import { ExplistSkeleton } from './Shared.jsx';

function BalChip({ m, currency }) {
  const v = m.net_minor;
  const who = m.is_me ? 'You' : first(m.name);
  const verb = m.is_me ? { g: 'get back', o: 'owe' } : { g: 'gets back', o: 'owes' };
  const text =
    Math.abs(v) < 1
      ? `${who} — settled`
      : v > 0
        ? `${who} ${verb.g} ${money(v, currency)}`
        : `${who} ${verb.o} ${money(v, currency)}`;
  return (
    <span className="s-balchip">
      <kit-avatar name={m.name} size="22px" color={m.color} initials={m.initials} />
      <span>{text}</span>
    </span>
  );
}

export function Ledger({ view, viewData, currency, onOpenDetail }) {
  if (!viewData) return <ExplistSkeleton rows={5} />;

  const members = view === 'group' ? (viewData.members ?? []) : [];
  const ledger = viewData.ledger ?? [];

  return (
    <>
      {members.length > 0 ? (
        <div className="s-balpanel">
          {members.map((m) => (
            <BalChip key={m.party_id} m={m} currency={currency} />
          ))}
        </div>
      ) : null}

      {ledger.length === 0 ? (
        <div className="s-explist">
          <div className="s-empty-row" style={{ padding: '40px 16px' }}>
            No expenses yet. Add one to get started.
          </div>
        </div>
      ) : (
        <div className="s-explist">
          {ledger.map((row) => (
            <ExpenseRow key={row.expense_id} row={row} currency={currency} onOpen={onOpenDetail} />
          ))}
        </div>
      )}
    </>
  );
}
