// Search results across all expenses — same row as the ledger, with the
// group name folded into the sub line since results span groups.
import { ExpenseRow } from './ExpenseRow.jsx';
import { ExplistSkeleton } from './Shared.jsx';

export function SearchResults({ viewData, search, currency, onOpenDetail }) {
  if (!viewData) return <ExplistSkeleton rows={5} />;
  const results = viewData.results ?? [];
  if (results.length === 0) {
    return (
      <div className="s-explist">
        <div className="s-empty-row" style={{ padding: '40px 16px' }}>
          No expenses match “{search}”.
        </div>
      </div>
    );
  }
  return (
    <div className="s-explist">
      {results.map((row) => (
        <ExpenseRow key={row.expense_id} row={row} currency={currency} groupSuffix onOpen={onOpenDetail} />
      ))}
    </div>
  );
}
