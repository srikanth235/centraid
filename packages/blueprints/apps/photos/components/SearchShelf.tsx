import type { SearchGroupRow } from "../../_shared/search-scaffold.ts";
// Search is a SHELF (v4 handoff §9), not a field the app draws in a header of
// its own. It is reached from the compact band and from the frame; on the PWA
// the browser claims ⌘K, so the band's Search control is the way in.
//
// ALL FOUR STATES LIVE HERE, and each one is a different sentence:
//
//   resting      the panel saying what is searched, plus five REAL example
//                queries as mono chips a member can type back verbatim.
//   searching    DETERMINATE copy and never a spinner (§14): what is already
//                on screen is the local match over the loaded window, with its
//                exact count, and the line says the index is still answering.
//   results      the grouped hits (people/places/albums/things, search-groups.ts)
//                above the same justified timeline (§5) every shelf shares —
//                the caller passes the grid as children.
//   none         the query echoed back and what was searched, so a miss is
//                readable rather than a blank pane, with a way to clear it.
//
// A fifth state the index forces: `unreachable`. The index lives on the
// gateway, and §9 is explicit that search WILL NOT PRETEND TO HAVE LOOKED —
// so a failed reach takes a bordered `--net` panel naming what still works,
// a Retry, never the "no matches" line, which would be a claim nobody
// verified.
//
// THE FOUR STATES THEMSELVES render through `_shared/SearchScaffold.tsx`
// (#712) — this file keeps only what is genuinely Photos-specific:
// the field, the "whole library, not the loaded window" line under it, and
// the photo grid this shelf sits above (passed through as `children`). The
// text every state prints is `view-copy.ts`'s `SEARCH_COPY`, pinned by
// `photos-shelves-v4.test.ts`'s string assertions.
import { SearchScaffold } from "../../_shared/SearchScaffold.tsx";
import type { SearchGroupHit } from "../search-groups.ts";
import type { SearchStatus } from "../search.ts";
import type { ShelfId } from "../shelves.ts";
import { SEARCH_COPY, SEARCH_EXAMPLES } from "../view-copy.ts";

import styles from "./SearchShelf.module.css";

const EMPTY_GROUPS: readonly SearchGroupHit[] = [];

/** Photos' own `SearchGroupHit` (search-groups.ts) carries `targetShelf` and
 *  a closed `SearchGroupKind`; the scaffold's `SearchGroupRow` is the
 *  rendering-only shape every app's rows get mapped down to. Kept as an
 *  adapter at this render boundary rather than widening either type —
 *  `search-groups.ts` and its own test stay untouched. */
function toGroupRow(hit: SearchGroupHit): SearchGroupRow {
  return {
    kind: hit.kind,
    key: hit.key,
    title: hit.title,
    meta: hit.meta,
    here: hit.here,
    // `targetShelf`'s declared type (`ShelfId = string | null`, shelves.ts)
    // is wider than what `search-groups.ts` ever actually produces — every
    // one of its four kinds resolves a real shelf id or the `PLACES`
    // constant, never `null`. The fallback is for the type, not a real case.
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
  /** Which of §9's states the index has put this shelf in (search.ts). */
  status: SearchStatus;
  /** How many photographs the hits below actually carry — an exact number,
   *  which is what makes the working line determinate rather than a spinner. */
  count: number;
  /** The grouped hits above the grid (search-groups.ts) — real data only,
   *  never fabricated: a group with nothing behind it is simply absent. */
  groups?: readonly SearchGroupHit[];
  onQuery: (value: string) => void;
  onClear: () => void;
  /** Re-run the search over the current query — the `unreachable` panel's
   *  only control. */
  onRetry?: () => void;
  onOpenGroup?: (shelf: ShelfId) => void;
  /** Per-scope reach for the current answer (#726 D10/D11,
   *  `search.ts`'s `createSearch`) — a scope that did not answer, named
   *  BESIDE whatever other scopes' hits are still on screen. */
  reachFacts?: readonly { label: string; value: string }[];
  /** The hits, once there are any. */
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
          // Mono, underlined TEXT (§9, ~4146-4147) — not an icon button. The
          // clear affordance is a word here, the same register as the
          // example chips it sits above.
          <button type="button" className={styles.clearBtn} onClick={onClear}>
            Clear
          </button>
        ) : null}
      </search>
      {/* The other half of the honesty line (§9, ~3959-3961): what this field
          reaches, stated once, regardless of state — same reason the
          `resultsHead` line above states it again in numbers once there are
          hits. */}
      <p className={styles.scope}>the whole library, not the loaded window</p>

      {/* The honesty line (§9, ~3959-3961): search.ts's `run()` is a live
          `window.centraid.readAll`/`read` round trip to the gateway's index
          on every keystroke, never a read of the loaded window — so "the live
          library" is the literal, seat-honest scope string
          (docs/blueprint-seats.md §Worked example: search) — a literal claim,
          not a hopeful one.

          RECONCILED AGAINST MOBILE (issue #711): mobile's `session.search`
          resolves against the on-device replica, so its honest foot line is
          "…searched the whole replica on this device" — a genuinely
          different fact. This client's query (queries/search.ts) runs FTS5
          over `core.content_item` on the gateway itself with no replica in
          the path, so the handoff's literal "the live library" is kept
          verbatim here rather than borrowed from mobile's wording. */}
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
