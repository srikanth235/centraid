import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, ScrollView, Pressable, StyleSheet } from 'react-native';
import { Store } from '../storage';
import Icon from '../components/Icon';
import Skeleton from '../components/Skeleton';
import { colors, radii, spacing, t } from '../theme';
import type { AppComponentProps } from '../screens/AppDetail';

interface Todo {
  id: number;
  text: string;
  done: boolean;
}

const KEY = 'todos.list';
const SEED: Todo[] = [
  { done: false, id: 1, text: 'Email back Maya' },
  { done: false, id: 2, text: 'Pick up dry cleaning' },
  { done: false, id: 3, text: 'Replace shower head' },
];

export default function TodosApp({ app }: AppComponentProps): React.JSX.Element | null {
  const [items, setItems] = useState<Todo[]>([]);
  const [input, setInput] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    Store.hydrate<Todo[]>(KEY, SEED).then((v) => {
      setItems(v);
      setReady(true);
    });
  }, []);

  if (!ready) {
    return <Skeleton />;
  }

  const persist = (next: Todo[]): void => {
    setItems(next);
    Store.set(KEY, next);
  };
  const nextId = items.reduce((m, x) => Math.max(m, x.id), 0) + 1;

  const submit = (): void => {
    const text = input.trim();
    if (!text) {
      return;
    }
    persist([{ done: false, id: nextId, text }, ...items]);
    setInput('');
  };

  const toggle = (id: number): void =>
    persist(items.map((x) => (x.id === id ? { ...x, done: !x.done } : x)));
  const remove = (id: number): void => persist(items.filter((x) => x.id !== id));

  const open = items.filter((x) => !x.done);
  const done = items.filter((x) => x.done);

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <Text style={styles.tally}>{open.length} open</Text>

      <View style={styles.addBar}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Add something to do…"
          placeholderTextColor={colors.ink4}
          style={styles.input}
          onSubmitEditing={submit}
          returnKeyType="done"
        />
        <Pressable onPress={submit} style={[styles.addBtn, { backgroundColor: app.color }]}>
          <Icon name="Plus" size={18} color="#fff" strokeWidth={2.5} />
        </Pressable>
      </View>

      {open.length === 0 && done.length === 0 ? (
        <Text style={styles.empty}>Nothing on your list. Add one above.</Text>
      ) : null}

      {open.map((x) => (
        <Row key={x.id} item={x} onToggle={toggle} onRemove={remove} accent={app.color} />
      ))}

      {done.length > 0 ? <Text style={styles.divider}>Done · {done.length}</Text> : null}

      {done.map((x) => (
        <Row key={x.id} item={x} onToggle={toggle} onRemove={remove} accent={app.color} />
      ))}
    </ScrollView>
  );
}

interface RowProps {
  item: Todo;
  onToggle: (id: number) => void;
  onRemove: (id: number) => void;
  accent: string;
}
function Row({ item, onToggle, onRemove, accent }: RowProps): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => onToggle(item.id)}
        style={[styles.circle, item.done && { backgroundColor: accent, borderColor: accent }]}
      >
        {item.done ? <Icon name="Check" size={14} color="#fff" strokeWidth={2.5} /> : null}
      </Pressable>
      <Text style={[styles.text, item.done && styles.textDone]}>{item.text}</Text>
      <Pressable onPress={() => onRemove(item.id)} hitSlop={10}>
        <Icon name="Trash" size={18} color={colors.ink3} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  addBar: { flexDirection: 'row', gap: spacing[2], marginBottom: spacing[3] },
  addBtn: { alignItems: 'center', borderRadius: radii.md, justifyContent: 'center', width: 44 },
  circle: {
    alignItems: 'center',
    borderColor: colors.line,
    borderRadius: 12,
    borderWidth: 1.5,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  divider: {
    ...t('tiny'),
    color: colors.ink3,
    letterSpacing: 1,
    marginBottom: spacing[1],
    marginTop: spacing[4],
    textTransform: 'uppercase',
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
  row: {
    alignItems: 'center',
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing[3],
    paddingVertical: 12,
  },
  scroll: { padding: spacing[4], paddingBottom: spacing[7] },
  tally: {
    ...t('tiny'),
    color: colors.ink3,
    letterSpacing: 1,
    marginBottom: spacing[2],
    textTransform: 'uppercase',
  },
  text: { ...t('body'), color: colors.ink, flex: 1 },
  textDone: { color: colors.ink3, textDecorationLine: 'line-through' },
});
