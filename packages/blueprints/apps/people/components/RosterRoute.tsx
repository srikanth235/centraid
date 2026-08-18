// The roster (v12 handoff § Screens 1) — the app's reference screen.
//
// Every other People screen is this one with different rows: a filter row, a
// flat list built out of the shared `Row` recipe, and one empty state that
// names its own reason. Nothing here describes a row, a chip or a metric —
// they all come from `Shared.tsx` and `shared.module.css`, which is what keeps
// the app to a single row definition.
//
// THE ROW'S SECOND LINE IS THE ROLE, and its meta slot carries `<n> days` in
// the consequence tone exactly while the person is overdue. The handoff leads
// that line with vault copy and gates the meta on "linked AND overdue"; no
// query returns a link, so the line is the role and the gate is the cadence
// alone (see people-copy.ts for the whole withheld set).
import type { ReactNode } from "react";

import { LoadingSkeleton } from "../../_shared/LoadingSkeleton.tsx";
import { agoLabel, daysSinceContact, isOverdue } from "../format.ts";
import { EMPTY, FILTER_CHIPS, FIRST_RUN } from "../people-copy.ts";
import type { PersonRow, RosterFilter, RosterRouteProps } from "../types.ts";
import { EmptyState } from "./EmptyState.tsx";
import { Row, SkeletonBlock, StarButton, ChipRow } from "./Shared.tsx";

/** The chips narrow the SAME set — a filter is a view of the roster, never a
 *  second read — so this is a pure predicate over the rows already in hand. */
export function applyRosterFilter(
  people: readonly PersonRow[],
  filter: RosterFilter,
  now = Date.now()
): PersonRow[] {
  if (filter === "starred") return people.filter((person) => person.starred);
  if (filter === "due")
    return people.filter((person) => isOverdue(person, now));
  return [...people];
}

export function RosterRoute(props: RosterRouteProps): ReactNode {
  if (props.loading) {
    return (
      <SkeletonBlock>
        <LoadingSkeleton rows={6} />
      </SkeletonBlock>
    );
  }

  // NOTHING IS EMPTY UNTIL A READ HAS LANDED (`_shared/view-state-kit.ts`),
  // which the `loading` gate above is: past it, an empty roster is a fact.
  // A member with no people at all gets the first run — the one screen in the
  // app that carries a display head and a commit of its own; a member whose
  // FILTER matched nothing gets a sentence, because the way forward is the
  // chip they just pressed.
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
        options={FILTER_CHIPS}
        active={props.filter}
        onSelect={(id) => props.onSelectFilter(id as RosterFilter)}
      />
      {rows.length === 0 ? (
        <EmptyState title={EMPTY.noMatch} />
      ) : (
        rows.map((person) => {
          const overdue = isOverdue(person);
          return (
            <Row
              key={person.party_id}
              avatar={person}
              name={person.name}
              strong
              {...(person.role ? { sub: person.role } : {})}
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
