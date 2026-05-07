import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, ScrollView, Pressable, StyleSheet } from 'react-native';
import { Store } from '../storage';
import Icon from '../components/Icon';
import Skeleton from '../components/Skeleton';
import { colors, radii, spacing, t, family } from '../theme';
import type { AppComponentProps } from '../screens/AppDetail';

interface Gift {
  id: number;
  recipient: string;
  idea: string;
  bought: boolean;
}

const KEY = 'gifts.list';
const SEED: Gift[] = [
  {
    bought: false,
    id: 1,
    idea: 'That ceramic mug from Tortus, for her birthday.',
    recipient: 'Mom',
  },
  { bought: false, id: 2, idea: 'A year of fancy hot sauce.', recipient: 'Sam' },
  { bought: false, id: 3, idea: 'The hiking book she keeps mentioning.', recipient: 'Riley' },
];

export default function GiftsApp({ app }: AppComponentProps): React.JSX.Element | null {
  const [gifts, setGifts] = useState<Gift[]>([]);
  const [recipient, setRecipient] = useState('');
  const [idea, setIdea] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    Store.hydrate<Gift[]>(KEY, SEED).then((v) => {
      setGifts(v);
      setReady(true);
    });
  }, []);

  if (!ready) {
    return <Skeleton />;
  }

  const persist = (next: Gift[]): void => {
    setGifts(next);
    Store.set(KEY, next);
  };
  const nextId = gifts.reduce((m, g) => Math.max(m, g.id), 0) + 1;

  const add = (): void => {
    const r = recipient.trim();
    const i = idea.trim();
    if (!r || !i) {
      return;
    }
    persist([{ bought: false, id: nextId, idea: i, recipient: r }, ...gifts]);
    setRecipient('');
    setIdea('');
  };

  const toggle = (id: number): void =>
    persist(gifts.map((g) => (g.id === id ? { ...g, bought: !g.bought } : g)));
  const remove = (id: number): void => persist(gifts.filter((g) => g.id !== id));

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <View style={styles.composer}>
        <TextInput
          value={recipient}
          onChangeText={setRecipient}
          placeholder="For whom?"
          placeholderTextColor={colors.ink4}
          style={styles.input}
        />
        <TextInput
          value={idea}
          onChangeText={setIdea}
          placeholder="The idea — even half-formed."
          placeholderTextColor={colors.ink4}
          multiline
          style={[styles.input, styles.textarea]}
          textAlignVertical="top"
        />
        <Pressable onPress={add} style={[styles.saveBtn, { backgroundColor: app.color }]}>
          <Icon name="Plus" size={14} color="#fff" strokeWidth={2.5} />
          <Text style={styles.saveText}>Save idea</Text>
        </Pressable>
      </View>

      {gifts.length === 0 ? <Text style={styles.empty}>No ideas yet. Add one above.</Text> : null}

      {gifts.map((g) => (
        <View key={g.id} style={[styles.card, g.bought && { opacity: 0.55 }]}>
          <Text style={styles.recipient}>{g.recipient}</Text>
          <Text style={[styles.idea, g.bought && styles.ideaBought]}>{g.idea}</Text>
          <View style={styles.cardActions}>
            <Pressable onPress={() => toggle(g.id)} style={styles.softBtn}>
              <Icon
                name="Check"
                size={14}
                color={g.bought ? app.color : colors.ink}
                strokeWidth={2.5}
              />
              <Text style={[styles.softText, g.bought && { color: app.color }]}>
                {g.bought ? 'Bought' : 'Mark as bought'}
              </Text>
            </Pressable>
            <Pressable onPress={() => remove(g.id)} hitSlop={10}>
              <Icon name="Trash" size={18} color={colors.ink3} />
            </Pressable>
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgElev,
    borderColor: colors.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    marginBottom: spacing[2],
    padding: spacing[3],
  },
  cardActions: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing[2],
  },
  composer: {
    backgroundColor: colors.bgElev,
    borderColor: colors.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing[2],
    marginBottom: spacing[4],
    padding: spacing[3],
  },
  empty: { ...t('body'), color: colors.ink3, paddingVertical: spacing[5], textAlign: 'center' },
  idea: { ...t('body'), color: colors.ink, marginTop: spacing[1] },
  ideaBought: { color: colors.ink3, textDecorationLine: 'line-through' },
  input: {
    backgroundColor: colors.bg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing[3],
    paddingVertical: 10,
    ...t('body'),
    color: colors.ink,
  },
  recipient: {
    ...t('tiny'),
    color: colors.ink3,
    fontFamily: family.monoMedium,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  saveBtn: {
    alignItems: 'center',
    alignSelf: 'flex-end',
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing[2],
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  saveText: { ...t('small'), color: '#fff', fontWeight: '600' },
  scroll: { padding: spacing[4], paddingBottom: spacing[7] },
  softBtn: {
    alignItems: 'center',
    backgroundColor: colors.bg,
    borderColor: colors.line,
    borderRadius: radii.sm,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing[1],
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  softText: { ...t('small'), color: colors.ink, fontWeight: '500' },
  textarea: { minHeight: 70 },
});
