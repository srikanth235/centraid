import type { ReactNode } from "react";

import { LoadingSkeleton } from "../../_shared/LoadingSkeleton.tsx";
import { agoLabel, daysSinceContact, isOverdue } from "../format.ts";
import { EMPTY, FIELDS, VERBS, filterChips } from "../people-copy.ts";
import type { RosterFilter, SearchRouteProps } from "../types.ts";
import { EmptyState } from "./EmptyState.tsx";
import { applyRosterFilter } from "./RosterRoute.tsx";
import { ChipRow, Row, SkeletonBlock, StarButton, Verb } from "./Shared.tsx";

import styles from "./shared.module.css";

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
      {/* aria-label IS the placeholder — a visible label would repeat it. */}
      <div className={styles.fieldRow}>
        <input
          className={styles.field}
          value={props.term}
          aria-label={FIELDS.searchPlaceholder}
          placeholder={FIELDS.searchPlaceholder}
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
