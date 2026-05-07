import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Store } from '../storage';
import { todayKey } from '../dateUtil';
import Icon from '../components/Icon';
import Skeleton from '../components/Skeleton';
import { colors, radii, spacing, t, family } from '../theme';
import type { AppComponentProps } from '../screens/AppDetail';

type ModeKey = 'work' | 'shortBreak' | 'longBreak';
interface ModeDef {
  label: string;
  seconds: number;
}
interface FocusStats {
  todayKey: string;
  completed: number;
  totalCompleted: number;
}

const KEY = 'focus.stats';
const MODES: Record<ModeKey, ModeDef> = {
  longBreak: { label: 'Long break', seconds: 15 * 60 },
  shortBreak: { label: 'Short break', seconds: 5 * 60 },
  work: { label: 'Focus', seconds: 25 * 60 },
};

const fmt = (secs: number): string => {
  const m = String(Math.floor(secs / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return `${m}:${s}`;
};

export default function FocusApp({ app }: AppComponentProps): React.JSX.Element | null {
  const [mode, setMode] = useState<ModeKey>('work');
  const [remaining, setRemaining] = useState<number>(MODES.work.seconds);
  const [running, setRunning] = useState<boolean>(false);
  const [stats, setStats] = useState<FocusStats>({
    completed: 0,
    todayKey: todayKey(),
    totalCompleted: 0,
  });
  const [ready, setReady] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    Store.hydrate<FocusStats>(KEY, { completed: 0, todayKey: todayKey(), totalCompleted: 0 }).then(
      (v) => {
        const cur =
          v.todayKey === todayKey()
            ? v
            : { completed: 0, todayKey: todayKey(), totalCompleted: v.totalCompleted };
        setStats(cur);
        Store.set(KEY, cur);
        setReady(true);
      },
    );
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!running) {
      return;
    }
    intervalRef.current = setInterval(() => {
      setRemaining((r) => {
        if (r > 1) {
          return r - 1;
        }
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
        }
        intervalRef.current = null;
        setRunning(false);
        if (mode === 'work') {
          const next = {
            ...stats,
            completed: stats.completed + 1,
            totalCompleted: stats.totalCompleted + 1,
          };
          setStats(next);
          Store.set(KEY, next);
          setMode('shortBreak');
          return MODES.shortBreak.seconds;
        }
        setMode('work');
        return MODES.work.seconds;
      });
    }, 1000);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [running, mode, stats]);

  if (!ready) {
    return <Skeleton />;
  }

  const switchMode = (m: ModeKey): void => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    setRunning(false);
    setMode(m);
    setRemaining(MODES[m].seconds);
  };

  const reset = (): void => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    setRunning(false);
    setRemaining(MODES[mode].seconds);
  };

  const radius = 110;
  const circ = 2 * Math.PI * radius;
  const pct = 1 - remaining / MODES[mode].seconds;
  const dashOffset = circ * (1 - pct);

  return (
    <View style={styles.scroll}>
      <View style={styles.tabs}>
        {(Object.entries(MODES) as [ModeKey, ModeDef][]).map(([key, def]) => (
          <Pressable
            key={key}
            onPress={() => switchMode(key)}
            style={[
              styles.tab,
              mode === key && { backgroundColor: colors.bgElev, borderColor: app.color },
            ]}
          >
            <Text style={[styles.tabText, mode === key && { color: app.color, fontWeight: '600' }]}>
              {def.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.dial}>
        <Svg width={260} height={260} viewBox="0 0 260 260">
          <Circle cx="130" cy="130" r={radius} stroke={colors.line} strokeWidth={6} fill="none" />
          <Circle
            cx="130"
            cy="130"
            r={radius}
            stroke={app.color}
            strokeWidth={6}
            fill="none"
            strokeDasharray={`${circ}`}
            strokeDashoffset={`${dashOffset}`}
            strokeLinecap="round"
            transform="rotate(-90 130 130)"
          />
        </Svg>
        <View style={styles.dialCenter} pointerEvents="none">
          <Text style={styles.time}>{fmt(remaining)}</Text>
          <Text style={styles.modeLabel}>{MODES[mode].label}</Text>
        </View>
      </View>

      <View style={styles.actions}>
        <Pressable
          onPress={() => setRunning((r) => !r)}
          style={[styles.primary, { backgroundColor: app.color }]}
        >
          <Icon name={running ? 'Pause' : 'Play'} size={16} color="#fff" />
          <Text style={styles.primaryText}>{running ? 'Pause' : 'Start'}</Text>
        </Pressable>
        <Pressable onPress={reset} style={styles.soft}>
          <Icon name="Reset" size={14} color={colors.ink} />
          <Text style={styles.softText}>Reset</Text>
        </Pressable>
      </View>

      <View style={styles.stats}>
        <View style={styles.stat}>
          <Text style={styles.statNum}>{stats.completed}</Text>
          <Text style={styles.statLabel}>today</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statNum}>{stats.totalCompleted}</Text>
          <Text style={styles.statLabel}>total</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: spacing[2], marginTop: spacing[4] },
  dial: {
    alignItems: 'center',
    height: 260,
    justifyContent: 'center',
    marginVertical: spacing[3],
    width: 260,
  },
  dialCenter: { alignItems: 'center', position: 'absolute' },
  modeLabel: {
    ...t('tiny'),
    color: colors.ink3,
    letterSpacing: 1,
    marginTop: 4,
    textTransform: 'uppercase',
  },
  primary: {
    alignItems: 'center',
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing[2],
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  primaryText: { ...t('body'), color: '#fff', fontWeight: '600' },
  scroll: { alignItems: 'center', flex: 1, padding: spacing[4] },
  soft: {
    alignItems: 'center',
    backgroundColor: colors.bgElev,
    borderColor: colors.line,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing[2],
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  softText: { ...t('body'), color: colors.ink, fontWeight: '500' },
  stat: { alignItems: 'center' },
  statLabel: {
    ...t('tiny'),
    color: colors.ink3,
    letterSpacing: 1,
    marginTop: 2,
    textTransform: 'uppercase',
  },
  statNum: { color: colors.ink, fontFamily: family.monoBold, fontSize: 24 },
  stats: { flexDirection: 'row', gap: spacing[5], marginTop: spacing[5] },
  tab: {
    backgroundColor: colors.bg,
    borderColor: colors.line,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  tabText: { ...t('small'), color: colors.ink2 },
  tabs: { flexDirection: 'row', gap: spacing[2], marginBottom: spacing[4] },
  time: { color: colors.ink, fontFamily: family.monoMedium, fontSize: 44 },
});
