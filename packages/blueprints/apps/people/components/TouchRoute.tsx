// Touch (v12 handoff § Screens 2) — what needs doing about people, in order.
//
// Four count tiles over three lists: who is overdue, which dated reminders
// come round next, and what has been logged. Nothing here is a second read —
// the `dashboard` query answers all four counts and all three lists, so this
// screen only chooses recipes.
//
// THE RECONNECT SUB-LINE IS `every <n> days · <ago>` where the cadence is
// known — `logic.ts` joins it in from the roster read — and the role where it
// is not, so the row never re-derives a column it was not handed.
//
// NOTHING HERE TOGGLES A REMINDER. `UpcomingCard` carries no `reminder_on`,
// so a trailing Mute/Remind could only guess which way it points. The toggle
// lives on the person screen, where the flag is read.
import type { ReactNode } from "react";

import { LoadingSkeleton } from "../../_shared/LoadingSkeleton.tsx";
import { displayText } from "../../_shared/untrusted.ts";
import {
  cadenceLabel,
  daysUntilMonthDay,
  inDaysLabel,
  monthDayLabel,
  whenLabel,
} from "../format.ts";
import { EMPTY, LABELS, SECTIONS, TOUCH_TILES, VERBS } from "../people-copy.ts";
import type { TouchRouteProps, TouchTile } from "../types.ts";
import { EmptyState } from "./EmptyState.tsx";
import { CountTiles, Row, Section, SkeletonBlock, Verb } from "./Shared.tsx";

export function TouchRoute(props: TouchRouteProps): ReactNode {
  const dashboard = props.dashboard;
  // A null dashboard is a read that has not landed, not a member with nothing
  // to do (`_shared/view-state-kit.ts`), so it takes the same gate `loading`
  // does — the three sections below can only be honestly empty past this line.
  if (props.loading || !dashboard) {
    return (
      <SkeletonBlock>
        <LoadingSkeleton rows={6} />
      </SkeletonBlock>
    );
  }

  const tiles = TOUCH_TILES.map((tile) => ({
    id: tile.id,
    label: tile.label,
    count: dashboard.counts[tile.id],
    net: tile.net,
  }));

  return (
    <>
      <CountTiles
        tiles={tiles}
        narrow={props.narrow}
        onSelect={(id) => props.onSelectTile(id as TouchTile)}
      />
      <Section title={SECTIONS.reconnect}>
        {dashboard.reconnect.length === 0 ? (
          <EmptyState title={EMPTY.reconnect} />
        ) : (
          dashboard.reconnect.map((person) => (
            <Row
              key={person.party_id}
              avatar={person}
              name={person.name}
              strong
              {...(person.cadence_days
                ? {
                    sub: `${cadenceLabel(person.cadence_days)} · ${whenLabel(
                      person.last_contacted_at ?? person.created_at
                    ).toLowerCase()}`,
                    subNumeric: true,
                  }
                : person.role
                  ? { sub: person.role }
                  : {})}
              onOpen={() => props.onOpenPerson(person.party_id)}
              trailing={
                <Verb
                  label={VERBS.log}
                  ariaLabel={LABELS.logFor(displayText(person.name))}
                  onClick={() => props.onLog(person.party_id)}
                />
              }
            />
          ))
        )}
      </Section>
      <Section title={SECTIONS.upcoming} ruled>
        {dashboard.upcoming.length === 0 ? (
          <EmptyState title={EMPTY.upcoming} />
        ) : (
          dashboard.upcoming.map((date) => (
            <Row
              key={date.date_id}
              avatar={date}
              name={date.name}
              strong
              sub={`${date.label} · ${monthDayLabel(date.month_day)}`}
              subNumeric
              meta={inDaysLabel(daysUntilMonthDay(date.month_day))}
              onOpen={() => props.onOpenPerson(date.party_id)}
            />
          ))
        )}
      </Section>
      <Section title={SECTIONS.recent} ruled>
        {dashboard.recent.length === 0 ? (
          <EmptyState title={EMPTY.recent} />
        ) : (
          dashboard.recent.map((touch) => (
            <Row
              key={touch.interaction_id}
              avatar={touch}
              name={touch.name}
              strong
              sub={touch.kind}
              meta={whenLabel(touch.occurred_at)}
              onOpen={() => props.onOpenPerson(touch.party_id)}
            />
          ))
        )}
      </Section>
    </>
  );
}
