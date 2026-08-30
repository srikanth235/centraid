import { useMemo, useRef } from "react";
import type { ReactNode } from "react";

import { LoadingSkeleton } from "../../_shared/LoadingSkeleton.tsx";
import { PendingWriteActions } from "../../_shared/PendingWriteActions.tsx";
import { uniformModel } from "../../_shared/virtual-window.ts";
import {
  useMeasuredBlockHeight,
  useScrollHost,
  useVirtualWindow,
  VirtualSpacer,
} from "../../_shared/VirtualWindow.tsx";
import { agoLabel, daysSinceContact, isOverdue, linkState } from "../format.ts";
import { EMPTY, FIRST_RUN, LINK, filterChips } from "../people-copy.ts";
import type { PersonRow, RosterFilter, RosterRouteProps } from "../types.ts";
import { EmptyState } from "./EmptyState.tsx";
import { Row, SkeletonBlock, StarButton, ChipRow } from "./Shared.tsx";

import styles from "./shared.module.css";

// A filter is a pure view predicate, never a second read; unknown link state
// matches neither link chip.
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
        <RosterRows
          rows={rows}
          onOpenPerson={props.onOpenPerson}
          onToggleStar={props.onToggleStar}
        />
      )}
    </>
  );
}

/** First-paint guess only; `useMeasuredBlockHeight` swaps in the real height. */
const ROW_RUNG_FALLBACK = 44;

/**
 * Windowed (#883 C4): the screen costs a viewport, not the roster.
 * `useVirtualWindow` pins the block focus is inside, so scrolling with the
 * caret cannot unmount it and drop focus to `<body>`. Selection is party ids
 * pruned against ROWS, never the DOM. Each row carries `aria-setsize` /
 * `aria-posinset` because the DOM no longer states the size of the set.
 */
function RosterRows({
  rows,
  onOpenPerson,
  onToggleStar,
}: {
  rows: readonly PersonRow[];
  onOpenPerson: (partyId: string) => void;
  onToggleStar: (person: PersonRow) => void;
}): ReactNode {
  const listRef = useRef<HTMLUListElement | null>(null);
  const scrollRef = useScrollHost(listRef);
  const rowHeight = useMeasuredBlockHeight(listRef, ROW_RUNG_FALLBACK);
  const model = useMemo(
    () => uniformModel(rows.length, rowHeight),
    [rows.length, rowHeight]
  );
  const slice = useVirtualWindow({ model, scrollRef, listRef });

  return (
    <ul className={styles.list} ref={listRef}>
      <VirtualSpacer height={slice.padStart} as="li" />
      {rows.slice(slice.start, slice.end).map((person, offset) => {
        const index = slice.start + offset;
        const overdue = isOverdue(person);
        const sub = rosterSub(person);
        return (
          <Row
            key={person.party_id}
            position={{ index, setSize: rows.length }}
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
            onOpen={() => onOpenPerson(person.party_id)}
            trailing={
              <PendingWriteActions
                row={person as unknown as Record<string, unknown>}
              />
            }
            star={
              <StarButton
                name={person.name}
                starred={person.starred}
                onToggle={() => onToggleStar(person)}
              />
            }
          />
        );
      })}
      <VirtualSpacer height={slice.padEnd} as="li" />
    </ul>
  );
}
