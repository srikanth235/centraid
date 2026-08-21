// PEOPLE ON THE PHONE — the three band destinations, on one screen
// (Binding Layer v12 handoff Part 1, issue #821).
//
// `People` (the roster), `Touch` (the keep-in-touch summary) and `Search` all
// live here, switched by the band exactly the way `PhotosHome` switches its
// shelves: the `destination` route param names where a band tap on a PUSHED
// screen lands, and the effect below keeps a mounted Home following it.
//
// WHAT THE ROSTER ROW WITHHOLDS: the handoff's trailing `Link` verb on an
// unlinked row. A link is made from a container and People owns none
// (decisions.md #821 L-write), so the ring and the sub-line SAY the link state
// and no control here pretends to change it. The full register is
// `INTEGRATION-NOTES.md`.

import { FlashList } from "@shopify/flash-list";
import React, { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import {
  agoLabel,
  cadenceLabel,
  daysSinceContact,
  daysUntilMonthDay,
  inDaysLabel,
  isOverdue,
  monthDayLabel,
  whenLabel,
} from "@centraid/blueprints/apps/people/format";
import {
  APP_TITLE,
  EMPTY,
  FIELDS,
  FIRST_RUN,
  LABELS,
  LINK_TOUCH_TILES,
  SEARCH_TITLE,
  SECTIONS,
  STATUS,
  TOUCH_TILES,
  TOUCH_TITLE,
  VERBS,
  filterChips,
} from "@centraid/blueprints/apps/people/people-copy";
import type {
  PersonRow as PersonRowModel,
  RosterFilter,
  TouchCounts,
} from "@centraid/blueprints/apps/people/types";

import ChipsBlock from "../../kit/components/ChipsBlock";
import EmptyBlock from "../../kit/components/EmptyBlock";
import { TextInput } from "../../kit/components/NativeText";
import PlaceHeader from "../../kit/components/PlaceHeader";
import SkeletonRows from "../../kit/components/SkeletonRows";
import TopSafeArea from "../../kit/components/TopSafeArea";
import ReplicaStateCard from "../../kit/replica/ReplicaStateCard";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import {
  borders,
  pageMargin,
  radii,
  spacing,
  t,
  useTheme,
} from "../../kit/theme";
import type { PeopleScreenProps } from "../../navigation";
import type { PeopleBandKey } from "./people-band";
import { applyRosterFilter, rosterSub, searchRoster } from "./people-model";
import { usePeopleWrites } from "./people-writes";
import {
  Caption,
  CountTiles,
  EmptyLine,
  PeopleSection,
  PersonRow,
  StarButton,
  Verb,
} from "./PeopleKit";
import PeopleScreen from "./PeopleScreen";
import { usePeople } from "./usePeople";

export default function PeopleHome({
  navigation,
  route,
}: PeopleScreenProps<"PeopleHome">): React.JSX.Element {
  const data = usePeople();
  const writes = usePeopleWrites(() =>
    navigation.navigate("Settings", { screen: "Approvals" })
  );

  // The band on a pushed People screen navigates here with the destination it
  // wants; React Navigation updates params without remounting, so the effect
  // is what makes the band work from a pushed screen at all (PhotosHome's own
  // pattern, stated there in full).
  const [destination, setDestination] = useState<PeopleBandKey>(
    route.params?.destination === "touch"
      ? "touch"
      : route.params?.destination === "search"
        ? "search"
        : "people"
  );
  const routeDestination = route.params?.destination;
  useEffect(() => {
    if (routeDestination)
      queueMicrotask(() => setDestination(routeDestination));
  }, [routeDestination]);

  const [filter, setFilter] = useState<RosterFilter>("all");
  const [term, setTerm] = useState("");

  const openPerson = (partyId: string): void =>
    navigation.navigate("Person", { personId: partyId });

  const title =
    destination === "touch"
      ? TOUCH_TITLE
      : destination === "search"
        ? SEARCH_TITLE
        : APP_TITLE;

  return (
    <PeopleScreen current={destination}>
      <TopSafeArea edges={[]} style={styles.page}>
        <View style={styles.head}>
          <PlaceHeader
            title={title}
            {...(destination === "people"
              ? {
                  primary: {
                    label: VERBS.add,
                    onPress: () => navigation.navigate("PersonEditor"),
                  },
                  secondary: {
                    label: VERBS.trash,
                    onPress: () => navigation.navigate("PeopleTrash"),
                  },
                }
              : {})}
          />
        </View>
        <ReplicaStatusBar />
        {destination === "people" ? (
          <RosterBody
            data={data}
            filter={filter}
            onFilter={setFilter}
            onOpen={openPerson}
            onStar={(person) => void writes.toggleStar(person)}
            onAdd={() => navigation.navigate("PersonEditor")}
          />
        ) : destination === "touch" ? (
          <TouchBody
            data={data}
            onOpen={openPerson}
            onLog={(partyId) =>
              navigation.navigate("PersonLog", { personId: partyId })
            }
            onTile={(tile) => {
              // Each tile filters or navigates (handoff § Screens 2): the
              // people-counting tiles land on the roster with the matching
              // chip; Reconnect lands on the `Overdue` chip the copy table
              // added for exactly this tap; Upcoming stays here, where the
              // Upcoming section is one screen inch below.
              if (tile === "upcoming" || tile === "reconnect") {
                if (tile === "reconnect") {
                  setFilter("due");
                  setDestination("people");
                }
                return;
              }
              setFilter(
                tile === "linked"
                  ? "linked"
                  : tile === "to_link"
                    ? "unlinked"
                    : tile === "starred"
                      ? "starred"
                      : "all"
              );
              setDestination("people");
            }}
          />
        ) : (
          <SearchBody
            data={data}
            term={term}
            onTerm={setTerm}
            filter={filter}
            onFilter={setFilter}
            onOpen={openPerson}
            onStar={(person) => void writes.toggleStar(person)}
          />
        )}
      </TopSafeArea>
    </PeopleScreen>
  );
}

type Data = ReturnType<typeof usePeople>;

function RosterBody({
  data,
  filter,
  onFilter,
  onOpen,
  onStar,
  onAdd,
}: {
  data: Data;
  filter: RosterFilter;
  onFilter: (filter: RosterFilter) => void;
  onOpen: (partyId: string) => void;
  onStar: (person: PersonRowModel) => void;
  onAdd: () => void;
}): React.JSX.Element {
  const rows = useMemo(
    () => applyRosterFilter(data.people, filter),
    [data.people, filter]
  );
  if (data.connection === "unavailable" || data.error) {
    return (
      <View style={styles.body}>
        <ReplicaStateCard
          connection={data.connection}
          error={data.error}
          unavailableReason={data.unavailableReason}
          noun="People"
        />
      </View>
    );
  }
  if (data.loading) {
    return (
      <View style={styles.body}>
        <SkeletonRows accessibilityLabel="Reading people" />
      </View>
    );
  }
  // Past the loading gate an empty roster is a fact: the first run, the one
  // screen in the app with a display head and a filled commit of its own.
  if (data.people.length === 0) {
    return (
      <View style={styles.body}>
        <EmptyBlock
          title={FIRST_RUN.title}
          body={FIRST_RUN.body}
          action={{ label: FIRST_RUN.action, onPress: onAdd }}
        />
      </View>
    );
  }
  const chips = filterChips(data.linksAvailable);
  return (
    <View style={styles.body}>
      <ChipsBlock
        accessibilityLabel="Filter"
        chips={chips.map((chip) => ({
          id: chip.id,
          label: chip.label,
          on: chip.id === filter,
          onPress: () => onFilter(chip.id as RosterFilter),
        }))}
      />
      {rows.length === 0 ? (
        <EmptyLine text={EMPTY.noMatch} />
      ) : (
        <FlashList
          data={rows}
          keyExtractor={(person) => person.party_id}
          renderItem={({ item }) => (
            <RosterRow person={item} onOpen={onOpen} onStar={onStar} />
          )}
        />
      )}
    </View>
  );
}

function RosterRow({
  person,
  onOpen,
  onStar,
}: {
  person: PersonRowModel;
  onOpen: (partyId: string) => void;
  onStar: (person: PersonRowModel) => void;
}): React.JSX.Element {
  const overdue = isOverdue(person);
  const sub = rosterSub(person);
  return (
    <PersonRow
      avatar={person}
      avatarLink={
        person.linked === true
          ? "linked"
          : person.linked === false
            ? "unlinked"
            : "unknown"
      }
      name={person.name}
      {...(sub ? { sub } : {})}
      {...(overdue
        ? { meta: agoLabel(daysSinceContact(person)), metaNet: true }
        : {})}
      onOpen={() => onOpen(person.party_id)}
      star={
        <StarButton
          name={person.name}
          starred={person.starred}
          onToggle={() => onStar(person)}
        />
      }
    />
  );
}

function TouchBody({
  data,
  onOpen,
  onLog,
  onTile,
}: {
  data: Data;
  onOpen: (partyId: string) => void;
  onLog: (partyId: string) => void;
  onTile: (tile: string) => void;
}): React.JSX.Element {
  if (data.loading) {
    return (
      <View style={styles.body}>
        <SkeletonRows accessibilityLabel="Reading the keep-in-touch summary" />
      </View>
    );
  }
  const dashboard = data.dashboard;
  const counts = dashboard.counts;
  // Two tile sets, one row: the handoff's own four while the sharing plane
  // answers, the people-counting four while it cannot — a `Vaults` tile
  // reading 0 over a denied read would be a count nobody took.
  const tiles =
    counts.linked === null || counts.to_link === null
      ? TOUCH_TILES.map((tile) => ({
          id: tile.id,
          label: tile.label,
          count: Number(counts[tile.id as keyof TouchCounts] ?? 0),
          net: tile.net,
        }))
      : LINK_TOUCH_TILES.map((tile) => ({
          id: tile.id,
          label: tile.label,
          count:
            tile.id === "linked"
              ? (counts.linked ?? 0)
              : tile.id === "to_link"
                ? (counts.to_link ?? 0)
                : Number(counts[tile.id as keyof TouchCounts] ?? 0),
          net: tile.net,
        }));
  return (
    <ScrollView style={styles.body} contentContainerStyle={styles.scroll}>
      <CountTiles tiles={tiles} onSelect={onTile} />
      <PeopleSection title={SECTIONS.reconnect}>
        {dashboard.reconnect.length === 0 ? (
          <EmptyLine text={EMPTY.reconnect} />
        ) : (
          dashboard.reconnect.map((person, index) => (
            <PersonRow
              key={person.party_id}
              avatar={{ ...person, avatar_color: person.avatar_color }}
              name={person.name}
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
              onOpen={() => onOpen(person.party_id)}
              trailing={
                <Verb
                  label={VERBS.log}
                  accessibilityLabel={LABELS.logFor(person.name)}
                  onPress={() => onLog(person.party_id)}
                />
              }
              last={index === dashboard.reconnect.length - 1}
            />
          ))
        )}
      </PeopleSection>
      <PeopleSection title={SECTIONS.upcoming}>
        {dashboard.upcoming.length === 0 ? (
          <EmptyLine text={EMPTY.upcoming} />
        ) : (
          dashboard.upcoming.map((date, index) => (
            <PersonRow
              key={date.date_id}
              avatar={date}
              name={date.name}
              sub={`${date.label} · ${monthDayLabel(date.month_day)}`}
              subNumeric
              meta={inDaysLabel(daysUntilMonthDay(date.month_day))}
              onOpen={() => onOpen(date.party_id)}
              last={index === dashboard.upcoming.length - 1}
            />
          ))
        )}
      </PeopleSection>
      <PeopleSection title={SECTIONS.recent}>
        {dashboard.recent.length === 0 ? (
          <EmptyLine text={EMPTY.recent} />
        ) : (
          dashboard.recent.map((touch, index) => (
            <PersonRow
              key={touch.interaction_id}
              avatar={touch}
              name={touch.name}
              sub={touch.kind}
              meta={whenLabel(touch.occurred_at)}
              onOpen={() => onOpen(touch.party_id)}
              last={index === dashboard.recent.length - 1}
            />
          ))
        )}
      </PeopleSection>
    </ScrollView>
  );
}

// THIS SHELF SEARCHES THE WINDOW IN HAND — name, role and notes,
// case-insensitive substring (handoff § Screens 3) — and draws NO link facts:
// the web search query returns none, and the same person must not read two
// different ways on two screens, so its rows carry no ring and the two link
// chips are not offered.
const SEARCH_CHIPS = filterChips(false);

function SearchBody({
  data,
  term,
  onTerm,
  filter,
  onFilter,
  onOpen,
  onStar,
}: {
  data: Data;
  term: string;
  onTerm: (term: string) => void;
  filter: RosterFilter;
  onFilter: (filter: RosterFilter) => void;
  onOpen: (partyId: string) => void;
  onStar: (person: PersonRowModel) => void;
}): React.JSX.Element {
  const { colors, targetMin } = useTheme();
  const active: RosterFilter =
    filter === "linked" || filter === "unlinked" ? "all" : filter;
  const results = useMemo(
    () =>
      applyRosterFilter(
        searchRoster(data.people, data.notesByParty, term).map((person) => ({
          ...person,
          // No link facts on this shelf — see the head of this block.
          linked: undefined,
        })),
        active
      ),
    [active, data.notesByParty, data.people, term]
  );
  return (
    <View style={styles.body}>
      <View style={styles.searchRow}>
        <TextInput
          accessibilityLabel={FIELDS.searchPlaceholder}
          autoFocus
          value={term}
          placeholder={FIELDS.searchPlaceholder}
          placeholderTextColor={colors.textFaint}
          onChangeText={onTerm}
          style={[
            t("body"),
            {
              borderColor: colors.line,
              borderRadius: radii.md,
              borderWidth: borders.hairline,
              color: colors.text,
              flex: 1,
              minHeight: targetMin.coarse,
              paddingHorizontal: spacing[3],
            },
          ]}
        />
        {term ? (
          <Verb
            label="✕"
            quiet
            accessibilityLabel={VERBS.clearSearch}
            onPress={() => onTerm("")}
          />
        ) : null}
      </View>
      <ChipsBlock
        accessibilityLabel="Filter"
        chips={SEARCH_CHIPS.map((chip) => ({
          id: chip.id,
          label: chip.label,
          on: chip.id === active,
          onPress: () => onFilter(chip.id as RosterFilter),
        }))}
      />
      {term.trim() === "" ? (
        <EmptyLine text={EMPTY.searchIdle} />
      ) : results.length === 0 ? (
        <EmptyLine text={EMPTY.noMatch} />
      ) : (
        <FlashList
          data={results}
          keyExtractor={(person) => person.party_id}
          renderItem={({ item }) => (
            <SearchRow person={item} onOpen={onOpen} onStar={onStar} />
          )}
        />
      )}
      {term.trim() ? (
        // The web frame's ambient status sentence; the phone has no ambient
        // status surface (`kit/components/StatusLine.tsx` is quiet until a
        // write posts), so the one sentence a query earns sits as the
        // screen's own closing line instead.
        <Caption
          text={STATUS.searchResults(results.length, data.people.length)}
        />
      ) : null}
    </View>
  );
}

function SearchRow({
  person,
  onOpen,
  onStar,
}: {
  person: PersonRowModel;
  onOpen: (partyId: string) => void;
  onStar: (person: PersonRowModel) => void;
}): React.JSX.Element {
  const overdue = isOverdue(person);
  // The snippet answers "why is this row here" better than the role the
  // member already knows.
  const sub = person.snippet ?? person.role;
  return (
    <PersonRow
      avatar={person}
      name={person.name}
      {...(sub ? { sub } : {})}
      {...(overdue
        ? { meta: agoLabel(daysSinceContact(person)), metaNet: true }
        : {})}
      onOpen={() => onOpen(person.party_id)}
      star={
        <StarButton
          name={person.name}
          starred={person.starred}
          onToggle={() => onStar(person)}
        />
      }
    />
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingHorizontal: pageMargin },
  head: { paddingHorizontal: pageMargin },
  page: { flex: 1 },
  scroll: { paddingBottom: spacing[6] },
  searchRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
    paddingBottom: spacing[3],
  },
});
