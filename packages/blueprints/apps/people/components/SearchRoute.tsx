// Search (v12 handoff § Screens 3) — the field first, then the roster.
//
// Search is a band destination rather than a field on the roster (handoff
// deviation 1), so this screen leads with the input and then draws the SAME
// chips and the SAME rows the roster does — `applyRosterFilter` and `Row` are
// imported rather than re-implemented, because two definitions of "starred and
// overdue" is how two screens start disagreeing about one person.
//
// THE GATE HERE IS `status`, NOT `loading`. `loading` is the roster read; the
// search read has its own four honest states (`_shared/search-scaffold.ts`),
// and blanking the field while an unrelated read settles would take away the
// one control this screen exists for. `unreachable` draws no rows and no
// "nothing matches" — the frame's status line already says the index could not
// be reached (`people-copy.ts` STATUS.searchUnreachable), and a screen that
// answered "no matches" would be claiming it looked.
import type { ReactNode } from "react";

import { LoadingSkeleton } from "../../_shared/LoadingSkeleton.tsx";
import { agoLabel, daysSinceContact, isOverdue } from "../format.ts";
import { EMPTY, FIELDS, VERBS, filterChips } from "../people-copy.ts";
import type { RosterFilter, SearchRouteProps } from "../types.ts";
import { EmptyState } from "./EmptyState.tsx";
import { applyRosterFilter } from "./RosterRoute.tsx";
import { ChipRow, Row, SkeletonBlock, StarButton, Verb } from "./Shared.tsx";

import styles from "./shared.module.css";

// THIS SHELF HAS NO LINK FACTS. `queries/search.ts` answers the FTS index and
// nothing from the sharing plane, so its rows carry no `linked` at all: the
// two link chips are not drawn here (they would filter every result away), no
// avatar takes a ring, and a link filter carried in from the roster reads as
// `All` rather than as a shelf that silently found nothing.
const SEARCH_CHIPS = filterChips(false);

export function SearchRoute(props: SearchRouteProps): ReactNode {
  const filter: RosterFilter =
    props.filter === "linked" || props.filter === "unlinked"
      ? "all"
      : props.filter;
  const rows = applyRosterFilter(props.results, filter);

  let results: ReactNode = null;
  if (props.status === "resting") {
    results = <EmptyState title={EMPTY.searchIdle} />;
  } else if (props.status === "searching") {
    results = (
      <SkeletonBlock>
        <LoadingSkeleton rows={4} />
      </SkeletonBlock>
    );
  } else if (props.status === "ready") {
    results =
      rows.length === 0 ? (
        <EmptyState title={EMPTY.noMatch} />
      ) : (
        rows.map((person) => {
          const overdue = isOverdue(person);
          // THE SNIPPET IS THE SECOND LINE WHERE THERE IS ONE: it is the
          // passage the vault matched on, which answers "why is this row
          // here" better than the role the member already knows.
          const sub = person.snippet ?? person.role;
          return (
            <Row
              key={person.party_id}
              avatar={person}
              name={person.name}
              strong
              {...(sub ? { sub } : {})}
              {...(overdue
                ? { meta: agoLabel(daysSinceContact(person)), metaNet: true }
                : {})}
              onOpen={() => props.onOpenPerson(person.party_id)}
              star={
                <StarButton
                  name={person.name}
                  starred={person.starred}
                  onToggle={() => props.onToggleStar(person)}
                />
              }
            />
          );
        })
      );
  }

  return (
    <>
      {/* The field carries its name as `aria-label` and nothing on screen:
          the placeholder and the accessible name are the same sentence, and a
          visible label above them would be that sentence twice. */}
      <div className={styles.fieldRow}>
        <input
          className={styles.field}
          value={props.term}
          aria-label={FIELDS.searchPlaceholder}
          placeholder={FIELDS.searchPlaceholder}
          // Wrapped rather than passed as `ref={props.inputRef}`: handing the
          // prop straight to `ref` makes the compiler read every later
          // `props.…` in this render as a ref access (react-compiler `Refs`).
          ref={(el) => {
            props.inputRef(el);
          }}
          onChange={(event) => props.onTermChange(event.target.value)}
        />
        {props.term ? (
          <Verb
            label="✕"
            ariaLabel={VERBS.clearSearch}
            onClick={props.onClear}
          />
        ) : null}
      </div>
      <ChipRow
        label="Filter"
        options={SEARCH_CHIPS}
        active={filter}
        onSelect={(id) => props.onSelectFilter(id as RosterFilter)}
      />
      {results}
    </>
  );
}
