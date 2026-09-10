// Agenda on the phone: Day, Schedule and Waiting on, with the band the app
// has claimed carrying those three plus Search.
//
// THERE IS NO MONTH OR WEEK GRID HERE. A seven-column grid at 390pt gives
// 42pt cells, under the 44pt tap-target floor, so neither is a destination —
// decided once in the blueprint table `agenda-band.ts` derives from.
//
// THE GRID IS FOR THINGS WITH A TIME COST: every row below came from
// `core.event`. The day-context layers decorate a day and NEVER become a row
// (#834): a birthday rides the day header as a ribbon, and the member's own
// tasks coming due sit under it as one collapsed shelf that opens on tap. A
// tap-through leaves for Tasks, which is the room that owns the task —
// Agenda shows the fact and never edits it.
//
// The held-write mark is drawn INLINE (a 2pt inline-start rule and the words),
// not through a shared component: it is two elements, and a kit file for it
// would be a dependency for nothing.

import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, View } from "react-native";
import type { ListRenderItemInfo } from "react-native";

import { DAY_MS } from "@centraid/blueprints/apps/_shared/format-kit";

import { useBandOwner } from "../../kit/band/band-owner";
import Button from "../../kit/components/Button";
import { Text } from "../../kit/components/NativeText";
import OptionSheet from "../../kit/components/OptionSheet";
import { formatMonth, formatRelative } from "../../kit/format";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import AppPlace from "../../kit/rooms/AppPlace";
import { readFailure } from "../../kit/rooms/read-failure";
import type { RoomEmpty, RoomError } from "../../kit/rooms/room-contracts";
import { TEST_IDS } from "../../kit/test-ids";
import { useTheme } from "../../kit/theme";
import {
  BIRTHDAY_LEAD_DEFAULT_DAYS,
  BIRTHDAY_LEADS,
  birthdayLeadPhrase,
} from "../../lib/birthday-notifications";
import { resolveAppMeta } from "../../lib/gateway";
import type { AgendaScreenProps } from "../../navigation";
import VaultBar from "../../screens/home/VaultBar";
import type { AgendaBandDestinationKey } from "./agenda-band";
import type { AgendaDay } from "./agenda-day-model";
import { groupEventsByLocalDay } from "./agenda-days";
import AgendaBand from "./AgendaBand";
import AgendaCreateModal from "./AgendaCreateModal";
import type { AgendaCreateInput } from "./AgendaCreateModal";
import { useBirthdayNotifications } from "./AgendaDayContext";
import AgendaDayRow from "./AgendaDayRow";
import { styles } from "./AgendaHome.styles";
import { birthdaysOn, dayKeyOf as contextDayKey, dueOn } from "./day-context";
import type { NativeAgendaEvent } from "./useAgenda";
import { useAgenda } from "./useAgenda";

/** What the surface is showing. `search` and `more` are band destinations that
 *  open a field and a sheet rather than replacing the list. */
type Surface = "day" | "schedule" | "waiting";

const dayKeyOf = (row: AgendaDay): string => row.key;
/** One shared identity for "nothing to list": a fresh `[]` per render would
 *  make FlatList re-diff a list it already knows is empty. */
const NO_DAYS: AgendaDay[] = [];
/** The app's own mark and hue, from the one builtin table. */
const AGENDA = resolveAppMeta({ id: "agenda" });

const BIRTHDAY_LEAD_KEY = "centraid:birthday-lead-days:v1";
const BIRTHDAY_LEAD_ROW = "birthday-lead";

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function awaitsMe(
  event: NativeAgendaEvent,
  attendees: readonly Record<string, unknown>[],
  me: string | undefined
): boolean {
  if (!me) return false;
  return attendees.some(
    (row) =>
      String(row["event_id"]) === event.id &&
      String(row["party_id"]) === me &&
      (row["partstat"] === undefined ||
        row["partstat"] === "" ||
        row["partstat"] === "needs-action")
  );
}

export default function AgendaHome({
  navigation,
  route,
}: AgendaScreenProps<"AgendaHome">): React.JSX.Element {
  const { colors } = useTheme();
  const { refresh, session } = useReplica();
  // The frame's latch, per app — handing the band back on one Agenda surface
  // hands it back on all of them.
  const { bandOwner } = useBandOwner("agenda");

  const [surface, setSurface] = useState<Surface>(
    route.params?.destination ?? "day"
  );
  // THE DAY THIS SURFACE IS ANCHORED ON (#1015, audit agenda/findings#3). It
  // used to be `new Date()` with the only writer setting it to `new Date()`
  // again, so no day but today was reachable anywhere in the app and the
  // "Go to today" control was a no-op on every screen it appeared on.
  const [anchor, setAnchor] = useState(() => new Date());
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  /** How far ahead the phone tells the member about an inner-circle birthday.
   *  A DEVICE preference by construction: reminder delivery is the phone's
   *  alone, so the lead belongs to the phone that delivers it (#834). */
  const [leadOpen, setLeadOpen] = useState(false);
  const [leadDays, setLeadDays] = useState(BIRTHDAY_LEAD_DEFAULT_DAYS);
  /** Calendars the member has switched off. The rail that carries this on a
   *  pointer surface has no room on the phone, so it lives in the band's
   *  overflow sheet — a filter is not a destination. */
  const [hiddenCalendars, setHiddenCalendars] = useState<Set<string>>(
    () => new Set()
  );

  // The bounded window each surface reads. Day is one day; the two lists look
  // forward from the anchor, capped so a read never grows with the vault.
  const range = useMemo(() => {
    const from = startOfDay(anchor);
    return surface === "day"
      ? ([from, new Date(from.getTime() + DAY_MS)] as const)
      : ([from, new Date(from.getTime() + 120 * DAY_MS)] as const);
  }, [anchor, surface]);

  const agenda = useAgenda(range[0], range[1]);

  // The member's stored lead, read once. An unreadable store is not an error:
  // the default lead is a real answer, and the notification still lands.
  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(BIRTHDAY_LEAD_KEY)
      .then((raw) => {
        const days = Number(raw);
        if (!cancelled && raw !== null && Number.isFinite(days))
          setLeadDays(days);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useBirthdayNotifications(agenda.parties, agenda.starred, leadDays);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return agenda.events.filter((event) => {
      if (
        needle &&
        !event.summary.toLowerCase().includes(needle) &&
        !event.description?.toLowerCase().includes(needle)
      )
        return false;
      if (event.calendarId && hiddenCalendars.has(event.calendarId))
        return false;
      if (surface !== "waiting") return true;
      return awaitsMe(event, agenda.attendees, agenda.ownerPartyId);
    });
  }, [
    agenda.attendees,
    agenda.events,
    agenda.ownerPartyId,
    hiddenCalendars,
    query,
    surface,
  ]);

  // One row per DAY the event occupies — not just the start day. A Friday–
  // Sunday run must still paint Saturday (`spanLocalDays`, same as the web grid).
  const days = useMemo<AgendaDay[]>(() => {
    return groupEventsByLocalDay(visible).map((bucket) => {
      const dayKey = contextDayKey(bucket.date);
      return {
        key: bucket.key,
        date: bucket.date,
        events: bucket.events,
        ribbon: birthdaysOn(dayKey, agenda.parties, agenda.starred),
        due: dueOn(dayKey, agenda.dueTasks),
      };
    });
  }, [agenda.dueTasks, agenda.parties, agenda.starred, visible]);

  /** Hand a task to Tasks. A NAVIGATION, never an edit. */
  const openTask = useCallback((): void => {
    navigation.navigate("Tasks");
  }, [navigation]);

  const openEvent = useCallback(
    (event: NativeAgendaEvent): void => {
      navigation.navigate("AgendaEvent", {
        eventId: event.id,
        instanceKey: event.instanceKey,
      });
    },
    [navigation]
  );

  /**
   * Propose the event. The write is OPTIMISTIC and its outcome lands on the
   * shared status line: `parked` sends the member to Approvals, `queued` says
   * the phone is holding it, and a refusal names itself.
   */
  const create = async (input: AgendaCreateInput): Promise<boolean> => {
    if (!session) return false;
    try {
      const result = await session.write("agenda", {
        action: "propose",
        input,
      });
      return surfaceWriteOutcome(result, {
        onParked: () =>
          navigation.navigate("Settings", { screen: "Approvals" }),
        queuedMessage: "This event syncs when the gateway reconnects.",
        failureTitle: "Event not created",
      });
    } catch (error) {
      surfaceWriteFailure(error, "Event not created");
      return false;
    }
  };

  const refreshAgenda = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await refresh?.();
    } finally {
      setRefreshing(false);
    }
  };

  const onDestination = (key: AgendaBandDestinationKey): void => {
    if (key === "search") {
      setSearchOpen(true);
      return;
    }
    if (key === "more") {
      setMoreOpen(true);
      return;
    }
    setSurface(key);
  };

  const renderDay = useCallback(
    ({ item, index }: ListRenderItemInfo<AgendaDay>): React.JSX.Element => (
      <AgendaDayRow
        day={item}
        colors={colors}
        // The month is drawn on the first row of each month, so a hundred and
        // twenty days no longer turn September into October in silence
        // (#1015, audit agenda/findings#4).
        month={index === 0 || !sameMonth(item.date, days[index - 1]?.date)}
        onOpen={openEvent}
        onOpenTask={openTask}
      />
    ),
    [colors, days, openEvent, openTask]
  );

  const today = new Date();
  const onToday = startOfDay(anchor).getTime() === startOfDay(today).getTime();
  const stepDay = (delta: number): void =>
    setAnchor((current) => new Date(current.getTime() + delta * DAY_MS));

  const listData = agenda.connection === "unavailable" ? NO_DAYS : days;

  const unreachable = agenda.connection === "unavailable";
  // ERROR OUTRANKS EMPTY (`RoomBody`): a calendar that could not be read is
  // not an empty calendar, and this surface used to draw both at once.
  // The app is Agenda everywhere else in the product; only its error card
  // still called it Calendar (#1015 agenda/findings#18). And the read's own
  // exception is not the member's to read (S14) — `readFailure` writes both
  // sentences, `useSeatPages` logs the raw string.
  const roomError: RoomError | undefined = readFailure({
    failed: Boolean(agenda.error),
    noun: "Agenda",
    onRetry: () => void refreshAgenda(),
    unavailableReason: agenda.unavailableReason,
    unreachable,
  });

  const roomEmpty: RoomEmpty | undefined =
    !roomError && !agenda.loading && listData.length === 0
      ? {
          body:
            query.trim() === ""
              ? "Every event with a time cost lands here."
              : "Try fewer words, or a different day.",
          routine: true,
          title:
            query.trim() === ""
              ? surface === "waiting"
                ? "Nothing is waiting on your answer"
                : "Nothing on these days"
              : "Nothing matches that",
        }
      : undefined;

  const chrome = (
    <>
      <VaultBar />
      <ReplicaStatusBar />
    </>
  );
  const band = (): React.JSX.Element => (
    <AgendaBand
      owner={bandOwner}
      current={surface}
      onSelect={onDestination}
      // HOME via popTo — `goBack()` is a no-op under a deep link and
      // `navigate` pushes a second Home on React Navigation 7.
      onHome={() => navigation.popTo("Home")}
    />
  );

  return (
    <AppPlace
      action={{
        label: "New event",
        onPress: () => setCreateOpen(true),
        testID: TEST_IDS.agenda.newEvent,
      }}
      app={{
        color: AGENDA.color,
        iconKey: AGENDA.iconKey,
        title: "Agenda",
        subtitle: formatMonth(anchor),
      }}
      band={band}
      chrome={chrome}
      {...(roomEmpty ? { empty: roomEmpty } : {})}
      {...(roomError ? { error: roomError } : {})}
      {...(agenda.loading && listData.length === 0
        ? { loading: { label: "Opening your calendar", rows: 6 } }
        : {})}
      onBack={() => navigation.popTo("Home")}
      overlay={
        <>
          <OptionSheet
            visible={moreOpen}
            title="Calendars"
            options={[
              ...agenda.calendars.map((calendar) => {
                const id = String(calendar["calendar_id"] ?? "");
                return {
                  id,
                  label: String(calendar["name"] ?? "Calendar"),
                  detail: hiddenCalendars.has(id) ? "Hidden" : "Shown",
                };
              }),
              {
                id: BIRTHDAY_LEAD_ROW,
                label: "Birthday reminder",
                detail: `Inner circle · ${birthdayLeadPhrase(leadDays)}`,
              },
            ]}
            onSelect={(id) => {
              setMoreOpen(false);
              if (id === BIRTHDAY_LEAD_ROW) {
                setLeadOpen(true);
                return;
              }
              setHiddenCalendars((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            onClose={() => setMoreOpen(false)}
          />

          {/* Only the inner circle notifies; everyone else stays a ribbon on
              the day, which is what the sheet's own line says. */}
          <OptionSheet
            visible={leadOpen}
            title="Birthday reminder"
            selectedId={String(leadDays)}
            options={BIRTHDAY_LEADS.map((lead) => ({
              id: String(lead.days),
              label: lead.label,
              detail: lead.days === 0 ? "On the day" : "Ahead of the day",
            }))}
            onSelect={(id) => {
              setLeadOpen(false);
              const chosenLead = Number(id);
              if (!Number.isFinite(chosenLead)) return;
              setLeadDays(chosenLead);
              void AsyncStorage.setItem(BIRTHDAY_LEAD_KEY, id).catch(
                () => undefined
              );
            }}
            onClose={() => setLeadOpen(false)}
          />

          <AgendaCreateModal
            visible={createOpen}
            calendars={agenda.calendars}
            parties={agenda.parties}
            defaultCalendarId={String(agenda.calendars[0]?.calendar_id ?? "")}
            onClose={() => setCreateOpen(false)}
            onCreate={create}
          />
        </>
      }
      {...(searchOpen
        ? {
            search: {
              accessibilityLabel: "Search events",
              onChangeText: setQuery,
              onClear: () => setSearchOpen(false),
              placeholder: "Search events",
              value: query,
            },
          }
        : {})}
      toolbar={
        <>
          {/* THE DAY BAR (#1015, findings#3): the anchor, and a step either side
          of it. `Go to today` is a real control now — it can only be pressed
          from a day that is not today, which is the state that used to be
          unreachable. */}
          <View style={styles.dayBar}>
            <Button
              label="Previous day"
              onPress={() => stepDay(-1)}
              variant="quiet"
            />
            <Text style={[styles.dayBarLabel, { color: colors.text }]}>
              {formatRelative(startOfDay(anchor).toISOString()) ||
                formatMonth(anchor)}
            </Text>
            <Button
              label="Next day"
              onPress={() => stepDay(1)}
              variant="quiet"
            />
          </View>
          {onToday ? null : (
            <View style={styles.dayBar}>
              <Button
                label="Go to today"
                onPress={() => setAnchor(new Date())}
                testID={TEST_IDS.agenda.today}
                variant="secondary"
              />
            </View>
          )}
        </>
      }
    >
      {/* A list of unbounded length is virtualized — the accessibility
          contract's own rule, and the reason Day, Schedule and Waiting on
          all render through one FlatList rather than a ScrollView. */}
      <FlatList
        data={listData}
        keyExtractor={dayKeyOf}
        contentContainerStyle={styles.list}
        // Each row is one day holding any number of events, so no fixed
        // item height exists and `getItemLayout` would misplace every cell.
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={7}
        removeClippedSubviews
        refreshing={refreshing}
        onRefresh={() => void refreshAgenda()}
        renderItem={renderDay}
      />
    </AppPlace>
  );
}

/** Two dates in the same calendar month of the same year. */
function sameMonth(a: Date, b: Date | undefined): boolean {
  return (
    b !== undefined &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth()
  );
}
