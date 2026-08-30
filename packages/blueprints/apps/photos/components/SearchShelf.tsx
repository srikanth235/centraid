import type { SearchGroupRow } from "../../_shared/search-scaffold.ts";
// Search is a SHELF (v4 handoff §9). Every state renders through
// `_shared/SearchScaffold.tsx` (#712) from `SEARCH_COPY`.
//
// SEARCH WILL NOT PRETEND TO HAVE LOOKED (§9): an `unreachable` reach takes the
// `--net` panel and a Retry, never "no matches". Copy stays DETERMINATE (§14).
import { SearchScaffold } from "../../_shared/SearchScaffold.tsx";
import type { SearchGroupHit } from "../search-groups.ts";
import type { SearchStatus } from "../search.ts";
import type { ShelfId } from "../shelves.ts";
import { SEARCH_COPY, SEARCH_EXAMPLES } from "../view-copy.ts";

import styles from "./SearchShelf.module.css";

const EMPTY_GROUPS: readonly SearchGroupHit[] = [];

/** An adapter at this render boundary; widen neither type. */
function toGroupRow(hit: SearchGroupHit): SearchGroupRow {
  return {
    kind: hit.kind,
    key: hit.key,
    title: hit.title,
    meta: hit.meta,
    here: hit.here,
    // For the type only: `search-groups.ts` never produces `null`.
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
  /** Exact; it is what keeps the working line determinate. */
  count: number;
  /** Real data only: a group with nothing behind it is absent, never faked. */
  groups?: readonly SearchGroupHit[];
  onQuery: (value: string) => void;
  onClear: () => void;
  onRetry?: () => void;
  onOpenGroup?: (shelf: ShelfId) => void;
  /** A scope that did not answer, named BESIDE the hits still on screen
   *  (#726 D10/D11). */
  reachFacts?: readonly { label: string; value: string }[];
  /** Hands the field back so `Clear` can empty it; see the note on the input. */
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
          // Mono, underlined TEXT (§9) — never an icon button.
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
