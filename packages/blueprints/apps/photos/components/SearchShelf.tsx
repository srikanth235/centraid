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
  children?: React.ReactNode;
}) {
  return (
    <div className={styles.shelf}>
      <search className={`kit-search ${styles.field}`}>
        <label className="kit-sr-only" htmlFor="searchInput">
          Search photographs
        </label>
        <input
          id="searchInput"
          type="search"
          className={styles.input}
          placeholder={SEARCH_COPY.placeholder}
          value={query}
          autoComplete="off"
          onChange={(e) => onQuery(e.target.value)}
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
