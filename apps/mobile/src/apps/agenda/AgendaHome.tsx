import * as Haptics from "expo-haptics";
import React, { memo, useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, ScrollView, View } from "react-native";
import type { ListRenderItemInfo } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import HomeKey from "../../kit/components/HomeKey";
import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStateCard from "../../kit/replica/ReplicaStateCard";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import type { AgendaEventModel } from "../../kit/schedule/recurrence";
import { t, useTheme } from "../../kit/theme";
import type { AgendaScreenProps } from "../../navigation";
import AgendaCreateModal from "./AgendaCreateModal";
import type { AgendaCreateInput } from "./AgendaCreateModal";
import { styles } from "./AgendaHome.styles";
import { useAgenda } from "./useAgenda";

// Mobile has no month grid — a 7-column grid at 390px gives 42px cells, well
// under the 44px tap-target floor, and the Binding Layer reference reserves
// the month grid for desktop (`isCalMonth: sc==='cal' && !mob`) while mobile
// always renders the agenda list (`isCalAgenda: sc==='cal' && mob`). "Week"
// is a single horizontal strip (7 cells in a row, not a 2-D grid) and stays.
type ViewMode = "week" | "agenda";
interface AgendaDay {
  key: string;
  date: Date;
  events: AgendaEventModel[];
}
const startOfWeek = (date: Date): Date => {
  const next = new Date(date);
  next.setDate(next.getDate() - next.getDay());
  next.setHours(0, 0, 0, 0);
  return next;
};
const addDays = (date: Date, days: number): Date => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};
const agendaDayKey = (row: AgendaDay): string => row.key;
// One shared identity for the "nothing to list" case: a fresh `[]` per render
// would make FlatList re-diff a list it already knows is empty.
const NO_DAYS: AgendaDay[] = [];

export default function AgendaHome({
  navigation,
}: AgendaScreenProps<"AgendaHome">): React.JSX.Element {
  const { colors } = useTheme();
  const { session, refresh } = useReplica();
  const [cursor, setCursor] = useState(new Date());
  const [mode, setMode] = useState<ViewMode>("agenda");
  const [createOpen, setCreateOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [hiddenCalendars, setHiddenCalendars] = useState(new Set<string>());
  const range = useMemo(
    () =>
      mode === "week"
        ? ([startOfWeek(cursor), addDays(startOfWeek(cursor), 7)] as const)
        : ([
            new Date(new Date().setHours(0, 0, 0, 0)),
            addDays(new Date(), 120),
          ] as const),
    [cursor, mode]
  );
  const agenda = useAgenda(range[0], range[1]);
  const calendarId = String(agenda.calendars[0]?.calendar_id ?? "");
  const visibleEvents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return agenda.events.filter(
      (event) =>
        (!event.calendarId || !hiddenCalendars.has(event.calendarId)) &&
        (!needle ||
          event.summary.toLowerCase().includes(needle) ||
          event.description?.toLowerCase().includes(needle))
    );
  }, [agenda.events, hiddenCalendars, query]);
  // One row per DAY, each carrying its own events — the 34px date column is
  // the row's identity, not a separate header interleaved with event rows.
  const agendaDays = useMemo<AgendaDay[]>(() => {
    const days: AgendaDay[] = [];
    let current: AgendaDay | undefined;
    for (const event of visibleEvents) {
      const date = new Date(event.start);
      const key = date.toDateString();
      if (current?.key !== key) {
        current = { key, date, events: [] };
        days.push(current);
      }
      current.events.push(event);
    }
    return days;
  }, [visibleEvents]);

  const create = async (input: AgendaCreateInput): Promise<boolean> => {
    if (!session || !calendarId) {
      postStatus(
        "Calendar unavailable — sync a calendar before creating an event."
      );
      return false;
    }
    const rowId = `optimistic-${Date.now()}`;
    try {
      const result = await session.write("agenda", {
        action: "propose",
        input,
        optimistic: [
          {
            op: "upsert",
            entity: "core.event",
            rowId,
            values: {
              event_id: rowId,
              summary: String(input.summary),
              dtstart: String(input.dtstart),
              dtend: String(input.dtend),
              start_tz: String(input.start_tz),
              end_tz: String(input.end_tz),
              recurrence_semantics: String(input.recurrence_semantics),
              rrule: input.rrule ?? null,
              status: "tentative",
            },
          },
        ],
      });
      return surfaceWriteOutcome(result, {
        onParked: () =>
          navigation.navigate("Settings", { screen: "Approvals" }),
        queuedMessage:
          "This event will sync automatically when the gateway reconnects.",
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
  const move = (direction: number): void => {
    const next = new Date(cursor);
    next.setDate(next.getDate() + direction * 7);
    setCursor(next);
  };
  const goToday = (): void => {
    void Haptics.selectionAsync();
    setCursor(new Date());
  };
  const openEvent = useCallback(
    (event: AgendaEventModel): void => {
      navigation.navigate("AgendaEvent", {
        eventId: event.id,
        instanceKey: event.instanceKey,
      });
    },
    [navigation]
  );
  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<AgendaDay>): React.JSX.Element => (
      <AgendaDayRow day={item} colors={colors} onOpen={openEvent} />
    ),
    [colors, openEvent]
  );
  const listData = agenda.connection === "unavailable" ? NO_DAYS : agendaDays;
  const toggleCalendar = (id: string): void => {
    void Haptics.selectionAsync();
    setHiddenCalendars((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return (
    // Agenda's declared surface tone is "cool" (freedom table, DESIGN.md).
    <SafeAreaView
      style={[styles.safe, { backgroundColor: colors.toneCool }]}
      edges={["top"]}
    >
      <View style={styles.header}>
        <HomeKey variant="leave" onPress={() => navigation.goBack()} />
        <View style={styles.headerCopy}>
          <Text style={[styles.title, { color: colors.text }]}>Agenda</Text>
          <Text style={[styles.subtitle, { color: colors.textSoft }]}>
            Your time, in one view
          </Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable
            accessibilityLabel="Search events"
            onPress={() => setSearchOpen((open) => !open)}
          >
            <Icon name="search" size={21} color={colors.text} />
          </Pressable>
          <Pressable
            accessibilityLabel="Create event"
            onPress={() => setCreateOpen(true)}
          >
            <Icon name="plus" size={24} color={colors.accent} />
          </Pressable>
        </View>
      </View>
      <ReplicaStatusBar />
      {searchOpen ? (
        <View style={[styles.search, { backgroundColor: colors.bgSunken }]}>
          <Icon name="search" size={16} color={colors.textSoft} />
          <TextInput
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder="Search title or notes"
            placeholderTextColor={colors.textFaint}
            style={[styles.searchInput, { color: colors.text }]}
          />
          <Pressable
            onPress={() => {
              setQuery("");
              setSearchOpen(false);
            }}
          >
            <Icon name="x" size={17} color={colors.textSoft} />
          </Pressable>
        </View>
      ) : null}
      <View style={[styles.segment, { backgroundColor: colors.bgSunken }]}>
        {(["week", "agenda"] as ViewMode[]).map((item) => (
          <Pressable
            key={item}
            onPress={() => setMode(item)}
            style={[
              styles.segmentItem,
              item === mode && { backgroundColor: colors.bgElev },
            ]}
          >
            <Text
              style={[
                styles.segmentText,
                { color: item === mode ? colors.text : colors.textSoft },
              ]}
            >
              {item === "agenda" ? "Schedule" : "Week"}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.nav}>
        <Pressable
          style={[styles.today, { borderColor: colors.lineStrong }]}
          onPress={goToday}
        >
          <Text style={[styles.todayText, { color: colors.text }]}>Today</Text>
        </Pressable>
        <View style={styles.navArrows}>
          <Pressable onPress={() => move(-1)}>
            <Icon name="chevron-left" size={22} color={colors.textSoft} />
          </Pressable>
          <Pressable onPress={() => move(1)}>
            <Icon name="chevron-right" size={22} color={colors.textSoft} />
          </Pressable>
        </View>
        <Text style={[styles.rangeTitle, { color: colors.text }]}>
          {mode === "week"
            ? `${range[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${addDays(range[1], -1).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
            : "Upcoming"}
        </Text>
      </View>
      {agenda.calendars.length ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.calendarScroll}
          contentContainerStyle={styles.calendars}
        >
          {agenda.calendars.map((calendar, index) => {
            const id = String(calendar.calendar_id ?? "");
            const shown = !hiddenCalendars.has(id);
            const swatch = String(
              calendar.color ??
                ["#4e68dd", "#b45173", "#258d86", "#ba7418"][index % 4]
            );
            return (
              <Pressable
                key={id || calendar.__rowId}
                onPress={() => toggleCalendar(id)}
                style={[
                  styles.calendarChip,
                  { backgroundColor: colors.bgSunken },
                ]}
              >
                {/* Hidden state lives on the leaf tokens (dot + label), never
                    on the container as opacity — opacity composites every
                    descendant and would silently invalidate the label's own
                    contrast. */}
                <View
                  style={[
                    styles.calendarDot,
                    { backgroundColor: shown ? swatch : colors.textFaint },
                  ]}
                />
                <Text
                  style={[
                    styles.calendarText,
                    { color: shown ? colors.textSoft : colors.textFaint },
                  ]}
                >
                  {String(calendar.name ?? "Calendar")}
                </Text>
                {shown ? (
                  <Icon name="check" size={12} color={colors.accent} />
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      {mode === "week" ? (
        <WeekStrip start={range[0]} events={visibleEvents} colors={colors} />
      ) : null}
      <FlatList
        data={listData}
        keyExtractor={agendaDayKey}
        contentContainerStyle={styles.list}
        // Each row is one day, which can hold any number of events, so no
        // fixed itemHeight exists and getItemLayout would mis-place every
        // cell. Agenda mode spans 120 days: 8 rows fills the ~520pt of screen
        // left below the header/segment/nav chrome, and ±3 viewports of
        // retained cells is enough to absorb a fast flick without holding
        // the year.
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
              {agenda.loading
                ? "Opening your calendar…"
                : agenda.connection === "offline"
                  ? "No cached events in this range. Reconnect to check the vault."
                  : "Nothing scheduled in this range."}
            </Text>
          )
        }
        renderItem={renderRow}
      />
      {createOpen ? (
        <AgendaCreateModal
          visible
          calendars={agenda.calendars}
          parties={agenda.parties}
          defaultCalendarId={calendarId}
          onClose={() => setCreateOpen(false)}
          onCreate={create}
        />
      ) : null}
    </SafeAreaView>
  );
}

// A row is one day: a 34px date column (day-of-month in the numeric mono
// register, day-of-week below it) beside a stacked column of that day's
// events. This mirrors the Binding Layer reference's mobile agenda contract
// (`isCalAgenda`, `dateColCss`, `d.events`) — never the desktop month grid.
const AgendaDayRow = memo(
  ({
    day,
    colors,
    onOpen,
  }: {
    day: AgendaDay;
    colors: ReturnType<typeof useTheme>["colors"];
    onOpen: (event: AgendaEventModel) => void;
  }): React.JSX.Element => {
    const isToday = day.date.toDateString() === new Date().toDateString();
    return (
      <View style={[styles.dayRow, { borderTopColor: colors.line }]}>
        <View
          style={[
            styles.dateCol,
            isToday && { backgroundColor: colors.bgElev },
          ]}
        >
          <Text
            style={[
              t("mono"),
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
            // Title ABOVE time, per the invariant — the title gets full
            // width instead of sharing the row with a time column.
            <Pressable
              key={event.instanceKey}
              onPress={() => onOpen(event)}
              style={[styles.eventCard, { borderStartColor: colors.accent }]}
            >
              <Text style={[styles.eventTitle, { color: colors.text }]}>
                {event.summary}
              </Text>
              <Text>
                <Text style={[t("mono"), { color: colors.textSoft }]}>
                  {new Intl.DateTimeFormat(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  }).format(new Date(event.start))}
                </Text>
                <Text style={[t("small"), { color: colors.textSoft }]}>
                  {event.timezone ? ` · ${event.timezone}` : ""}
                  {event.isRecurrenceInstance ? " · repeating" : ""}
                </Text>
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    );
  }
);
AgendaDayRow.displayName = "AgendaDayRow";

function WeekStrip({
  start,
  events,
  colors,
}: {
  start: Date;
  events: AgendaEventModel[];
  colors: ReturnType<typeof useTheme>["colors"];
}): React.JSX.Element {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.week}
    >
      {Array.from({ length: 7 }, (_, index) => addDays(start, index)).map(
        (day) => (
          <View
            key={day.toISOString()}
            style={[styles.weekDay, { backgroundColor: colors.bgSunken }]}
          >
            <Text style={[t("eyebrow"), { color: colors.textSoft }]}>
              {new Intl.DateTimeFormat(undefined, { weekday: "short" })
                .format(day)
                .slice(0, 3)}
            </Text>
            <Text
              style={[t("mono"), styles.weekNumber, { color: colors.text }]}
            >
              {day.getDate()}
            </Text>
            <Text
              style={[t("mono"), styles.weekCount, { color: colors.accent }]}
            >
              {
                events.filter(
                  (event) =>
                    new Date(event.start).toDateString() === day.toDateString()
                ).length
              }
            </Text>
          </View>
        )
      )}
    </ScrollView>
  );
}
