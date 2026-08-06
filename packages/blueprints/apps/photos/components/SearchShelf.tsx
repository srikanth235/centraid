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
import type { SearchGroupHit } from "../search-groups.ts";
import { searchGroupOpenLabel } from "../search-groups.ts";
import type { SearchStatus } from "../search.ts";
import type { ShelfId } from "../shelves.ts";
import { SEARCH_COPY, SEARCH_EXAMPLES } from "../view-copy.ts";

import styles from "./SearchShelf.module.css";

const EMPTY_GROUPS: readonly SearchGroupHit[] = [];

export function SearchShelf({
  query,
  status,
  count,
  groups = EMPTY_GROUPS,
  onQuery,
  onClear,
  onRetry,
  onOpenGroup,
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
  /** The hits, once there are any. */
  children?: React.ReactNode;
}) {
  const searching = Boolean(query) && status === "searching";
  const unreachable = Boolean(query) && status === "unreachable";
  // A miss means EVERYTHING the miss body claims was checked came back
  // empty — not just the photo grid. `groups` (search-groups.ts) matches
  // people/places/albums/things independently of the FTS title/caption hits
  // `count` carries, so a query that names a real person with no matching
  // caption (say) still has a group hit to show. Calling that "no results"
  // while a person row sat unrendered would contradict the miss body's own
  // claim that people were searched too.
  const hasGroups = groups.length > 0;
  const none =
    Boolean(query) && status === "ready" && count === 0 && !hasGroups;
  const showResults =
    Boolean(query) && status === "ready" && (count > 0 || hasGroups);
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

      {query ? null : (
        <div className={styles.panel}>
          <p className={styles.eyebrow}>{SEARCH_COPY.resting.eyebrow}</p>
          <h2 className={styles.title}>{SEARCH_COPY.resting.title}</h2>
          <p className={styles.body}>{SEARCH_COPY.resting.body}</p>
          <div className={styles.examples}>
            {SEARCH_EXAMPLES.map((example) => (
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
          Searching your whole library.{" "}
          <span className={styles.num}>{count}</span>{" "}
          {count === 1 ? "match" : "matches"} from what is loaded on this device
          so far.
        </p>
      ) : null}

      {unreachable ? (
        <div className={styles.unreachable}>
          <p className={styles.eyebrow}>{SEARCH_COPY.unreachable.eyebrow}</p>
          <h2 className={styles.unreachableTitle}>
            {SEARCH_COPY.unreachable.title}
          </h2>
          <p className={styles.body}>
            It lives on the gateway. Nothing below has been searched for you —
            what you can see is the match over the photographs already loaded on
            this device, which is a smaller question than the one you asked.
          </p>
          <dl className={styles.facts}>
            {SEARCH_COPY.unreachable.facts.map((fact) => (
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
            {SEARCH_COPY.unreachable.retry}
          </button>
        </div>
      ) : null}

      {none ? (
        <div className={styles.panel}>
          <p className={styles.eyebrow}>{SEARCH_COPY.miss.eyebrow}</p>
          <h2 className={styles.title}>{SEARCH_COPY.miss.title(query)}</h2>
          <p className={styles.body}>{SEARCH_COPY.miss.body}</p>
          <button type="button" className="kit-btn" onClick={onClear}>
            {SEARCH_COPY.miss.clear}
          </button>
        </div>
      ) : null}

      {showResults ? (
        // The honesty line (§9, ~3959-3961): search.ts's `run()` is a live
        // `window.centraid.readAll`/`read` round trip to the gateway's index
        // on every keystroke, never a read of the loaded window — so "the
        // live library" is a literal claim, not a hopeful one. There is no
        // subtitle slot on the frame's app bar (`InlineAppBarContribution`
        // carries only `title`/`count`/`actions`), so this line lives on the
        // shelf itself rather than reaching into shared frame chrome for one
        // feature.
        //
        // RECONCILED AGAINST MOBILE (issue #711): mobile's `session.search`
        // resolves against the on-device replica, so its honest foot line is
        // "…searched the whole replica on this device" — a genuinely
        // different fact. This client's query (queries/search.ts) runs FTS5
        // over `core.content_item` on the gateway itself with no replica in
        // the path, so the handoff's literal "the live library" is kept
        // verbatim here rather than borrowed from mobile's wording.
        <p className={styles.resultsHead}>
          <span className={styles.num}>{count}</span>{" "}
          {count === 1 ? "result" : "results"} · searched the live library
        </p>
      ) : null}

      {showResults && groups.length > 0 ? (
        <ul className={styles.groups}>
          {groups.map((hit) => (
            <li key={`${hit.kind}:${hit.key}`} className={styles.groupRow}>
              <div className={styles.groupText}>
                <p className={styles.groupTitle}>{hit.title}</p>
                <p className={styles.groupMeta}>{hit.meta}</p>
              </div>
              {hit.here ? (
                <span className={styles.groupHere}>{hit.here}</span>
              ) : null}
              <button
                type="button"
                className={styles.groupOpen}
                aria-label={searchGroupOpenLabel(hit)}
                onClick={() => onOpenGroup?.(hit.targetShelf)}
              >
                Open →
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {query && !none ? children : null}
    </div>
  );
}
