import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, ScrollView, Pressable, StyleSheet } from 'react-native';
import { Store } from '../storage';
import { todayKey, formatDate, formatShort } from '../dateUtil';
import Icon from '../components/Icon';
import Skeleton from '../components/Skeleton';
import { colors, radii, spacing, t, family } from '../theme';
import type { AppComponentProps } from './_types';

type Entries = Record<string, string>;
const KEY = 'journal.entries';

export default function JournalApp(_: AppComponentProps): React.JSX.Element | null {
  const [entries, setEntries] = useState<Entries>({});
  const [activeDate, setActiveDate] = useState<string>(todayKey());
  const [text, setText] = useState('');
  const [ready, setReady] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    Store.hydrate<Entries>(KEY, {}).then((v) => {
      setEntries(v);
      const tk = todayKey();
      setText(v[tk] ?? '');
      setReady(true);
    });
  }, []);

  if (!ready) {
    return <Skeleton />;
  }

  const onChange = (val: string): void => {
    setText(val);
    const next = { ...entries, [activeDate]: val };
    setEntries(next);
    Store.set(KEY, next);
  };

  const switchTo = (d: string): void => {
    setActiveDate(d);
    setText(entries[d] ?? '');
    setShowHistory(false);
  };

  const newToday = (): void => {
    const tk = todayKey();
    if (!entries[tk]) {
      const next = { ...entries, [tk]: '' };
      setEntries(next);
      Store.set(KEY, next);
    }
    switchTo(tk);
  };

  const removeActive = (): void => {
    const next: Entries = { ...entries };
    delete next[activeDate];
    const remaining = Object.keys(next).toSorted().toReversed();
    const target = remaining[0] ?? todayKey();
    if (next[target] === undefined) {
      next[target] = '';
    }
    setEntries(next);
    Store.set(KEY, next);
    setActiveDate(target);
    setText(next[target] ?? '');
  };

  const dates = Object.keys(entries).toSorted().toReversed();

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.toolbar}>
        <Pressable onPress={() => setShowHistory((s) => !s)} style={styles.chip}>
          <Icon name="Journal" size={14} color={colors.ink} />
          <Text style={styles.chipText}>
            {showHistory ? 'Hide history' : `${dates.length} entries`}
          </Text>
        </Pressable>
        <Pressable onPress={newToday} style={[styles.chip, styles.chipPrimary]}>
          <Icon name="Plus" size={14} color="#fff" strokeWidth={2} />
          <Text style={[styles.chipText, { color: '#fff' }]}>Today</Text>
        </Pressable>
      </View>

      {showHistory ? (
        <ScrollView style={styles.history}>
          {dates.length === 0 ? (
            <Text style={styles.empty}>No entries yet.</Text>
          ) : (
            dates.map((d) => (
              <Pressable
                key={d}
                onPress={() => switchTo(d)}
                style={[styles.histItem, d === activeDate && { backgroundColor: colors.bgElev }]}
              >
                <Text style={styles.histDate}>{formatShort(d)}</Text>
                <Text style={styles.histPreview} numberOfLines={1}>
                  {(entries[d] ?? '').slice(0, 80) || 'Empty'}
                </Text>
              </Pressable>
            ))
          )}
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.editor}>
          <Text style={styles.dateLabel}>{formatDate(activeDate)}</Text>
          <TextInput
            value={text}
            onChangeText={onChange}
            placeholder="What happened today?"
            placeholderTextColor={colors.ink4}
            multiline
            style={styles.textarea}
            textAlignVertical="top"
          />
          <Pressable onPress={removeActive} style={styles.deleteBtn}>
            <Icon name="Trash" size={14} color={colors.ink3} />
            <Text style={styles.deleteText}>Delete entry</Text>
          </Pressable>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignItems: 'center',
    backgroundColor: colors.bgElev,
    borderColor: colors.line,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing[2],
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipPrimary: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { ...t('small'), color: colors.ink, fontWeight: '500' },
  dateLabel: {
    ...t('tiny'),
    color: colors.ink3,
    fontFamily: family.monoMedium,
    letterSpacing: 1,
    marginBottom: spacing[2],
    textTransform: 'uppercase',
  },
  deleteBtn: { alignItems: 'center', flexDirection: 'row', gap: spacing[2], paddingVertical: 8 },
  deleteText: { ...t('small'), color: colors.ink3 },
  editor: { padding: spacing[4], paddingBottom: spacing[7] },
  empty: { ...t('body'), color: colors.ink3, padding: spacing[5], textAlign: 'center' },
  histDate: { ...t('bodyStrong'), color: colors.ink },
  histItem: {
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  histPreview: { ...t('small'), color: colors.ink3, marginTop: 2 },
  history: { flex: 1 },
  textarea: {
    minHeight: 320,
    ...t('body'),
    color: colors.ink,
    lineHeight: 24,
    backgroundColor: colors.bgElev,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing[3],
    marginBottom: spacing[3],
  },
  toolbar: {
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
});
