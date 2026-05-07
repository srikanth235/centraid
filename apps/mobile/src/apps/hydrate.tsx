import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Store } from '../storage';
import { todayKey } from '../dateUtil';
import Icon from '../components/Icon';
import Skeleton from '../components/Skeleton';
import { colors, radii, spacing, t, family } from '../theme';
import type { AppComponentProps } from '../screens/AppDetail';

interface HydrateState {
  date: string;
  cups: number;
}

const KEY = 'hydrate.daily';
const GOAL = 8;

export default function HydrateApp({ app }: AppComponentProps): React.JSX.Element | null {
  const [state, setState] = useState<HydrateState>({ cups: 0, date: todayKey() });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    Store.hydrate<HydrateState>(KEY, { cups: 0, date: todayKey() }).then((v) => {
      const cur = v.date === todayKey() ? v : { cups: 0, date: todayKey() };
      setState(cur);
      Store.set(KEY, cur);
      setReady(true);
    });
  }, []);

  if (!ready) {
    return <Skeleton />;
  }

  const setCups = (n: number): void => {
    const next = { ...state, cups: Math.max(0, Math.min(GOAL, n)) };
    setState(next);
    Store.set(KEY, next);
  };

  return (
    <View style={styles.screen}>
      <Text style={styles.count}>
        {state.cups}
        <Text style={styles.countSmall}> / {GOAL}</Text>
      </Text>

      <View style={styles.grid}>
        {Array.from({ length: GOAL }, (_, i) => {
          const filled = i < state.cups;
          return (
            <Pressable
              key={i}
              onPress={() => setCups(i + 1 > state.cups ? i + 1 : i)}
              style={[styles.cup, filled && { backgroundColor: app.color, borderColor: app.color }]}
            >
              {filled ? <Icon name="Water" size={28} color="#fff" strokeWidth={1.75} /> : null}
            </Pressable>
          );
        })}
      </View>

      <View style={styles.actions}>
        <Pressable
          onPress={() => setCups(state.cups + 1)}
          disabled={state.cups >= GOAL}
          style={[
            styles.primary,
            { backgroundColor: app.color },
            state.cups >= GOAL && { opacity: 0.4 },
          ]}
        >
          <Icon name="Plus" size={16} color="#fff" strokeWidth={2.5} />
          <Text style={styles.primaryText}>Log a cup</Text>
        </Pressable>
        <Pressable onPress={() => setCups(0)} style={styles.soft}>
          <Icon name="Reset" size={14} color={colors.ink} />
          <Text style={styles.softText}>Reset</Text>
        </Pressable>
      </View>

      {state.cups >= GOAL ? <Text style={styles.done}>Done for today.</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: spacing[2], marginTop: spacing[3] },
  count: {
    color: colors.ink,
    fontFamily: family.monoMedium,
    fontSize: 64,
    marginVertical: spacing[3],
  },
  countSmall: { color: colors.ink3, fontSize: 20 },
  cup: {
    alignItems: 'center',
    backgroundColor: colors.bgElev,
    borderColor: colors.line,
    borderRadius: radii.md,
    borderWidth: 1.5,
    height: 64,
    justifyContent: 'center',
    width: 64,
  },
  done: { ...t('small'), color: colors.ink3, marginTop: spacing[4] },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[3],
    justifyContent: 'center',
    marginVertical: spacing[4],
  },
  primary: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: spacing[2],
    paddingHorizontal: 22,
    paddingVertical: 12,
  },
  primaryText: { ...t('body'), color: '#fff', fontWeight: '600' },
  screen: { alignItems: 'center', flex: 1, padding: spacing[5] },
  soft: {
    alignItems: 'center',
    backgroundColor: colors.bgElev,
    borderColor: colors.line,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing[2],
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  softText: { ...t('body'), color: colors.ink, fontWeight: '500' },
});
