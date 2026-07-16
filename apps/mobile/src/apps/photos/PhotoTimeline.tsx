import React, { memo, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import Icon from '../../kit/components/Icon';
import { family, useTheme } from '../../kit/theme';
import type { PhotoAsset, PhotoSection } from './timeline-source';
import { addDragSelection } from './timeline-model';

type TimelineRow =
  | { type: 'month'; key: string; title: string; assets: PhotoAsset[] }
  | { type: 'header'; key: string; title: string; assets: PhotoAsset[] }
  | { type: 'assets'; key: string; assets: PhotoAsset[] };

function rowsFor(sections: PhotoSection[], columns: number): TimelineRow[] {
  return sections.flatMap((section, sectionIndex) => {
    const monthChanged = sectionIndex === 0 || sections[sectionIndex - 1]?.month !== section.month;
    return [
      ...(monthChanged
        ? [
            {
              type: 'month' as const,
              key: `m:${section.month}`,
              title: section.monthTitle,
              assets: section.assets,
            },
          ]
        : []),
      {
        type: 'header' as const,
        key: `h:${section.day}`,
        title: section.title,
        assets: section.assets,
      },
      ...Array.from({ length: Math.ceil(section.assets.length / columns) }, (_, index) => ({
        type: 'assets' as const,
        key: `r:${section.day}:${index}:${columns}`,
        assets: section.assets.slice(index * columns, (index + 1) * columns),
      })),
    ];
  });
}

const AssetCell = memo(function AssetCell({
  asset,
  size,
  selected,
  selecting,
  onOpen,
  onSelect,
}: {
  asset: PhotoAsset;
  size: number;
  selected: boolean;
  selecting: boolean;
  onOpen(asset: PhotoAsset): void;
  onSelect(asset: PhotoAsset): void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={asset.filename ?? `Photo from ${asset.capturedAt}`}
      accessibilityRole="imagebutton"
      onPress={() => (selecting ? onSelect(asset) : onOpen(asset))}
      style={{ height: size, width: size, padding: 1 }}
    >
      <Image
        source={asset.uri}
        placeholder={asset.thumbhash ? { thumbhash: asset.thumbhash } : undefined}
        contentFit="cover"
        transition={120}
        recyclingKey={asset.id}
        style={[styles.image, { backgroundColor: colors.bgSunken }]}
      />
      <View style={styles.badges}>
        {asset.kind === 'video' ? <Icon name="Play" size={14} color="#fff" /> : null}
        {asset.backupState !== 'backed-up' && asset.backupState !== 'remote-only' ? (
          <Feather name="cloud" size={14} color="#fff" />
        ) : null}
      </View>
      {asset.duplicateHint ? (
        <View style={styles.duplicate}>
          <Icon name="Copy" size={12} color="#fff" />
        </View>
      ) : null}
      {selected ? (
        <View style={[styles.selection, { borderColor: colors.accent }]}>
          <View style={[styles.check, { backgroundColor: colors.accent }]}>
            <Icon name="Check" size={13} color="#fff" strokeWidth={2.5} />
          </View>
        </View>
      ) : null}
    </Pressable>
  );
});

export default function PhotoTimeline({
  sections,
  onOpen,
  selection,
  onSelectionChange,
}: {
  sections: PhotoSection[];
  onOpen(asset: PhotoAsset): void;
  selection: Set<string>;
  onSelectionChange(next: Set<string>): void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const { width, height } = useWindowDimensions();
  const [columns, setColumns] = useState(4);
  const [scrubLabel, setScrubLabel] = useState('');
  const list = useRef<FlashListRef<TimelineRow>>(null);
  const scrollOffset = useRef(0);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const rows = useMemo(() => rowsFor(sections, columns), [columns, sections]);
  const cellSize = width / columns;
  const selecting = selection.size > 0;

  const pinch = useMemo(
    () =>
      Gesture.Pinch().onEnd(({ scale }) => {
        const next =
          scale > 1.15
            ? Math.max(2, columns - 1)
            : scale < 0.86
              ? Math.min(7, columns + 1)
              : columns;
        if (next !== columns) runOnJS(setColumns)(next);
      }),
    [columns],
  );

  const toggle = (asset: PhotoAsset): void => {
    void Haptics.selectionAsync();
    const next = new Set(selection);
    if (next.has(asset.id)) next.delete(asset.id);
    else next.add(asset.id);
    onSelectionChange(next);
  };

  const dragSelect = (x: number, y: number): void => {
    let cursor = scrollOffset.current + y;
    const row = rows.find((candidate) => {
      const rowHeight =
        candidate.type === 'month' ? 52 : candidate.type === 'header' ? 42 : cellSize;
      if (cursor < rowHeight) return true;
      cursor -= rowHeight;
      return false;
    });
    if (!row || row.type !== 'assets') return;
    const asset = row.assets[Math.max(0, Math.min(columns - 1, Math.floor(x / cellSize)))];
    if (!asset || selectionRef.current.has(asset.id)) return;
    void Haptics.selectionAsync();
    const next = addDragSelection(selectionRef.current, asset.id);
    selectionRef.current = next;
    onSelectionChange(next);
  };

  const drag = Gesture.Pan()
    .activateAfterLongPress(220)
    .onBegin(({ x, y }) => runOnJS(dragSelect)(x, y))
    .onUpdate(({ x, y }) => runOnJS(dragSelect)(x, y));
  const gestures = Gesture.Simultaneous(pinch, drag);

  const scrub = (pageY: number): void => {
    const ratio = Math.max(0, Math.min(1, (pageY - 100) / Math.max(1, height - 180)));
    const index = Math.min(rows.length - 1, Math.floor(ratio * rows.length));
    void list.current?.scrollToIndex({ index, animated: false, viewPosition: 0 });
    const row = rows[index];
    const asset = row?.assets[0];
    if (asset) {
      setScrubLabel(
        new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }).format(
          new Date(asset.capturedAt),
        ),
      );
    }
  };

  return (
    <GestureDetector gesture={gestures}>
      <View style={styles.fill}>
        <FlashList
          ref={list}
          data={rows}
          keyExtractor={(item) => item.key}
          getItemType={(item) => item.type}
          renderItem={({ item }) =>
            item.type === 'month' ? (
              <View style={[styles.monthHeader, { backgroundColor: colors.bg }]}>
                <Text style={[styles.monthText, { color: colors.ink }]}>{item.title}</Text>
              </View>
            ) : item.type === 'header' ? (
              <View style={[styles.header, { backgroundColor: colors.bg }]}>
                <Text style={[styles.headerText, { color: colors.ink }]}>{item.title}</Text>
                {selecting ? (
                  <Pressable
                    onPress={() =>
                      onSelectionChange(
                        new Set([...selection, ...item.assets.map((asset) => asset.id)]),
                      )
                    }
                  >
                    <Text style={[styles.selectDay, { color: colors.accent }]}>Select day</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : (
              <View style={styles.row}>
                {item.assets.map((asset) => (
                  <AssetCell
                    key={asset.id}
                    asset={asset}
                    size={cellSize}
                    selected={selection.has(asset.id)}
                    selecting={selecting}
                    onOpen={onOpen}
                    onSelect={toggle}
                  />
                ))}
              </View>
            )
          }
          onScrollBeginDrag={() => setScrubLabel('')}
          onScroll={(event) => {
            scrollOffset.current = event.nativeEvent.contentOffset.y;
          }}
          scrollEventThrottle={16}
          contentContainerStyle={{ paddingBottom: 110 }}
        />
        <View
          accessibilityLabel="Timeline scrubber"
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={(event) => scrub(event.nativeEvent.pageY)}
          onResponderMove={(event) => scrub(event.nativeEvent.pageY)}
          onResponderRelease={() => setTimeout(() => setScrubLabel(''), 450)}
          style={styles.scrubber}
        >
          <View style={[styles.rail, { backgroundColor: colors.line }]} />
        </View>
        {scrubLabel ? (
          <View style={[styles.scrubBubble, { backgroundColor: colors.ink }]}>
            <Text style={[styles.scrubText, { color: colors.bg }]}>{scrubLabel}</Text>
          </View>
        ) : null}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  badges: { position: 'absolute', bottom: 7, right: 7, flexDirection: 'row', gap: 5 },
  check: {
    alignItems: 'center',
    borderRadius: 14,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  duplicate: { position: 'absolute', left: 7, bottom: 7 },
  fill: { flex: 1 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    height: 42,
    justifyContent: 'space-between',
    paddingHorizontal: 18,
  },
  headerText: { fontFamily: family.sansBold, fontSize: 13 },
  image: { borderRadius: 3, height: '100%', width: '100%' },
  monthHeader: { height: 52, justifyContent: 'flex-end', paddingHorizontal: 18, paddingBottom: 8 },
  monthText: { fontFamily: family.displayBold, fontSize: 20 },
  rail: { borderRadius: 2, height: '100%', width: 3 },
  row: { flexDirection: 'row' },
  scrubber: {
    alignItems: 'center',
    bottom: 100,
    paddingHorizontal: 8,
    position: 'absolute',
    right: 0,
    top: 50,
    width: 24,
  },
  scrubBubble: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    position: 'absolute',
    right: 30,
    top: '46%',
  },
  scrubText: { fontFamily: family.sansBold, fontSize: 12 },
  selectDay: { fontFamily: family.sansMedium, fontSize: 12 },
  selection: {
    borderWidth: 3,
    borderRadius: 4,
    bottom: 1,
    left: 1,
    position: 'absolute',
    right: 1,
    top: 1,
  },
});
