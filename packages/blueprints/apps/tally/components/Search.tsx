import type {
  SearchGroupRow,
  SearchStatus,
} from "../../_shared/search-scaffold.ts";
// Search results across all expenses (issue #712 S1) — the same row as the
// ledger, with the group name folded into the sub line since results span
// groups. The four states above the list (resting/searching/unreachable/no
// matches) and the group/person rows above it now render through the shared
// `_shared/SearchScaffold.tsx`, the same scaffold Photos' `SearchShelf.tsx`
// consumes — proof it generalises past one app (issue #712 deliverable 2).
//
// This app is a RECORD-ONLY blueprint on a viewer seat (docs/blueprint-
// seats.md): the search field posts straight to the gateway
// (`queries/search.ts`'s server-side FTS-style match) with no replica in the
// path, the same seat shape as Photos' own web client — hence the same
// "searched the live ..." honesty line, with "ledger" standing in for
// Photos' "library" as the domain-honest noun.
import { SearchScaffold } from "../../_shared/SearchScaffold.tsx";
import type { LedgerRow, ViewData } from "../types.ts";
import { ExpenseRow } from "./ExpenseRow.tsx";
import { ExplistSkeleton } from "./Shared.tsx";

import shared from "./shared.module.css";

/** Five real example queries, verbatim from `seed.js`'s scenario — a member
 *  who ran the seed can type any of these back and get a hit, the same rule
 *  Photos' `SEARCH_EXAMPLES` follows. */
const TALLY_SEARCH_EXAMPLES: readonly string[] = [
  "Tahoe Trip",
  "Maya",
  "cabin",
  "lift tickets",
  "Jake",
];

const TALLY_SEARCH_COPY = {
  resting: {
    eyebrow: "Nothing typed",
    title: "Search your whole ledger",
    body: "Every group, friend and expense description — not just what's loaded.",
  },
  searching: {
    lead: "Searching your whole ledger.",
    trail: (count: number) =>
      `${count} previous ${count === 1 ? "result" : "results"} showing while it answers.`,
  },
  miss: {
    eyebrow: "No matches",
    title: (query: string) => `Nothing matches "${query}"`,
    body: "No group, friend or expense description matched.",
    clear: "Clear search",
  },
  unreachable: {
    eyebrow: "Cannot reach the gateway",
    title: "Search needs the gateway",
    body: "Expense search runs on the gateway, which is unreachable — nothing below is searched.",
    facts: [
      {
        label: "what still works",
        value: "your dashboard, groups and friends already loaded",
      },
      {
        label: "what does not",
        value: "search, and anything not already loaded",
      },
    ],
    retry: "Retry",
  },
} as const;

export function SearchResults({
  viewData,
  status,
  search,
  currency,
  groups,
  onOpenDetail,
  onClearSearch,
  onRetry,
  onQuery,
  onOpenGroup,
}: {
  viewData: ViewData | null;
  /** Which of the shared scaffold's four states this search is in
   *  (`logic.ts`'s `runSearch`). */
  status: SearchStatus;
  search: string;
  currency: string;
  /** The group/person rows above the expense list (`search-groups.ts`) —
   *  real data only, never fabricated. */
  groups: readonly SearchGroupRow[];
  onOpenDetail: (row: LedgerRow) => void;
  onClearSearch: () => void;
  /** Re-run the current query — the `unreachable` panel's only control. */
  onRetry: () => void;
  /** Fills the field and searches — the resting panel's example chips are
   *  the only caller today (the field itself lives in `Chrome.tsx`, wired
   *  straight to `logic.ts`'s debounced `applySearch`). */
  onQuery: (value: string) => void;
  onOpenGroup: (target: string, row: SearchGroupRow) => void;
}) {
  // The very first-ever search (nothing has landed yet, so there is no stale
  // count to show) still gets the skeleton; every debounced refinement after
  // that keeps the previous results on screen instead of blanking
  // (coding-standards.md: "blanking on refetch is a defect").
  if (!viewData && status === "searching") return <ExplistSkeleton rows={5} />;
  const results = viewData?.results ?? [];
  return (
    <SearchScaffold
      query={search}
      status={status}
      count={results.length}
      scope="the live ledger"
      copy={TALLY_SEARCH_COPY}
      examples={TALLY_SEARCH_EXAMPLES}
      groups={groups}
      onQuery={onQuery}
      onClear={onClearSearch}
      onRetry={onRetry}
      onOpenGroup={onOpenGroup}
    >
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
    </SearchScaffold>
  );
}
