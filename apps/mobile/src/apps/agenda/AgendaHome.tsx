// Agenda on the phone: Day, Schedule and Waiting on, with the band the app
// has claimed carrying the four destinations.
//
// THERE IS NO MONTH OR WEEK GRID HERE. A seven-column grid at 390pt gives
// 42pt cells, under the 44pt tap-target floor, so both fall back to Day —
// the same fallback the web surface makes at a narrow width, decided once in
// `agenda-band.ts` and honoured here.
//
// THE GRID IS FOR THINGS WITH A TIME COST: every row below came from
// `core.event`. The day-context layers — birthdays, due tasks, holidays —
// are not read on this surface yet; when they are they decorate a day header,
// never become a row.
//
// The held-write mark is drawn INLINE (a 2pt inline-start rule and the words),
// not through a shared component: it is two elements, and a kit file for it
// would be a dependency for nothing.

import React, { memo, useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, View } from "react-native";
import type { ListRenderItemInfo } from "react-native";

import { readPendingOverlay } from "@centraid/blueprints/apps/_shared/pending-overlay";

import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import OptionSheet from "../../kit/components/OptionSheet";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { useBandOwner } from "../../kit/band/band-owner";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import ReplicaStateCard from "../../kit/replica/ReplicaStateCard";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { AgendaScreenProps } from "../../navigation";
import AgendaBand from "./AgendaBand";
import AgendaCreateModal from "./AgendaCreateModal";
import type { AgendaCreateInput } from "./AgendaCreateModal";
import type { AgendaBandDestinationKey } from "./agenda-band";
import { styles } from "./AgendaHome.styles";
import type { NativeAgendaEvent } from "./useAgenda";
import { useAgenda } from "./useAgenda";

/** What the surface is showing. `search` and `more` are band destinations that
 *  open a field and a sheet rather than replacing the list. */
type Surface = "day" | "schedule" | "waiting";

interface AgendaDay {
  key: string;
  date: Date;
  events: NativeAgendaEvent[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const dayKeyOf = (row: AgendaDay): string => row.key;
/** One shared identity for "nothing to list": a fresh `[]` per render would
 *  make FlatList re-diff a list it already knows is empty. */
const NO_DAYS: AgendaDay[] = [];

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

/** Is the owner still owed an answer on this event? */
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
}: AgendaScreenProps<"AgendaHome">): React.JSX.Element {
  const { colors } = useTheme();
  const { refresh, session } = useReplica();
  // The frame's latch, per app — handing the band back on one Agenda surface
  // hands it back on all of them.
  const { bandOwner } = useBandOwner("agenda");

  const [surface, setSurface] = useState<Surface>("day");
  const [anchor, setAnchor] = useState(() => new Date());
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
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

  // One row per DAY, each carrying its own events.
  const days = useMemo<AgendaDay[]>(() => {
    const out: AgendaDay[] = [];
    let current: AgendaDay | undefined;
    for (const event of visible) {
      const date = new Date(event.start);
      const key = date.toDateString();
      if (current?.key !== key) {
        current = { key, date, events: [] };
        out.push(current);
      }
      current.events.push(event);
    }
    return out;
  }, [visible]);

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

  const refreshAgenda = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      await refresh?.();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

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
    ({ item }: ListRenderItemInfo<AgendaDay>): React.JSX.Element => (
      <AgendaDayRow day={item} colors={colors} onOpen={openEvent} />
    ),
    [colors, openEvent]
  );

  const listData = agenda.connection === "unavailable" ? NO_DAYS : days;
  const emptyLine =
    query.trim() !== ""
      ? "Nothing matches that."
      : surface === "waiting"
        ? "Nothing is waiting on your answer."
        : agenda.connection === "offline"
          ? "No cached events here — reconnect to check the vault."
          : "Nothing on these days.";

  return (
    // There is one page for the shell and every app in it — no per-app surface
    // tone (docs/traps/design-tokens.md).
    <View style={[styles.frame, { backgroundColor: colors.bg }]}>
      <TopSafeArea style={styles.body}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={[styles.title, { color: colors.text }]}>Agenda</Text>
            <Text style={[styles.subtitle, { color: colors.textSoft }]}>
              {anchor.toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
            </Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Go to today"
              onPress={() => setAnchor(new Date())}
            >
              <Icon name="Clock" size={21} color={colors.text} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="New event"
              onPress={() => setCreateOpen(true)}
            >
              <Icon name="Plus" size={24} color={colors.text} />
            </Pressable>
          </View>
        </View>

        <ReplicaStatusBar />

        {searchOpen ? (
          <View style={[styles.search, { backgroundColor: colors.bgSunken }]}>
            <Icon name="Search" size={16} color={colors.textSoft} />
            <TextInput
              autoFocus
              value={query}
              onChangeText={setQuery}
              placeholder="Search events"
              placeholderTextColor={colors.textFaint}
              style={[styles.searchInput, { color: colors.text }]}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close search"
              onPress={() => {
                setQuery("");
                setSearchOpen(false);
              }}
            >
              <Icon name="X" size={17} color={colors.textSoft} />
            </Pressable>
          </View>
        ) : null}

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
          ListHeaderComponent={
            <ReplicaStateCard
              connection={agenda.connection}
              error={agenda.error}
              unavailableReason={agenda.unavailableReason}
              noun="Calendar"
              onRetry={() => void refreshAgenda()}
            />
          }
          ListEmptyComponent={
            agenda.connection === "unavailable" || agenda.error ? null : (
              <Text style={[styles.empty, { color: colors.textSoft }]}>
                {agenda.loading ? "Opening your calendar…" : emptyLine}
              </Text>
            )
          }
          renderItem={renderDay}
        />
      </TopSafeArea>

      <OptionSheet
        visible={moreOpen}
        title="Calendars"
        options={agenda.calendars.map((calendar) => {
          const id = String(calendar["calendar_id"] ?? "");
          return {
            id,
            label: String(calendar["name"] ?? "Calendar"),
            detail: hiddenCalendars.has(id) ? "Hidden" : "Shown",
          };
        })}
        onSelect={(id) => {
          setMoreOpen(false);
          setHiddenCalendars((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
        }}
        onClose={() => setMoreOpen(false)}
      />

      {createOpen ? (
        <AgendaCreateModal
          visible
          calendars={agenda.calendars}
          parties={agenda.parties}
          defaultCalendarId={String(agenda.calendars[0]?.calendar_id ?? "")}
          onClose={() => setCreateOpen(false)}
          onCreate={create}
        />
      ) : null}

      <AgendaBand
        owner={bandOwner}
        current={surface}
        onSelect={onDestination}
        // HOME via popTo — `goBack()` is a no-op under a deep link and
        // `navigate` pushes a second Home on React Navigation 7.
        onHome={() => navigation.popTo("Home")}
      />
    </View>
  );
}

/**
 * A row is one DAY: a date column beside a stacked column of that day's
 * events. Title above time — the title gets the full width instead of sharing
 * the row with a time column.
 */
const AgendaDayRow = memo(
  ({
    day,
    colors,
    onOpen,
  }: {
    day: AgendaDay;
    colors: ThemeColors;
    onOpen: (event: NativeAgendaEvent) => void;
  }): React.JSX.Element => {
    const isToday = day.date.toDateString() === new Date().toDateString();
    return (
      <View style={[styles.dayRow, { borderTopColor: colors.line }]}>
        <View
          style={[styles.dateCol, isToday ? { backgroundColor: colors.bgElev } : null]}
        >
          <Text
            style={[
              styles.dateNum,
              { color: isToday ? colors.text : colors.textSoft },
            ]}
          >
            {day.date.getDate()}
          </Text>
          <Text style={[t("eyebrow"), { color: colors.textSoft }]}>
            {new Intl.DateTimeFormat(undefined, { weekday: "short" })
              .format(day.date)
              .slice(0, 3)}
          </Text>
        </View>
        <View style={styles.eventsCol}>
          {day.events.map((event) => (
            <AgendaEventCard
              key={event.instanceKey}
              event={event}
              colors={colors}
              onOpen={onOpen}
            />
          ))}
        </View>
      </View>
    );
  }
);
AgendaDayRow.displayName = "AgendaDayRow";

function AgendaEventCard({
  event,
  colors,
  onOpen,
}: {
  event: NativeAgendaEvent;
  colors: ThemeColors;
  onOpen: (event: NativeAgendaEvent) => void;
}): React.JSX.Element {
  const pending = readPendingOverlay(
    event.raw as unknown as Record<string, unknown>
  );
  const heldCancel =
    pending?.action === "cancel-event" &&
    (pending.status === "queued" ||
      pending.status === "sending" ||
      pending.status === "parked");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${event.summary}, ${new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(event.start))}`}
      onPress={() => onOpen(event)}
      style={[
        styles.eventCard,
        { backgroundColor: colors.bgElev, borderStartColor: colors.text },
      ]}
    >
      <Text style={[styles.eventTitle, { color: colors.text }]}>
        {event.summary}
      </Text>
      <Text style={[styles.eventTime, { color: colors.textSoft }]}>
        {new Intl.DateTimeFormat(undefined, {
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(event.start))}
      </Text>
      {event.isRecurrenceInstance ? (
        <Text style={[styles.eventMeta, { color: colors.textFaint }]}>
          Repeating
        </Text>
      ) : null}
      {pending ? (
        <View style={[styles.pendingMark, { borderStartColor: colors.textFaint }]}>
          <Text style={[styles.pendingText, { color: colors.textSoft }]}>
            {heldCancel ? "cancel asked" : "not in the vault yet"}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}
