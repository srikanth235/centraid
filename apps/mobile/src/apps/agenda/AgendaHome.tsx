import React, { useMemo, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import { useTheme } from '../../kit/theme';
import { useReplica } from '../../kit/replica/ReplicaProvider';
import type { AgendaScreenProps } from '../../navigation';
import type { AgendaEventModel } from './recurrence';
import { styles } from './AgendaHome.styles';
import { useAgenda } from './useAgenda';

type ViewMode = 'month' | 'week' | 'agenda';
type AgendaRow =
  | { kind: 'day'; key: string; date: Date }
  | { kind: 'event'; key: string; event: AgendaEventModel };
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hiddenCalendars, setHiddenCalendars] = useState(new Set<string>());
  const [startPreset, setStartPreset] = useState<'next-hour' | 'tomorrow'>('next-hour');
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
  const visibleEvents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return agenda.events.filter(
      (event) =>
        (!event.calendarId || !hiddenCalendars.has(event.calendarId)) &&
        (!needle ||
          event.summary.toLowerCase().includes(needle) ||
          event.description?.toLowerCase().includes(needle)),
    );
  }, [agenda.events, hiddenCalendars, query]);
  const agendaRows = useMemo<AgendaRow[]>(() => {
    let previous = '';
    return visibleEvents.flatMap((event) => {
      const date = new Date(event.start);
      const day = date.toDateString();
      const rows: AgendaRow[] = [];
      if (day !== previous) {
        previous = day;
        rows.push({ kind: 'day', key: `day:${day}`, date });
      }
      rows.push({ kind: 'event', key: event.instanceKey, event });
      return rows;
    });
  }, [visibleEvents]);

  const create = async (): Promise<void> => {
    if (!session || !summary.trim() || !calendarId) {
      Alert.alert('Calendar unavailable', 'Sync a calendar before creating an event.');
      return;
    }
    const start = new Date();
    if (startPreset === 'tomorrow') {
      start.setDate(start.getDate() + 1);
      start.setHours(9, 0, 0, 0);
    } else {
      start.setMinutes(Math.ceil(start.getMinutes() / 30) * 30, 0, 0);
      start.setHours(start.getHours() + 1);
    }
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
  const goToday = (): void => {
    void Haptics.selectionAsync();
    setCursor(new Date());
  };
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
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]} edges={['top']}>
      <View style={styles.header}>
        <View>
          <Text style={[styles.title, { color: colors.ink }]}>Agenda</Text>
          <Text style={[styles.subtitle, { color: colors.ink2 }]}>Your time, in one view</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable
            accessibilityLabel="Search events"
            onPress={() => setSearchOpen((open) => !open)}
          >
            <Feather name="search" size={21} color={colors.ink} />
          </Pressable>
          <Pressable accessibilityLabel="Create event" onPress={() => setCreateOpen(true)}>
            <Feather name="plus" size={24} color={colors.accent} />
          </Pressable>
        </View>
      </View>
      {searchOpen ? (
        <View style={[styles.search, { backgroundColor: colors.bgSunken }]}>
          <Feather name="search" size={16} color={colors.ink2} />
          <TextInput
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder="Search title or notes"
            placeholderTextColor={colors.ink3}
            style={[styles.searchInput, { color: colors.ink }]}
          />
          <Pressable
            onPress={() => {
              setQuery('');
              setSearchOpen(false);
            }}
          >
            <Feather name="x" size={17} color={colors.ink2} />
          </Pressable>
        </View>
      ) : null}
      <View style={[styles.segment, { backgroundColor: colors.bgSunken }]}>
        {(['month', 'week', 'agenda'] as ViewMode[]).map((item) => (
          <Pressable
            key={item}
            onPress={() => setMode(item)}
            style={[styles.segmentItem, item === mode && { backgroundColor: colors.bgElev }]}
          >
            <Text style={[styles.segmentText, { color: item === mode ? colors.ink : colors.ink2 }]}>
              {item === 'agenda' ? 'Schedule' : item[0]!.toUpperCase() + item.slice(1)}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.nav}>
        <Pressable style={[styles.today, { borderColor: colors.lineStrong }]} onPress={goToday}>
          <Text style={[styles.todayText, { color: colors.ink }]}>Today</Text>
        </Pressable>
        <View style={styles.navArrows}>
          <Pressable onPress={() => move(-1)}>
            <Feather name="chevron-left" size={22} color={colors.ink2} />
          </Pressable>
          <Pressable onPress={() => move(1)}>
            <Feather name="chevron-right" size={22} color={colors.ink2} />
          </Pressable>
        </View>
        <Text style={[styles.rangeTitle, { color: colors.ink }]}>
          {mode === 'month'
            ? new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(cursor)
            : mode === 'week'
              ? `${range[0].toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${addDays(range[1], -1).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
              : 'Upcoming'}
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
            const id = String(calendar.calendar_id ?? '');
            const shown = !hiddenCalendars.has(id);
            const swatch = String(
              calendar.color ?? ['#4e68dd', '#b45173', '#258d86', '#ba7418'][index % 4],
            );
            return (
              <Pressable
                key={id || calendar.__rowId}
                onPress={() => toggleCalendar(id)}
                style={[
                  styles.calendarChip,
                  { backgroundColor: colors.bgSunken, opacity: shown ? 1 : 0.5 },
                ]}
              >
                <View style={[styles.calendarDot, { backgroundColor: swatch }]} />
                <Text style={[styles.calendarText, { color: colors.ink2 }]}>
                  {String(calendar.name ?? 'Calendar')}
                </Text>
                {shown ? <Feather name="check" size={12} color={colors.accent} /> : null}
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      {mode === 'month' ? (
        <MonthGrid cursor={cursor} events={visibleEvents} onDay={setCursor} colors={colors} />
      ) : mode === 'week' ? (
        <WeekStrip start={range[0]} events={visibleEvents} colors={colors} />
      ) : null}
      <FlatList
        data={agendaRows}
        keyExtractor={(row) => row.key}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: colors.ink2 }]}>
            {agenda.loading ? 'Opening your calendar…' : 'Nothing scheduled in this range.'}
          </Text>
        }
        renderItem={({ item }) =>
          item.kind === 'day' ? (
            <View style={styles.dayHeader}>
              <Text style={[styles.dayHeaderTitle, { color: colors.ink }]}>
                {new Intl.DateTimeFormat(undefined, {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                }).format(item.date)}
              </Text>
            </View>
          ) : (
            <EventRow
              event={item.event}
              colors={colors}
              onPress={() => navigation.navigate('AgendaEvent', { eventId: item.event.id })}
            />
          )
        }
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
            1 hour · 15 minute local reminder
          </Text>
          <TextInput
            autoFocus
            value={summary}
            onChangeText={setSummary}
            placeholder="Event title"
            placeholderTextColor={colors.ink3}
            style={[styles.input, { borderColor: colors.lineStrong, color: colors.ink }]}
          />
          <View style={styles.startPresets}>
            {(
              [
                ['next-hour', 'Next hour'],
                ['tomorrow', 'Tomorrow · 9 AM'],
              ] as const
            ).map(([key, label]) => (
              <Pressable
                key={key}
                onPress={() => setStartPreset(key)}
                style={[
                  styles.startPreset,
                  { backgroundColor: startPreset === key ? colors.ink : colors.bgSunken },
                ]}
              >
                <Text
                  style={[
                    styles.startPresetText,
                    { color: startPreset === key ? colors.bg : colors.ink2 },
                  ]}
                >
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
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
          –{' '}
          {new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
            new Date(event.end),
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
