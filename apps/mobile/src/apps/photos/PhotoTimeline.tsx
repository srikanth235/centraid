import React, { memo, useCallback, useMemo, useRef, useState } from 'react';
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
import { imageSource } from './media-source';

type TimelineRow =
  | { type: 'month'; key: string; title: string; assets: PhotoAsset[] }
  | { type: 'header'; key: string; title: string; assets: PhotoAsset[] }
  | {
      type: 'assets';
      key: string;
      assets: PhotoAsset[];
      height: number;
      widths: number[];
    };

// Hoisted so the scrubber doesn't build a fresh Intl formatter on every move.
const MONTH_YEAR_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });

const ratioFor = (asset: PhotoAsset): number =>
  Math.max(0.65, Math.min(1.9, asset.width && asset.height ? asset.width / asset.height : 1));

const rowHeightOf = (row: TimelineRow): number =>
  row.type === 'month' ? 52 : row.type === 'header' ? 42 : row.height;

function assetRows(
  assets: PhotoAsset[],
  columns: number,
  width: number,
  key: string,
): TimelineRow[] {
  const chunks: PhotoAsset[][] = [];
  let chunk: PhotoAsset[] = [];
  let ratioSum = 0;
  for (const asset of assets) {
    chunk.push(asset);
    ratioSum += ratioFor(asset);
    if (ratioSum >= columns || chunk.length >= columns + 1) {
      chunks.push(chunk);
      chunk = [];
      ratioSum = 0;
    }
  }
  if (chunk.length) chunks.push(chunk);
  return chunks.map((rowAssets, index) => {
    const ratios = rowAssets.map(ratioFor);
    const sum = ratios.reduce((total, ratio) => total + ratio, 0);
    const isLooseFinalRow = index === chunks.length - 1 && sum < columns * 0.82;
    const gapWidth = Math.max(0, rowAssets.length - 1) * 2;
    const height = isLooseFinalRow ? width / columns : (width - gapWidth) / sum;
    return {
      type: 'assets' as const,
      key: `r:${key}:${index}:${columns}`,
      assets: rowAssets,
      height,
      widths: ratios.map((ratio) => ratio * height),
    };
  });
}

function rowsFor(sections: PhotoSection[], columns: number, width: number): TimelineRow[] {
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
      ...assetRows(section.assets, columns, width, section.day),
    ];
  });
}

const AssetCell = memo(function AssetCell({
  asset,
  height,
  width,
  selected,
  selecting,
  onOpen,
  onSelect,
}: {
  asset: PhotoAsset;
  height: number;
  width: number;
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
      style={{ height, width }}
    >
      <Image
        source={imageSource(asset.uri)}
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
  const rows = useMemo(() => rowsFor(sections, columns, width), [columns, sections, width]);
  const monthHeaderIndices = useMemo(
    () => rows.flatMap((row, index) => (row.type === 'month' ? [index] : [])),
    [rows],
  );
  // Prefix-summed row tops, so a drag maps a y-offset to its row by binary
  // search instead of re-walking every row's height on each pan event.
  const rowTops = useMemo(() => {
    let cursor = 0;
    return rows.map((row) => {
      const top = cursor;
      cursor += rowHeightOf(row);
      return top;
    });
  }, [rows]);
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

  // Stable identities so the memoized AssetCell isn't invalidated every render
  // by a fresh closure. onOpen is read through a ref so a parent passing an
  // inline arrow doesn't defeat the memo either.
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const handleOpen = useCallback((asset: PhotoAsset): void => onOpenRef.current(asset), []);
  const toggle = useCallback(
    (asset: PhotoAsset): void => {
      void Haptics.selectionAsync();
      const next = new Set(selectionRef.current);
      if (next.has(asset.id)) next.delete(asset.id);
      else next.add(asset.id);
      onSelectionChange(next);
    },
    [onSelectionChange],
  );

  // Hit-test a gesture point (relative to the list view) to the asset under it.
  // Shared by tap-to-open and long-press drag-select so both agree on geometry.
  const assetAt = (x: number, y: number): PhotoAsset | undefined => {
    const cursor = scrollOffset.current + y;
    // Binary search for the row whose band contains the cursor.
    let lo = 0;
    let hi = rows.length - 1;
    let rowIndex = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const top = rowTops[mid]!;
      const bottom = top + rowHeightOf(rows[mid]!);
      if (cursor < top) hi = mid - 1;
      else if (cursor >= bottom) lo = mid + 1;
      else {
        rowIndex = mid;
        break;
      }
    }
    const row = rowIndex >= 0 ? rows[rowIndex] : undefined;
    if (!row || row.type !== 'assets') return undefined;
    let position = Math.max(0, x);
    let assetIndex = 0;
    for (let index = 0; index < row.widths.length; index += 1) {
      if (position <= row.widths[index]!) {
        assetIndex = index;
        break;
      }
      position -= row.widths[index]! + 2;
      assetIndex = Math.min(index + 1, row.assets.length - 1);
    }
    return row.assets[assetIndex];
  };

  const dragSelect = (x: number, y: number): void => {
    const asset = assetAt(x, y);
    if (!asset || selectionRef.current.has(asset.id)) return;
    void Haptics.selectionAsync();
    const next = addDragSelection(selectionRef.current, asset.id);
    selectionRef.current = next;
    onSelectionChange(next);
  };

  // Quick tap: open the photo (or toggle it while multi-selecting). This MUST be
  // a gesture, not just the cell's <Pressable onPress>: the ancestor Pan below
  // claims the whole touch sequence on iOS, so the JS-responder-based Pressable
  // never receives the tap. Routing tap through the same gesture system that
  // owns long-press is what makes a plain tap register at all.
  const tapAsset = (x: number, y: number): void => {
    const asset = assetAt(x, y);
    if (!asset) return;
    if (selectionRef.current.size > 0) toggle(asset);
    else handleOpen(asset);
  };

  const tap = Gesture.Tap().onEnd((event, success) => {
    if (success) runOnJS(tapAsset)(event.x, event.y);
  });
  // Select on long-press *activation* (onStart), not touch-begin (onBegin): the
  // latter fired on every touch-down — including quick taps — and fought the tap
  // gesture. The drag only starts after the 220ms hold, so onStart is the moment
  // the first cell is grabbed; onUpdate extends the selection as the finger moves.
  const drag = Gesture.Pan()
    .activateAfterLongPress(220)
    .onStart(({ x, y }) => runOnJS(dragSelect)(x, y))
    .onUpdate(({ x, y }) => runOnJS(dragSelect)(x, y));
  // Exclusive(drag, tap): a held gesture becomes a drag-select, a quick release a
  // tap — never both. Pinch (two fingers) runs simultaneously with either.
  const gestures = Gesture.Simultaneous(pinch, Gesture.Exclusive(drag, tap));

  const scrub = (pageY: number): void => {
    const ratio = Math.max(0, Math.min(1, (pageY - 100) / Math.max(1, height - 180)));
    const index = Math.min(rows.length - 1, Math.floor(ratio * rows.length));
    void list.current?.scrollToIndex({ index, animated: false, viewPosition: 0 });
    const row = rows[index];
    const asset = row?.assets[0];
    if (asset) {
      setScrubLabel(MONTH_YEAR_FORMAT.format(new Date(asset.capturedAt)));
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
          stickyHeaderIndices={monthHeaderIndices}
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
              <View style={[styles.row, { height: item.height }]}>
                {item.assets.map((asset, index) => (
                  <AssetCell
                    key={asset.id}
                    asset={asset}
                    height={item.height}
                    width={item.widths[index] ?? item.height}
                    selected={selection.has(asset.id)}
                    selecting={selecting}
                    onOpen={handleOpen}
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
  row: { flexDirection: 'row', gap: 2, marginBottom: 2 },
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
