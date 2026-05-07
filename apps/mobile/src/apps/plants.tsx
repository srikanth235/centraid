import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, ScrollView, Pressable, StyleSheet } from 'react-native';
import { Store } from '../storage';
import { todayKey, daysAgoKey } from '../dateUtil';
import Icon from '../components/Icon';
import Skeleton from '../components/Skeleton';
import { colors, radii, spacing, t } from '../theme';
import type { AppComponentProps } from '../screens/AppDetail';

interface Plant {
  id: number;
  name: string;
  intervalDays: number;
  lastWatered: string | null;
}
interface Status {
  text: string;
  due?: boolean;
  overdue?: boolean;
}

const KEY = 'plants.list';
const SEED: Plant[] = [
  { id: 1, intervalDays: 7, lastWatered: daysAgoKey(5), name: 'Monstera' },
  { id: 2, intervalDays: 5, lastWatered: daysAgoKey(5), name: 'Pothos' },
  { id: 3, intervalDays: 10, lastWatered: daysAgoKey(6), name: 'Fiddle leaf' },
  { id: 4, intervalDays: 14, lastWatered: daysAgoKey(9), name: 'Succulents' },
];

const daysSince = (dateKey: string | null): number => {
  if (!dateKey) {
    return Infinity;
  }
  const ms = Date.now() - new Date(`${dateKey}T00:00:00`).getTime();
  return Math.floor(ms / 86_400_000);
};

const statusOf = (p: Plant): Status => {
  const since = daysSince(p.lastWatered);
  if (since === Infinity) {
    return { overdue: true, text: 'Never watered' };
  }
  const left = p.intervalDays - since;
  if (left < 0) {
    return { overdue: true, text: `Overdue by ${-left} day${-left === 1 ? '' : 's'}` };
  }
  if (left === 0) {
    return { due: true, text: 'Water today' };
  }
  if (left === 1) {
    return { due: true, text: 'Water tomorrow' };
  }
  return { text: `Next in ${left} days` };
};

export default function PlantsApp({ app }: AppComponentProps): React.JSX.Element | null {
  const [plants, setPlants] = useState<Plant[]>([]);
  const [name, setName] = useState('');
  const [days, setDays] = useState('7');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    Store.hydrate<Plant[]>(KEY, SEED).then((v) => {
      setPlants(v);
      setReady(true);
    });
  }, []);

  if (!ready) {
    return <Skeleton />;
  }

  const persist = (next: Plant[]): void => {
    setPlants(next);
    Store.set(KEY, next);
  };
  const nextId = plants.reduce((m, p) => Math.max(m, p.id), 0) + 1;

  const add = (): void => {
    const n = name.trim();
    const d = Math.max(1, Number.parseInt(days, 10) || 7);
    if (!n) {
      return;
    }
    persist([...plants, { id: nextId, intervalDays: d, lastWatered: null, name: n }]);
    setName('');
    setDays('7');
  };

  const water = (id: number): void =>
    persist(plants.map((p) => (p.id === id ? { ...p, lastWatered: todayKey() } : p)));
  const remove = (id: number): void => persist(plants.filter((p) => p.id !== id));

  const sorted = [...plants].toSorted((a, b) => {
    const score = (s: Status): number => (s.overdue ? 0 : s.due ? 1 : 2);
    return score(statusOf(a)) - score(statusOf(b));
  });

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <View style={styles.composer}>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Plant name…"
          placeholderTextColor={colors.ink4}
          style={[styles.input, { flex: 1 }]}
        />
        <TextInput
          value={days}
          onChangeText={setDays}
          keyboardType="number-pad"
          style={[styles.input, { textAlign: 'center', width: 56 }]}
        />
        <Text style={styles.dayLabel}>d</Text>
        <Pressable onPress={add} style={[styles.addBtn, { backgroundColor: app.color }]}>
          <Icon name="Plus" size={18} color="#fff" strokeWidth={2.5} />
        </Pressable>
      </View>

      {sorted.length === 0 ? <Text style={styles.empty}>No plants yet. Add one above.</Text> : null}

      {sorted.map((p) => {
        const s = statusOf(p);
        return (
          <View key={p.id} style={styles.row}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.name}>{p.name}</Text>
              <Text
                style={[
                  styles.status,
                  s.overdue && { color: '#C0392B' },
                  s.due && !s.overdue && { color: app.color },
                ]}
              >
                Every {p.intervalDays}d · {s.text}
              </Text>
            </View>
            <Pressable onPress={() => water(p.id)} style={styles.waterBtn}>
              <Icon name="Water" size={14} color={colors.ink} />
              <Text style={styles.waterText}>Water</Text>
            </Pressable>
            <Pressable onPress={() => remove(p.id)} hitSlop={10}>
              <Icon name="Trash" size={18} color={colors.ink3} />
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  addBtn: {
    alignItems: 'center',
    borderRadius: radii.md,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  composer: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing[2],
    marginBottom: spacing[4],
  },
  dayLabel: { ...t('small'), color: colors.ink3, marginLeft: -4 },
  empty: { ...t('body'), color: colors.ink3, paddingVertical: spacing[5], textAlign: 'center' },
  input: {
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
  status: { ...t('small'), color: colors.ink3, marginTop: 2 },
  waterBtn: {
    alignItems: 'center',
    backgroundColor: colors.bgElev,
    borderColor: colors.line,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing[1],
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  waterText: { ...t('small'), color: colors.ink, fontWeight: '500' },
});
