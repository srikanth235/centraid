// The three lenses: Spending, Trash and Search.
//
// SPENDING IS RESTRAINT (gap register §6). Six category rows and the
// paid-versus-share pair, and nothing else: no trend, no chart beyond a
// proportion bar comparing rows inside this one list. The difference between
// what you paid and what is yours is CARRIED IN BALANCES — it is not a saving,
// and the row that states it says so.
//
// TRASH LISTS THE PURGE DATE RATHER THAN AN EMPTY BUTTON. Thirty days, and the
// date each row stops being restorable is on the row. Purge happens on the
// date and never on a button, so there is no purge control here at all.
//
// SEARCH IS THE SHARED FOUR-STATE SCAFFOLD (`_shared/SearchScaffold.tsx`), so
// "nothing matches" reads the same here as in Photos — and, crucially, an
// index that could not be reached says NOTHING WAS CHECKED rather than
// collapsing into "no results".
import type { ReactNode } from "react";

import type { SearchStatus } from "../../_shared/search-scaffold.ts";
import { SearchScaffold } from "../../_shared/SearchScaffold.tsx";
import { entryFacts } from "../entry-facts.ts";
import { money, proportion } from "../format.ts";
import {
  categoryTotals,
  monthTotal,
  paidVersusShare,
} from "../spending-model.ts";
import type {
  ActivityData,
  LedgerEntry,
  SearchData,
  TrashEntry,
} from "../types.ts";
import {
  EMPTY,
  MATCHED_DESCRIPTION,
  PURGE_UNKNOWN,
  SEARCH_COPY,
  SEARCH_PLACEHOLDER,
  SEARCH_SCOPE,
  SECTIONS,
  SECTION_META,
  SPENDING_META,
  SPEND_ROWS,
  VERBS,
  expenseCount,
  purgesOn,
  trashedOn,
} from "../view-copy.ts";
import { Rows, Section } from "./Blocks.tsx";
import { EntryRow } from "./EntryRow.tsx";
import { LedgerRow } from "./LedgerRow.tsx";

import styles from "./Ledger.module.css";

export interface SpendingProps {
  data: ActivityData;
  now: string;
  narrow: boolean;
}

export function Spending(props: SpendingProps): ReactNode {
  const { data } = props;
  const totals = categoryTotals(data.activity, props.now);
  const largest = totals[0]?.total_minor ?? 0;
  const total = monthTotal(data.activity, props.now);
  const pair = paidVersusShare(data.activity, props.now);

  return (
    <div className={styles.list}>
      <Section
        label={SECTIONS.byCategory}
        meta={`${money(total, data.currency)} across the ledger`}
        count={totals.length}
        empty={EMPTY.spending}
      >
        <Rows>
          {totals.map((row) => (
            <LedgerRow
              key={row.key}
              title={row.label}
              proportion={proportion(row.total_minor, largest)}
              figure={{
                text: money(row.total_minor, data.currency),
                tone: "owed",
              }}
              narrow={props.narrow}
            />
          ))}
        </Rows>
      </Section>

      <Section
        label={SECTIONS.paidAndOwed}
        meta={SECTION_META.paidAndOwed}
        count={3}
      >
        <Rows>
          <LedgerRow
            title={SPEND_ROWS.paid}
            meta={SPENDING_META.paid}
            figure={{
              text: money(pair.paid_minor, data.currency),
              tone: "owed",
            }}
          />
          <LedgerRow
            title={SPEND_ROWS.share}
            meta={SPENDING_META.share}
            figure={{
              text: money(pair.share_minor, data.currency),
              tone: "owed",
            }}
          />
          <LedgerRow
            title={SPEND_ROWS.difference}
            meta={SPENDING_META.difference}
            figure={{
              text: money(pair.difference_minor, data.currency),
              tone: "settled",
            }}
          />
        </Rows>
      </Section>
    </div>
  );
}

export interface TrashProps {
  rows: readonly TrashEntry[];
  currency: string;
  narrow: boolean;
  onRestore: (expenseId: string) => void;
}

export function Trash(props: TrashProps): ReactNode {
  return (
    <div className={styles.list}>
      <Section
        label={SECTIONS.trash}
        meta={`${expenseCount(props.rows.length)} · ${SECTION_META.trash}`}
        count={props.rows.length}
        empty={EMPTY.trash}
      >
        <Rows>
          {props.rows.map((row) => (
            <LedgerRow
              key={row.expense_id}
              title={row.description}
              meta={[
                trashedOn(row.deleted_at.slice(0, 10)),
                row.group_name,
                row.purge_at
                  ? purgesOn(row.purge_at.slice(0, 10))
                  : PURGE_UNKNOWN,
              ].join("  ·  ")}
              figure={{
                text: money(row.amount_minor, props.currency),
                tone: "settled",
              }}
              acts={[
                {
                  label: VERBS.restore,
                  run: () => props.onRestore(row.expense_id),
                },
              ]}
              narrow={props.narrow}
            />
          ))}
        </Rows>
      </Section>
    </div>
  );
}

/**
 * The search field itself, which the scaffold deliberately does not own: where
 * a field stands is chrome each app already owns, and Tally's stands in the
 * tool row above the results.
 */
export function SearchField({
  query,
  onQuery,
  inputRef,
}: {
  query: string;
  onQuery: (value: string) => void;
  inputRef?: (el: HTMLInputElement | null) => void;
}): ReactNode {
  return (
    <input
      ref={inputRef}
      type="search"
      className={`kit-input ${styles.searchField}`}
      value={query}
      placeholder={SEARCH_PLACEHOLDER}
      aria-label={SEARCH_PLACEHOLDER}
      onChange={(event) => onQuery(event.target.value)}
    />
  );
}

export interface SearchProps {
  query: string;
  status: SearchStatus;
  data: SearchData | null;
  narrow: boolean;
  onQuery: (value: string) => void;
  onClear: () => void;
  onRetry: () => void;
  onOpenExpense: (entry: LedgerEntry) => void;
}

export function Search(props: SearchProps): ReactNode {
  const results = props.data?.results ?? [];
  const currency = props.data?.currency ?? "USD";
  return (
    <div className={styles.list}>
      <SearchScaffold
        query={props.query}
        status={props.status}
        count={results.length}
        scope={SEARCH_SCOPE}
        copy={SEARCH_COPY}
        examples={[]}
        onQuery={props.onQuery}
        onClear={props.onClear}
        onRetry={props.onRetry}
      >
        <Section
          label={SECTIONS.results}
          meta={SECTION_META.results}
          count={results.length}
        >
          <Rows>
            {results.map((entry) => (
              <EntryRow
                key={entry.expense_id}
                facts={entryFacts(entry)}
                currency={currency}
                me={props.data?.me ?? null}
                {...(entry.group_name ? { groupName: entry.group_name } : {})}
                extra={MATCHED_DESCRIPTION}
                narrow={props.narrow}
                onOpen={() => props.onOpenExpense(entry)}
              />
            ))}
          </Rows>
        </Section>
      </SearchScaffold>
    </div>
  );
}
