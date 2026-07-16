import React, { useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';

import { family, useTheme } from '../../kit/theme';
import { useReplica } from '../../kit/replica/ReplicaProvider';
import type { AgendaScreenProps } from '../../navigation';
import type { AgendaEventModel } from './recurrence';
import { useAgenda } from './useAgenda';

type ViewMode = 'month' | 'week' | 'agenda';
const startOfMonth = (date: Date): Date => new Date(date.getFullYear(), date.getMonth(), 1);
const endOfMonth = (date: Date): Date => new Date(date.getFullYear(), date.getMonth() + 1, 1);
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

export default function AgendaHome({
  navigation,
}: AgendaScreenProps<'AgendaHome'>): React.JSX.Element {
  const { colors } = useTheme();
  const { session } = useReplica();
  const [cursor, setCursor] = useState(new Date());
  const [mode, setMode] = useState<ViewMode>('agenda');
  const [createOpen, setCreateOpen] = useState(false);
  const [summary, setSummary] = useState('');
  const range = useMemo(
    () =>
      mode === 'month'
        ? ([startOfMonth(cursor), endOfMonth(cursor)] as const)
        : mode === 'week'
          ? ([startOfWeek(cursor), addDays(startOfWeek(cursor), 7)] as const)
          : ([new Date(new Date().setHours(0, 0, 0, 0)), addDays(new Date(), 120)] as const),
    [cursor, mode],
  );
  const agenda = useAgenda(range[0], range[1]);
  const calendarId = String(agenda.calendars[0]?.calendar_id ?? '');

  const create = async (): Promise<void> => {
    if (!session || !summary.trim() || !calendarId) {
      Alert.alert('Calendar unavailable', 'Sync a calendar before creating an event.');
      return;
    }
    const start = new Date();
    start.setMinutes(Math.ceil(start.getMinutes() / 30) * 30, 0, 0);
    start.setHours(start.getHours() + 1);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const rowId = `optimistic-${Date.now()}`;
    const result = await session.write('agenda', {
      action: 'propose',
      input: {
        summary: summary.trim(),
        dtstart: start.toISOString(),
        dtend: end.toISOString(),
        start_tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        calendar_id: calendarId,
        reminders: [{ minutes_before: 15 }],
      },
      optimistic: [
        {
          op: 'upsert',
          entity: 'core.event',
          rowId,
          values: {
            event_id: rowId,
            summary: summary.trim(),
            dtstart: start.toISOString(),
            dtend: end.toISOString(),
            start_tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
            status: 'tentative',
          },
        },
      ],
    });
    setSummary('');
    setCreateOpen(false);
    if (result.status === 'parked' || result.status === 'queued')
      navigation.navigate('Tabs', {
        screen: 'SettingsTab',
        params: { screen: 'Approvals' },
      });
  };
  const move = (direction: number): void => {
    const next = new Date(cursor);
    if (mode === 'month') next.setMonth(next.getMonth() + direction);
    else next.setDate(next.getDate() + direction * 7);
    setCursor(next);
  };
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]} edges={['top']}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.ink }]}>Agenda</Text>
        <Pressable onPress={() => setCreateOpen(true)}>
          <Feather name="plus" size={24} color={colors.accent} />
        </Pressable>
      </View>
      <View style={[styles.segment, { backgroundColor: colors.bgSunken }]}>
        {(['month', 'week', 'agenda'] as ViewMode[]).map((item) => (
          <Pressable
            key={item}
            onPress={() => setMode(item)}
            style={[styles.segmentItem, item === mode && { backgroundColor: colors.bgElev }]}
          >
            <Text style={[styles.segmentText, { color: item === mode ? colors.ink : colors.ink2 }]}>
              {item[0]!.toUpperCase() + item.slice(1)}
            </Text>
          </Pressable>
        ))}
      </View>
      {mode !== 'agenda' ? (
        <View style={styles.nav}>
          <Pressable onPress={() => move(-1)}>
            <Feather name="chevron-left" size={22} color={colors.ink2} />
          </Pressable>
          <Text style={[styles.rangeTitle, { color: colors.ink }]}>
            {mode === 'month'
              ? new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(
                  cursor,
                )
              : `${range[0].toLocaleDateString()} – ${addDays(range[1], -1).toLocaleDateString()}`}
          </Text>
          <Pressable onPress={() => move(1)}>
            <Feather name="chevron-right" size={22} color={colors.ink2} />
          </Pressable>
        </View>
      ) : null}
      {mode === 'month' ? (
        <MonthGrid cursor={cursor} events={agenda.events} onDay={setCursor} colors={colors} />
      ) : mode === 'week' ? (
        <WeekStrip start={range[0]} events={agenda.events} colors={colors} />
      ) : null}
      <FlatList
        data={agenda.events}
        keyExtractor={(event) => event.instanceKey}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: colors.ink2 }]}>
            {agenda.loading ? 'Opening your calendar…' : 'Nothing scheduled in this range.'}
          </Text>
        }
        renderItem={({ item }) => (
          <EventRow
            event={item}
            colors={colors}
            onPress={() => navigation.navigate('AgendaEvent', { eventId: item.id })}
          />
        )}
      />
      <Modal
        transparent
        animationType="fade"
        visible={createOpen}
        onRequestClose={() => setCreateOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setCreateOpen(false)} />
        <View style={[styles.dialog, { backgroundColor: colors.bgElev }]}>
          <Text style={[styles.dialogTitle, { color: colors.ink }]}>New event</Text>
          <Text style={[styles.dialogMeta, { color: colors.ink2 }]}>
            Starts at the next half hour · 1 hour · 15 minute local reminder
          </Text>
          <TextInput
            autoFocus
            value={summary}
            onChangeText={setSummary}
            placeholder="Event title"
            placeholderTextColor={colors.ink3}
            style={[styles.input, { borderColor: colors.lineStrong, color: colors.ink }]}
          />
          <Pressable
            style={[styles.create, { backgroundColor: colors.accent }]}
            onPress={() => void create()}
          >
            <Text style={styles.createText}>Create tentative event</Text>
          </Pressable>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function EventRow({
  event,
  colors,
  onPress,
}: {
  event: AgendaEventModel;
  colors: ReturnType<typeof useTheme>['colors'];
  onPress(): void;
}): React.JSX.Element {
  return (
    <Pressable onPress={onPress} style={[styles.event, { borderBottomColor: colors.line }]}>
      <View style={styles.time}>
        <Text style={[styles.timeText, { color: colors.ink }]}>
          {new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
            new Date(event.start),
          )}
        </Text>
        <Text style={[styles.dayText, { color: colors.ink2 }]}>
          {new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' }).format(
            new Date(event.start),
          )}
        </Text>
      </View>
      <View style={[styles.eventLine, { backgroundColor: colors.accent }]} />
      <View style={styles.eventCopy}>
        <Text style={[styles.eventTitle, { color: colors.ink }]}>{event.summary}</Text>
        <Text style={[styles.eventMeta, { color: colors.ink2 }]}>
          {event.timezone ?? 'Local time'}
          {event.isRecurrenceInstance ? ' · repeating' : ''}
        </Text>
      </View>
      <Feather name="chevron-right" size={18} color={colors.ink3} />
    </Pressable>
  );
}

function MonthGrid({
  cursor,
  events,
  onDay,
  colors,
}: {
  cursor: Date;
  events: AgendaEventModel[];
  onDay(day: Date): void;
  colors: ReturnType<typeof useTheme>['colors'];
}): React.JSX.Element {
  const start = startOfMonth(cursor);
  const first = addDays(start, -start.getDay());
  return (
    <View style={styles.month}>
      {Array.from({ length: 42 }, (_, index) => addDays(first, index)).map((day) => {
        const count = events.filter(
          (event) => new Date(event.start).toDateString() === day.toDateString(),
        ).length;
        return (
          <Pressable key={day.toISOString()} onPress={() => onDay(day)} style={styles.day}>
            <Text
              style={[
                styles.dayNumber,
                { color: day.getMonth() === cursor.getMonth() ? colors.ink : colors.ink3 },
              ]}
            >
              {day.getDate()}
            </Text>
            {count ? <View style={[styles.dot, { backgroundColor: colors.accent }]} /> : null}
          </Pressable>
        );
      })}
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
  colors: ReturnType<typeof useTheme>['colors'];
}): React.JSX.Element {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.week}
    >
      {Array.from({ length: 7 }, (_, index) => addDays(start, index)).map((day) => (
        <View
          key={day.toISOString()}
          style={[styles.weekDay, { backgroundColor: colors.bgSunken }]}
        >
          <Text style={[styles.weekName, { color: colors.ink2 }]}>
            {new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(day)}
          </Text>
          <Text style={[styles.weekNumber, { color: colors.ink }]}>{day.getDate()}</Text>
          <Text style={[styles.weekCount, { color: colors.accent }]}>
            {
              events.filter((event) => new Date(event.start).toDateString() === day.toDateString())
                .length
            }
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: 'rgba(0,0,0,.4)', flex: 1 },
  create: { alignItems: 'center', borderRadius: 10, marginTop: 12, padding: 12 },
  createText: { color: '#fff', fontFamily: family.sansBold, fontSize: 13 },
  day: { alignItems: 'center', height: 42, justifyContent: 'center', width: `${100 / 7}%` },
  dayNumber: { fontFamily: family.sansMedium, fontSize: 12 },
  dayText: { fontFamily: family.sansRegular, fontSize: 10, marginTop: 3 },
  dialog: { borderRadius: 16, left: 28, padding: 20, position: 'absolute', right: 28, top: '31%' },
  dialogMeta: { fontFamily: family.sansRegular, fontSize: 12, lineHeight: 18, marginTop: 6 },
  dialogTitle: { fontFamily: family.displayBold, fontSize: 19 },
  dot: { borderRadius: 2, height: 4, marginTop: 2, width: 4 },
  empty: { fontFamily: family.sansRegular, fontSize: 14, padding: 40, textAlign: 'center' },
  event: { alignItems: 'center', borderBottomWidth: 1, flexDirection: 'row', minHeight: 72 },
  eventCopy: { flex: 1 },
  eventLine: { borderRadius: 2, height: 42, marginRight: 12, width: 3 },
  eventMeta: { fontFamily: family.sansRegular, fontSize: 11, marginTop: 4 },
  eventTitle: { fontFamily: family.sansMedium, fontSize: 14 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 50,
    paddingHorizontal: 18,
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    fontFamily: family.sansRegular,
    fontSize: 15,
    marginTop: 16,
    padding: 12,
  },
  list: { paddingBottom: 40, paddingHorizontal: 18 },
  month: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12 },
  nav: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  rangeTitle: { fontFamily: family.sansBold, fontSize: 14 },
  safe: { flex: 1 },
  segment: { borderRadius: 10, flexDirection: 'row', marginHorizontal: 18, padding: 3 },
  segmentItem: { alignItems: 'center', borderRadius: 8, flex: 1, paddingVertical: 7 },
  segmentText: { fontFamily: family.sansMedium, fontSize: 12 },
  time: { width: 68 },
  timeText: { fontFamily: family.monoMedium, fontSize: 12 },
  title: { fontFamily: family.displayBold, fontSize: 23 },
  week: { gap: 8, padding: 14, paddingHorizontal: 18 },
  weekCount: { fontFamily: family.monoBold, fontSize: 10, marginTop: 7 },
  weekDay: { alignItems: 'center', borderRadius: 12, padding: 10, width: 52 },
  weekName: { fontFamily: family.sansMedium, fontSize: 10 },
  weekNumber: { fontFamily: family.displayBold, fontSize: 17, marginTop: 5 },
});
