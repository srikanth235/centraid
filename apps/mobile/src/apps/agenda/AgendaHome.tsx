import * as Haptics from "expo-haptics";
import React, { memo, useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, ScrollView, View } from "react-native";
import type { ListRenderItemInfo } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import HomeKey from "../../kit/components/HomeKey";
import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import { showToast } from "../../kit/components/Toast";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStateCard from "../../kit/replica/ReplicaStateCard";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { useTheme } from "../../kit/theme";
import type { AgendaScreenProps } from "../../navigation";
import AgendaCreateModal from "./AgendaCreateModal";
import type { AgendaCreateInput } from "./AgendaCreateModal";
import { styles } from "./AgendaHome.styles";
import type { AgendaEventModel } from "./recurrence";
import { useAgenda } from "./useAgenda";

type ViewMode = "month" | "week" | "agenda";
type AgendaRow =
  | { kind: "day"; key: string; date: Date }
  | { kind: "event"; key: string; event: AgendaEventModel };
const startOfMonth = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), 1);
const endOfMonth = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth() + 1, 1);
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
// Day headers key on the day string and events on their instance key, so the
// two arms of AgendaRow can never collide.
const agendaRowKey = (row: AgendaRow): string => row.key;
// One shared identity for the "nothing to list" case: a fresh `[]` per render
// would make FlatList re-diff a list it already knows is empty.
const NO_ROWS: AgendaRow[] = [];

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
      mode === "month"
        ? ([startOfMonth(cursor), endOfMonth(cursor)] as const)
        : mode === "week"
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
  const agendaRows = useMemo<AgendaRow[]>(() => {
    const rows: AgendaRow[] = [];
    let previous = "";
    for (const event of visibleEvents) {
      const date = new Date(event.start);
      const day = date.toDateString();
      if (day !== previous) {
        previous = day;
        rows.push({ kind: "day", key: `day:${day}`, date });
      }
      rows.push({ kind: "event", key: event.instanceKey, event });
    }
    return rows;
  }, [visibleEvents]);

  const create = async (input: AgendaCreateInput): Promise<boolean> => {
    if (!session || !calendarId) {
      showToast({
        message:
          "Calendar unavailable — sync a calendar before creating an event.",
        tone: "danger",
      });
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
    if (mode === "month") next.setMonth(next.getMonth() + direction);
    else next.setDate(next.getDate() + direction * 7);
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
    ({ item }: ListRenderItemInfo<AgendaRow>): React.JSX.Element =>
      item.kind === "day" ? (
        <DayHeaderRow date={item.date} colors={colors} />
      ) : (
        <EventRow event={item.event} colors={colors} onOpen={openEvent} />
      ),
    [colors, openEvent]
  );
  const listData = agenda.connection === "unavailable" ? NO_ROWS : agendaRows;
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
    <SafeAreaView
      style={[styles.safe, { backgroundColor: colors.bg }]}
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
        {(["month", "week", "agenda"] as ViewMode[]).map((item) => (
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
              {item === "agenda"
                ? "Schedule"
                : item[0]!.toUpperCase() + item.slice(1)}
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
          {mode === "month"
            ? new Intl.DateTimeFormat(undefined, {
                month: "long",
                year: "numeric",
              }).format(cursor)
            : mode === "week"
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
                  {
                    backgroundColor: colors.bgSunken,
                    opacity: shown ? 1 : 0.5,
                  },
                ]}
              >
                <View
                  style={[styles.calendarDot, { backgroundColor: swatch }]}
                />
                <Text style={[styles.calendarText, { color: colors.textSoft }]}>
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
      {mode === "month" ? (
        <MonthGrid
          cursor={cursor}
          events={visibleEvents}
          onDay={setCursor}
          colors={colors}
        />
      ) : mode === "week" ? (
        <WeekStrip start={range[0]} events={visibleEvents} colors={colors} />
      ) : null}
      <FlatList
        data={listData}
        keyExtractor={agendaRowKey}
        contentContainerStyle={styles.list}
        // Day headers (45pt) and event rows (72pt) interleave, so no fixed
        // itemHeight exists and getItemLayout would mis-place every cell.
        // Agenda mode spans 120 days: 8 rows fills the ~520pt of screen left
        // below the header/segment/nav chrome, and ±3 viewports of retained
        // cells is enough to absorb a fast flick without holding the year.
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

const DayHeaderRow = memo(
  ({
    date,
    colors,
  }: {
    date: Date;
    colors: ReturnType<typeof useTheme>["colors"];
  }): React.JSX.Element => (
    <View style={styles.dayHeader}>
      <Text style={[styles.dayHeaderTitle, { color: colors.text }]}>
        {new Intl.DateTimeFormat(undefined, {
          weekday: "long",
          month: "long",
          day: "numeric",
        }).format(date)}
      </Text>
    </View>
  )
);
DayHeaderRow.displayName = "DayHeaderRow";

// `onOpen` takes the event rather than a pre-bound closure so the caller can
// hand every row the same stable callback — a per-row arrow would defeat memo.
const EventRow = memo(
  ({
    event,
    colors,
    onOpen,
  }: {
    event: AgendaEventModel;
    colors: ReturnType<typeof useTheme>["colors"];
    onOpen: (event: AgendaEventModel) => void;
  }): React.JSX.Element => (
    <Pressable
      onPress={() => onOpen(event)}
      style={[styles.event, { borderBottomColor: colors.line }]}
    >
      <View style={styles.time}>
        <Text style={[styles.timeText, { color: colors.text }]}>
          {new Intl.DateTimeFormat(undefined, {
            hour: "numeric",
            minute: "2-digit",
          }).format(new Date(event.start))}
        </Text>
        <Text style={[styles.dayText, { color: colors.textSoft }]}>
          –{" "}
          {new Intl.DateTimeFormat(undefined, {
            hour: "numeric",
            minute: "2-digit",
          }).format(new Date(event.end))}
        </Text>
      </View>
      <View style={[styles.eventLine, { backgroundColor: colors.accent }]} />
      <View style={styles.eventCopy}>
        <Text style={[styles.eventTitle, { color: colors.text }]}>
          {event.summary}
        </Text>
        <Text style={[styles.eventMeta, { color: colors.textSoft }]}>
          {event.timezone ?? "Local time"}
          {event.isRecurrenceInstance ? " · repeating" : ""}
        </Text>
      </View>
      <Icon name="chevron-right" size={18} color={colors.textFaint} />
    </Pressable>
  )
);
EventRow.displayName = "EventRow";

function MonthGrid({
  cursor,
  events,
  onDay,
  colors,
}: {
  cursor: Date;
  events: AgendaEventModel[];
  onDay: (day: Date) => void;
  colors: ReturnType<typeof useTheme>["colors"];
}): React.JSX.Element {
  const start = startOfMonth(cursor);
  const first = addDays(start, -start.getDay());
  return (
    <View style={styles.month}>
      {Array.from({ length: 42 }, (_, index) => addDays(first, index)).map(
        (day) => {
          const count = events.filter(
            (event) =>
              new Date(event.start).toDateString() === day.toDateString()
          ).length;
          return (
            <Pressable
              key={day.toISOString()}
              onPress={() => onDay(day)}
              style={styles.day}
            >
              <Text
                style={[
                  styles.dayNumber,
                  {
                    color:
                      day.getMonth() === cursor.getMonth()
                        ? colors.text
                        : colors.textFaint,
                  },
                ]}
              >
                {day.getDate()}
              </Text>
              {count ? (
                <View
                  style={[styles.dot, { backgroundColor: colors.accent }]}
                />
              ) : null}
            </Pressable>
          );
        }
      )}
    </View>
  );
}
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
            <Text style={[styles.weekName, { color: colors.textSoft }]}>
              {new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(
                day
              )}
            </Text>
            <Text style={[styles.weekNumber, { color: colors.text }]}>
              {day.getDate()}
            </Text>
            <Text style={[styles.weekCount, { color: colors.accent }]}>
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
