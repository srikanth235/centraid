// Search results across all expenses — same row as the ledger, with the
// group name folded into the sub line since results span groups.
import type { LedgerRow, ViewData } from '../types.ts';
import { ExpenseRow } from './ExpenseRow.tsx';
import { ExplistSkeleton } from './Shared.tsx';
import shared from './shared.module.css';

export function SearchResults({
  viewData,
  search,
  currency,
  onOpenDetail,
}: {
  viewData: ViewData | null;
  search: string;
  currency: string;
  onOpenDetail: (row: LedgerRow) => void;
}) {
  if (!viewData) return <ExplistSkeleton rows={5} />;
  const results = viewData.results ?? [];
  if (results.length === 0) {
    return (
      <div className={shared.explist}>
        <div className={shared.emptyRow} style={{ padding: '40px 16px' }}>
          No expenses match “{search}”.
        </div>
      </div>
    );
  }
  return (
    <div className={shared.explist}>
      {results.map((row) => (
        <ExpenseRow
          key={row.expense_id}
          row={row}
          currency={currency}
          groupSuffix
          onOpen={onOpenDetail}
        />
      ))}
    </div>
  );
}
