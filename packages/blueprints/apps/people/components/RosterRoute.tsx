// The roster — the app's reference screen; rows/chips/metrics come from Shared.tsx.
import type { ReactNode } from "react";

import { LoadingSkeleton } from "../../_shared/LoadingSkeleton.tsx";
import { agoLabel, daysSinceContact, isOverdue, linkState } from "../format.ts";
import { EMPTY, FIRST_RUN, LINK, filterChips } from "../people-copy.ts";
import type { PersonRow, RosterFilter, RosterRouteProps } from "../types.ts";
import { EmptyState } from "./EmptyState.tsx";
import { Row, SkeletonBlock, StarButton, ChipRow } from "./Shared.tsx";

// Pure view predicate — a filter is never a second read. Unknown link state
// matches NEITHER link chip.
export function applyRosterFilter(
  people: readonly PersonRow[],
  filter: RosterFilter,
  now = Date.now()
): PersonRow[] {
  if (filter === "starred") return people.filter((person) => person.starred);
  if (filter === "due")
    return people.filter((person) => isOverdue(person, now));
  if (filter === "linked" || filter === "unlinked")
    return people.filter((person) => linkState(person) === filter);
  return [...people];
}

// `Linked · <role>`, or the role alone; nothing for unlinked+roleless.
export function rosterSub(person: PersonRow): string {
  if (linkState(person) !== "linked") return person.role;
  return person.role ? `${LINK.linked} · ${person.role}` : LINK.linked;
}

export function RosterRoute(props: RosterRouteProps): ReactNode {
  if (props.loading) {
    return (
      <SkeletonBlock>
        <LoadingSkeleton rows={6} />
      </SkeletonBlock>
    );
  }

  // Empty past the loading gate: no people → first run; no filter match → EMPTY sentence.
  if (props.people.length === 0) {
    return (
      <EmptyState
        variant="first-run"
        title={FIRST_RUN.title}
        body={FIRST_RUN.body}
        action={FIRST_RUN.action}
        onAction={props.onAddPerson}
      />
    );
  }

  const rows = applyRosterFilter(props.people, props.filter);

  return (
    <>
      <ChipRow
        label="Filter"
        options={filterChips(props.linksAvailable)}
        active={props.filter}
        onSelect={(id) => props.onSelectFilter(id as RosterFilter)}
      />
      {rows.length === 0 ? (
        <EmptyState title={EMPTY.noMatch} />
      ) : (
        rows.map((person) => {
          const overdue = isOverdue(person);
          const sub = rosterSub(person);
          return (
            <Row
              key={person.party_id}
              avatar={person}
              avatarLink={linkState(person)}
              name={person.name}
              strong
              {...(sub ? { sub } : {})}
              {...(overdue
                ? {
                    meta: agoLabel(daysSinceContact(person)),
                    metaNet: true,
                  }
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
      )}
    </>
  );
}
