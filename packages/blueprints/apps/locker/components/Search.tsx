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
import { WindowedRows } from "./Windowed.tsx";

import styles from "./Rows.module.css";

export interface SearchScreenProps {
  query: string;
  status: SearchStatus;
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
          {/* Windowed (#883 C4): a two-letter term matches the whole vault. */}
          <WindowedRows className={styles.list} rows={results}>
            {(row, position) => (
              <ItemRow
                key={row.item_id}
                position={position}
                row={row}
                onOpen={props.onOpen}
                meta={SEARCH_MATCHED}
              />
            )}
          </WindowedRows>
        </Section>
      </SearchScaffold>
    </div>
  );
}
