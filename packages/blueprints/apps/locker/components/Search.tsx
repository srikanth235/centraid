// SEARCH — TITLE, USERNAME AND ADDRESS, AND IT SAYS SO (README-Locker §6).
//
// The four states are the product's (`_shared/SearchScaffold.tsx`), so an
// index that could not be reached says NOTHING WAS CHECKED here exactly as it
// does in Photos and Tally, rather than collapsing into "no results".
//
// WHAT IS STRUCTURALLY ABSENT FROM THIS PATH: a secret value and a note. The
// query matches over title, username and url INSIDE the vault and hands back
// the same secret-free row the list draws (`queries/search.ts`), so there is
// no code path here that could show a secret even if this file asked for one.
// The note under the field states that as a DESIGN — a note routinely holds
// recovery codes — rather than leaving it to read as an omission.
import type { ReactNode } from "react";

import type { SearchStatus } from "../../_shared/search-scaffold.ts";
import { SearchScaffold } from "../../_shared/SearchScaffold.tsx";
import {
  SEARCH_COPY,
  SEARCH_MATCHED,
  SEARCH_PLACEHOLDER,
  SEARCH_RESULTS,
  SEARCH_SCOPE,
} from "../route-copy.ts";
import type { LockerRow } from "../types.ts";
import { SEARCH_NOTE } from "../view-copy.ts";
import { ItemRow, Section } from "./Rows.tsx";

import styles from "./Rows.module.css";

export interface SearchScreenProps {
  query: string;
  status: SearchStatus;
  /** `null` until a search has run — an absent answer, never an empty set. */
  results: LockerRow[] | null;
  onQuery: (value: string) => void;
  onClear: () => void;
  onRetry: () => void;
  onOpen: (itemId: string) => void;
}

export function SearchScreen(props: SearchScreenProps): ReactNode {
  const results = props.results ?? [];
  return (
    <div className={styles.sections}>
      <div className={styles.searchField}>
        <input
          className="kit-input"
          type="search"
          autoComplete="off"
          value={props.query}
          placeholder={SEARCH_PLACEHOLDER}
          aria-label={SEARCH_PLACEHOLDER}
          onChange={(event) => props.onQuery(event.target.value)}
        />
      </div>
      <p className={styles.fieldNote}>{SEARCH_NOTE}</p>

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
          label={SEARCH_RESULTS}
          meta={SEARCH_SCOPE}
          count={results.length}
        >
          {results.map((row) => (
            <ItemRow
              key={row.item_id}
              row={row}
              onOpen={props.onOpen}
              meta={SEARCH_MATCHED}
            />
          ))}
        </Section>
      </SearchScaffold>
    </div>
  );
}
