import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { Store } from '../storage';
import { todayKey, daysAgoKey } from '../dateUtil';
import Skeleton from '../components/Skeleton';
import { colors, radii, spacing, t, family } from '../theme';
import type { AppComponentProps } from '../screens/AppDetail';

type MoodLog = Record<string, number>;

const KEY = 'mood.log';
const MOODS = ['😔', '😐', '🙂', '😄', '✨'] as const;
const LABEL = ['Low', 'Meh', 'Okay', 'Good', 'Bright'] as const;

export default function MoodApp({ app }: AppComponentProps): React.JSX.Element | null {
  const [log, setLog] = useState<MoodLog>({});
  const [ready, setReady] = useState(false);
  const today = todayKey();

  useEffect(() => {
    Store.hydrate<MoodLog>(KEY, {}).then((v) => {
      setLog(v);
      setReady(true);
    });
  }, []);

  if (!ready) {
    return <Skeleton />;
  }

  const pick = (i: number): void => {
    const next: MoodLog = { ...log };
    if (next[today] === i) {
      delete next[today];
    } else {
      next[today] = i;
    }
    setLog(next);
    Store.set(KEY, next);
  };

  const todayPick = log[today];

  let sum = 0;
  let count = 0;
  for (let i = 0; i < 30; i++) {
    const v = log[daysAgoKey(i)];
    if (typeof v === 'number') {
      sum += v;
      count++;
    }
  }
  const avg = count === 0 ? null : sum / count;

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Text style={styles.prompt}>How are you feeling, today?</Text>

      <View style={styles.row}>
        {MOODS.map((emoji, i) => (
          <Pressable
            key={i}
            onPress={() => pick(i)}
            style={[
              styles.btn,
              todayPick === i && { backgroundColor: colors.bgElev, borderColor: app.color },
            ]}
          >
            <Text style={styles.emoji}>{emoji}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.stat}>
        {avg == null
          ? 'Log a few days to see your trend.'
          : `30-day average · ${LABEL[Math.round(avg)]} (${avg.toFixed(1)} of 4)`}
      </Text>

      <Text style={styles.sectionLabel}>Last 30 days</Text>
      <View style={styles.history}>
        {Array.from({ length: 30 }, (_, idx) => 29 - idx).map((daysAgo) => {
          const k = daysAgoKey(daysAgo);
          const v = log[k];
          const isToday = daysAgo === 0;
          return (
            <View
              key={daysAgo}
              style={[styles.cell, isToday && { borderColor: app.color, borderWidth: 2 }]}
            >
              <Text style={styles.cellEmoji}>{typeof v === 'number' ? MOODS[v] : ''}</Text>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  btn: {
    alignItems: 'center',
    aspectRatio: 1,
    backgroundColor: colors.bg,
    borderColor: colors.line,
    borderRadius: radii.md,
    borderWidth: 1.5,
    flex: 1,
    justifyContent: 'center',
  },
  cell: {
    alignItems: 'center',
    backgroundColor: colors.bgElev,
    borderColor: colors.line,
    borderRadius: radii.sm,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  cellEmoji: { fontSize: 20 },
  emoji: { fontSize: 32 },
  history: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  prompt: { ...t('title'), color: colors.ink, marginVertical: spacing[5], textAlign: 'center' },
  row: {
    flexDirection: 'row',
    gap: spacing[2],
    justifyContent: 'space-between',
    marginBottom: spacing[4],
  },
  scroll: { padding: spacing[4], paddingBottom: spacing[7] },
  sectionLabel: {
    ...t('tiny'),
    color: colors.ink3,
    fontFamily: family.monoMedium,
    letterSpacing: 1,
    marginBottom: spacing[2],
    textTransform: 'uppercase',
  },
  stat: { ...t('small'), color: colors.ink3, marginBottom: spacing[5], textAlign: 'center' },
});
