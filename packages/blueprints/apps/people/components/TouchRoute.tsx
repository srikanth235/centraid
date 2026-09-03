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
import {
  EMPTY,
  LABELS,
  LINK_TOUCH_TILES,
  SECTIONS,
  TOUCH_TILES,
  VERBS,
} from "../people-copy.ts";
import type { TouchCounts, TouchRouteProps, TouchTile } from "../types.ts";
import { EmptyState } from "./EmptyState.tsx";
import { CountTiles, Row, Section, SkeletonBlock, Verb } from "./Shared.tsx";

export function TouchRoute(props: TouchRouteProps): ReactNode {
  const dashboard = props.dashboard;
  if (props.loading || !dashboard) {
    return (
      <SkeletonBlock>
        <LoadingSkeleton rows={6} />
      </SkeletonBlock>
    );
  }

  const counts = dashboard.counts;
  const linked = counts.linked;
  const toLink = counts.to_link;
  const tiles =
    linked === null || toLink === null
      ? TOUCH_TILES.map((tile) => ({
          id: tile.id,
          label: tile.label,
          count: counts[tile.id as keyof TouchCounts] ?? 0,
          net: tile.net,
        }))
      : LINK_TOUCH_TILES.map((tile) => ({
          id: tile.id,
          label: tile.label,
          count:
            tile.id === "linked"
              ? linked
              : tile.id === "to_link"
                ? toLink
                : (counts[tile.id as keyof TouchCounts] ?? 0),
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
