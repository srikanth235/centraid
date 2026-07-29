// Search results across all expenses — same row as the ledger, with the
// group name folded into the sub line since results span groups.
import type { LedgerRow, ViewData } from "../types.ts";
import { ExpenseRow } from "./ExpenseRow.tsx";
import { ExplistSkeleton } from "./Shared.tsx";

import shared from "./shared.module.css";

export function SearchResults({
  viewData,
  search,
  currency,
  onOpenDetail,
  onClearSearch,
}: {
  viewData: ViewData | null;
  search: string;
  currency: string;
  onOpenDetail: (row: LedgerRow) => void;
  onClearSearch: () => void;
}) {
  if (!viewData) return <ExplistSkeleton rows={5} />;
  const results = viewData.results ?? [];
  if (results.length === 0) {
    return (
      <div className="kit-empty">
        <div className="kit-empty-title">No matching expenses</div>
        <div className="kit-empty-sub">No expenses match “{search}”.</div>
        <button type="button" className="kit-btn" onClick={onClearSearch}>
          Clear search
        </button>
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
