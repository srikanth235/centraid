// One day of the agenda, drawn (#1015). Split out of `AgendaHome` when the
// month heading pushed that file past the ceiling; nothing here decides
// anything — the day, its ribbon, its due shelf and its events arrive made.

import React, { memo } from "react";
import { Pressable, View } from "react-native";

import {
  pendingSidecarOf,
  readPendingOverlay,
} from "@centraid/blueprints/apps/_shared/pending-overlay";

import { Text } from "../../kit/components/NativeText";
import { formatMonth, formatTime } from "../../kit/format";
import { t } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { AgendaDay } from "./agenda-day-model";
import AgendaDayContext, { DayRibbon } from "./AgendaDayContext";
import { styles } from "./AgendaHome.styles";
import type { NativeAgendaEvent } from "./useAgenda";

/**
 * A row is one DAY: a date column beside a stacked column of that day's
 * events. Title above time — the title gets the full width instead of sharing
 * the row with a time column.
 */
const AgendaDayRow = memo(
  ({
    day,
    colors,
    month,
    onOpen,
    onOpenTask,
  }: {
    day: AgendaDay;
    colors: ThemeColors;
    /** The first row of a calendar month carries that month's name. */
    month: boolean;
    onOpen: (event: NativeAgendaEvent) => void;
    onOpenTask: () => void;
  }): React.JSX.Element => {
    const now = new Date();
    const isToday = day.date.toDateString() === now.toDateString();
    // The first row that has not started yet — where "now" sits in a list.
    const nowSlot = day.events.findIndex(
      (event) => Date.parse(event.start) > now.getTime()
    );
    return (
      <View>
        {month ? (
          <Text style={[styles.monthHead, { color: colors.textSoft }]}>
            {formatMonth(day.date)}
          </Text>
        ) : null}
        <View style={[styles.dayRow, { borderTopColor: colors.line }]}>
          <View
            style={[
              styles.dateCol,
              isToday ? { backgroundColor: colors.bgElev } : null,
            ]}
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
            <DayRibbon facts={day.ribbon} colors={colors} />
            {/* THE SHELF. Collapsed to a count; the names arrive on tap, and a
              row hands the task to the room that owns it. */}
            {day.due.length > 0 ? (
              <AgendaDayContext
                due={day.due}
                colors={colors}
                onOpenTask={onOpenTask}
              />
            ) : null}
            {day.events.map((event, index) => (
              <React.Fragment key={event.instanceKey}>
                {/* THE NOW LINE, on the one day that is today: a hairline in
                  the attention tone carrying the current time, drawn before
                  the first event that has not started yet. A list has no
                  vertical time axis to place it on, so "between the last past
                  row and the next one" is where now actually is. */}
                {isToday && nowSlot === index ? (
                  <NowLine colors={colors} />
                ) : null}
                <AgendaEventCard
                  event={event}
                  colors={colors}
                  onOpen={onOpen}
                />
              </React.Fragment>
            ))}
            {isToday && nowSlot === day.events.length ? (
              <NowLine colors={colors} />
            ) : null}
          </View>
        </View>
      </View>
    );
  }
);
AgendaDayRow.displayName = "AgendaDayRow";

export default AgendaDayRow;

/** The now line. Its time is a numeric, so it carries the tabular figures the
 *  system gives every number. */
function NowLine({ colors }: { colors: ThemeColors }): React.JSX.Element {
  return (
    <View style={styles.nowLine} accessibilityLabel="Now">
      <Text style={[styles.nowText, { color: colors.seam }]}>
        {formatTime(new Date())}
      </Text>
      <View style={[styles.nowRule, { backgroundColor: colors.seam }]} />
    </View>
  );
}

function AgendaEventCard({
  event,
  colors,
  onOpen,
}: {
  event: NativeAgendaEvent;
  colors: ThemeColors;
  onOpen: (event: NativeAgendaEvent) => void;
}): React.JSX.Element {
  const eventRow = event.raw as unknown as Record<string, unknown>;
  const pending = readPendingOverlay(eventRow, pendingSidecarOf(eventRow));
  const heldCancel =
    pending?.action === "cancel-event" &&
    (pending.status === "queued" ||
      pending.status === "sending" ||
      pending.status === "parked");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${event.summary}, ${formatTime(event.start)}`}
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
        {formatTime(event.start)}
      </Text>
      {event.isRecurrenceInstance ? (
        <Text style={[styles.eventMeta, { color: colors.textFaint }]}>
          Repeating
        </Text>
      ) : null}
      {pending ? (
        <View
          style={[styles.pendingMark, { borderStartColor: colors.textFaint }]}
        >
          <Text style={[styles.pendingText, { color: colors.textSoft }]}>
            {heldCancel ? "cancel asked" : "not in the vault yet"}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}
