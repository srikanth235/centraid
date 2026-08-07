// The ruled-row / four-state search body (issue #712 S1), extracted from
// Photos' `components/SearchShelf.tsx` so a second app does not redraw the
// same four sentences from scratch. This owns the STATES — resting,
// searching, unreachable, no-results, and the grouped-hit rows above the
// caller's own results — never the search field itself: the field's
// placement is chrome each app already owns (Photos draws it inline in the
// shelf; Tally draws it in `Chrome.tsx`'s topbar), so forcing it in here
// would be presentational surface this scaffold has no opinion about.
//
// Every string is copy the caller supplies (`SearchStateCopy`,
// `search-scaffold.ts`) — this file contains no example queries, no eyebrow
// text, no product nouns. That is what makes it safe for Photos to adopt
// without a visible copy change: pass Photos' own strings in, get Photos'
// own sentences out.
import type { ReactNode } from "react";

import type {
  SearchGroupRow,
  SearchStateCopy,
  SearchStatus,
} from "./search-scaffold.ts";
import { searchOpenLabel } from "./search-scaffold.ts";

import styles from "./SearchScaffold.module.css";

export interface SearchScaffoldProps {
  /** The current query text — an empty string is `resting` regardless of
   *  `status`, the same rule Photos' `SearchShelf` enforces today. */
  query: string;
  status: SearchStatus;
  /** How many primary results the caller's own list/grid actually carries. */
  count: number;
  /** The seat-honest scope string for the results footer, e.g. "the live
   *  library" or "the whole replica on this device"
   *  (docs/blueprint-seats.md §Worked example: search). */
  scope: string;
  copy: SearchStateCopy;
  /** The resting panel's example queries, as literal chips a member can type
   *  back verbatim. */
  examples: readonly string[];
  /** The grouped hits above the primary results — real data only, already
   *  capped (`groupSearchHits`). A group with nothing behind it is simply
   *  absent from this array, never padded in here. */
  groups?: readonly SearchGroupRow[];
  onQuery: (value: string) => void;
  onClear: () => void;
  /** Re-run the search over the current query — the `unreachable` panel's
   *  only control. */
  onRetry?: () => void;
  onOpenGroup?: (openTarget: string, row: SearchGroupRow) => void;
  /** The caller's own primary results (photo grid, expense list, ...). */
  children?: ReactNode;
}

const EMPTY_GROUPS: readonly SearchGroupRow[] = [];

export function SearchScaffold({
  query,
  status,
  count,
  scope,
  copy,
  examples,
  groups = EMPTY_GROUPS,
  onQuery,
  onClear,
  onRetry,
  onOpenGroup,
  children,
}: SearchScaffoldProps) {
  const asked = Boolean(query);
  const searching = asked && status === "searching";
  const unreachable = asked && status === "unreachable";
  // A miss means everything the miss body claims was checked came back
  // empty — not just the primary list. `groups` matches its own entities
  // independently of `count`, so a query that names a real entity with no
  // primary-list hit still has a group row to show.
  const hasGroups = groups.length > 0;
  const none = asked && status === "ready" && count === 0 && !hasGroups;
  const showResults = asked && status === "ready" && (count > 0 || hasGroups);

  return (
    <>
      {asked ? null : (
        <div className={styles.panel}>
          <p className={styles.eyebrow}>{copy.resting.eyebrow}</p>
          <h2 className={styles.title}>{copy.resting.title}</h2>
          <p className={styles.body}>{copy.resting.body}</p>
          <div className={styles.examples}>
            {examples.map((example) => (
              <button
                key={example}
                type="button"
                className={`kit-chip quiet ${styles.example}`}
                onClick={() => onQuery(example)}
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      )}

      {searching ? (
        <p className={styles.working}>
          {copy.searching.lead} <span className={styles.num}>{count}</span>{" "}
          {copy.searching.trail(count)}
        </p>
      ) : null}

      {unreachable ? (
        <div className={styles.unreachable}>
          <p className={styles.eyebrow}>{copy.unreachable.eyebrow}</p>
          <h2 className={styles.unreachableTitle}>{copy.unreachable.title}</h2>
          <p className={styles.body}>{copy.unreachable.body}</p>
          <dl className={styles.facts}>
            {copy.unreachable.facts.map((fact) => (
              <div key={fact.label} className={styles.fact}>
                <dt className={styles.factLabel}>{fact.label}</dt>
                <dd className={styles.factValue}>{fact.value}</dd>
              </div>
            ))}
          </dl>
          <button
            type="button"
            className="kit-btn"
            disabled={!onRetry}
            onClick={onRetry}
          >
            {copy.unreachable.retry}
          </button>
        </div>
      ) : null}

      {none ? (
        <div className={styles.panel}>
          <p className={styles.eyebrow}>{copy.miss.eyebrow}</p>
          <h2 className={styles.title}>{copy.miss.title(query)}</h2>
          <p className={styles.body}>{copy.miss.body}</p>
          <button type="button" className="kit-btn" onClick={onClear}>
            {copy.miss.clear}
          </button>
        </div>
      ) : null}

      {showResults ? (
        <p className={styles.resultsHead}>
          <span className={styles.num}>{count}</span>{" "}
          {count === 1 ? "result" : "results"} · searched {scope}
        </p>
      ) : null}

      {showResults && groups.length > 0 ? (
        <ul className={styles.groups}>
          {groups.map((row) => (
            <li key={`${row.kind}:${row.key}`} className={styles.groupRow}>
              <div className={styles.groupText}>
                <p className={styles.groupTitle}>{row.title}</p>
                <p className={styles.groupMeta}>{row.meta}</p>
              </div>
              {row.here ? (
                <span className={styles.groupHere}>{row.here}</span>
              ) : null}
              <button
                type="button"
                className={styles.groupOpen}
                aria-label={searchOpenLabel(row)}
                onClick={() => onOpenGroup?.(row.openTarget, row)}
              >
                Open →
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {asked && !none ? children : null}
    </>
  );
}
