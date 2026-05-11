import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, ScrollView, Pressable, StyleSheet } from 'react-native';
import { Store } from '../storage';
import { todayKey, daysAgoKey, formatDate } from '../dateUtil';
import Icon from '../components/Icon';
import Skeleton from '../components/Skeleton';
import { colors, radii, spacing, t, family } from '../theme';
import type { AppComponentProps } from './_types';

interface Habit {
  id: number;
  name: string;
  log: string[];
}

const KEY = 'habits.list';
const seedLog = (days: number): string[] => Array.from({ length: days }, (_, i) => daysAgoKey(i));
const SEED: Habit[] = [
  { id: 1, log: seedLog(12), name: 'Read 20 pages' },
  { id: 2, log: seedLog(4), name: 'Walk 30 min' },
  { id: 3, log: seedLog(18), name: 'No phone in bed' },
  { id: 4, log: seedLog(7), name: 'Drink water' },
];

export default function HabitsApp({ app }: AppComponentProps): React.JSX.Element | null {
  const [habits, setHabits] = useState<Habit[]>([]);
  const [input, setInput] = useState('');
  const [ready, setReady] = useState(false);
  const today = todayKey();

  useEffect(() => {
    Store.hydrate<Habit[]>(KEY, SEED).then((v) => {
      setHabits(v);
      setReady(true);
    });
  }, []);

  if (!ready) {
    return <Skeleton />;
  }

  const persist = (next: Habit[]): void => {
    setHabits(next);
    Store.set(KEY, next);
  };
  const nextId = habits.reduce((m, h) => Math.max(m, h.id), 0) + 1;

  const add = (): void => {
    const name = input.trim();
    if (!name) {
      return;
    }
    persist([...habits, { id: nextId, log: [], name }]);
    setInput('');
  };

  const toggle = (h: Habit): void => {
    const next = h.log.includes(today)
      ? { ...h, log: h.log.filter((d) => d !== today) }
      : { ...h, log: [today, ...h.log] };
    persist(habits.map((x) => (x.id === h.id ? next : x)));
  };

  const remove = (id: number): void => persist(habits.filter((h) => h.id !== id));

  const streakOf = (h: Habit): number => {
    let s = 0;
    for (let i = 0; i < 365; i++) {
      if (h.log.includes(daysAgoKey(i))) {
        s++;
      } else {
        break;
      }
    }
    return s;
  };

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <Text style={styles.dateLabel}>{formatDate(today)}</Text>

      <View style={styles.addBar}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Add a habit…"
          placeholderTextColor={colors.ink4}
          style={styles.input}
          onSubmitEditing={add}
        />
        <Pressable onPress={add} style={[styles.addBtn, { backgroundColor: app.color }]}>
          <Icon name="Plus" size={18} color="#fff" strokeWidth={2.5} />
        </Pressable>
      </View>

      {habits.length === 0 ? (
        <Text style={styles.empty}>Add a habit to start tracking it.</Text>
      ) : null}

      {habits.map((h) => {
        const doneToday = h.log.includes(today);
        return (
          <View key={h.id} style={styles.row}>
            <Pressable
              onPress={() => toggle(h)}
              style={[
                styles.circle,
                doneToday && { backgroundColor: app.color, borderColor: app.color },
              ]}
            >
              {doneToday ? <Icon name="Check" size={14} color="#fff" strokeWidth={2.5} /> : null}
            </Pressable>

            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.name}>{h.name}</Text>
              <View style={styles.week}>
                {Array.from({ length: 7 }, (_, i) => 6 - i).map((daysAgo) => {
                  const k = daysAgoKey(daysAgo);
                  const on = h.log.includes(k);
                  const isToday = daysAgo === 0;
                  return (
                    <View
                      key={daysAgo}
                      style={[
                        styles.dot,
                        on && { backgroundColor: app.color, borderColor: app.color },
                        isToday && !on && { borderColor: colors.ink2 },
                      ]}
                    />
                  );
                })}
                <Text style={styles.streak}>{streakOf(h)} day streak</Text>
              </View>
            </View>

            <Pressable onPress={() => remove(h.id)} hitSlop={10}>
              <Icon name="Trash" size={18} color={colors.ink3} />
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  addBar: { flexDirection: 'row', gap: spacing[2], marginBottom: spacing[3] },
  addBtn: { alignItems: 'center', borderRadius: radii.md, justifyContent: 'center', width: 44 },
  circle: {
    alignItems: 'center',
    borderColor: colors.line,
    borderRadius: 14,
    borderWidth: 1.5,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  dateLabel: { ...t('small'), color: colors.ink3, marginBottom: spacing[3] },
  dot: {
    backgroundColor: 'transparent',
    borderColor: colors.line,
    borderRadius: 5,
    borderWidth: 1,
    height: 10,
    width: 10,
  },
  empty: { ...t('body'), color: colors.ink3, paddingVertical: spacing[5], textAlign: 'center' },
  input: {
    flex: 1,
    paddingHorizontal: spacing[3],
    paddingVertical: 12,
    backgroundColor: colors.bgElev,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    ...t('body'),
    color: colors.ink,
  },
  name: { ...t('bodyStrong'), color: colors.ink },
  row: {
    alignItems: 'center',
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing[3],
    paddingVertical: spacing[3],
  },
  scroll: { padding: spacing[4], paddingBottom: spacing[7] },
  streak: { ...t('tiny'), color: colors.ink3, fontFamily: family.monoMedium, marginLeft: 8 },
  week: { alignItems: 'center', flexDirection: 'row', gap: 4, marginTop: 6 },
});
