import type { SearchGroupRow } from "../../_shared/search-scaffold.ts";
import { SearchScaffold } from "../../_shared/SearchScaffold.tsx";
import type { SearchGroupHit } from "../search-groups.ts";
import type { SearchStatus } from "../search.ts";
import type { ShelfId } from "../shelves.ts";
import { SEARCH_COPY, SEARCH_EXAMPLES } from "../view-copy.ts";

import styles from "./SearchShelf.module.css";

const EMPTY_GROUPS: readonly SearchGroupHit[] = [];

function toGroupRow(hit: SearchGroupHit): SearchGroupRow {
  return {
    kind: hit.kind,
    key: hit.key,
    title: hit.title,
    meta: hit.meta,
    here: hit.here,
    openTarget: hit.targetShelf ?? "",
  };
}

export function SearchShelf({
  query,
  status,
  count,
  groups = EMPTY_GROUPS,
  onQuery,
  onClear,
  onRetry,
  onOpenGroup,
  reachFacts,
  inputRef,
  children,
}: {
  query: string;
  status: SearchStatus;
  count: number;
  groups?: readonly SearchGroupHit[];
  onQuery: (value: string) => void;
  onClear: () => void;
  onRetry?: () => void;
  onOpenGroup?: (shelf: ShelfId) => void;
  reachFacts?: readonly { label: string; value: string }[];
  inputRef?: (el: HTMLInputElement | null) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className={styles.shelf}>
      <search className={`kit-search ${styles.field}`}>
        <label className="kit-sr-only" htmlFor="searchInput">
          Search photographs
        </label>
        {/* UNCONTROLLED ON PURPOSE (#883 C4), the same call Docs' own field
            makes. This shelf renders the whole justified timeline of the
            current hits as its children, so a controlled field made every
            keystroke a re-render of the route: type eight letters and the grid
            is rebuilt eight times before the first result lands. Uncontrolled,
            the character the member typed is already on screen — it is the
            browser's own — and the route follows on the debounce.
            `defaultValue` seeds a fresh mount and never clobbers a field the
            member is typing into; `Clear` empties it through `inputRef`. */}
        <input
          ref={inputRef}
          id="searchInput"
          type="search"
          className={styles.input}
          placeholder={SEARCH_COPY.placeholder}
          defaultValue={query}
          autoComplete="off"
          onInput={(e) => onQuery(e.currentTarget.value)}
        />
        {query ? (
          <button type="button" className={styles.clearBtn} onClick={onClear}>
            Clear
          </button>
        ) : null}
      </search>
      {/* Half the honesty line (§9): what this field reaches, stated once in
          every state. */}
      <p className={styles.scope}>the whole library, not the loaded window</p>

      {/* "the live library" is literal (§9, docs/blueprint-seats.md): this
          seat's query runs FTS5 on the gateway with no replica in the path.
          Do not borrow mobile's replica wording (#711) — a different fact. */}
      <SearchScaffold
        query={query}
        status={status}
        count={count}
        scope="the live library"
        copy={SEARCH_COPY}
        examples={SEARCH_EXAMPLES}
        groups={groups.map(toGroupRow)}
        onQuery={onQuery}
        onClear={onClear}
        onRetry={onRetry}
        onOpenGroup={(target) => onOpenGroup?.(target as ShelfId)}
        reachFacts={reachFacts}
      >
        {children}
      </SearchScaffold>
    </div>
  );
}
