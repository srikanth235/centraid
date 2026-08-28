// The board toolbar (Tasks spec §4) — the count, the three lenses, the sort.
//
// ONE HORIZONTAL SCROLLER, NEVER A WRAP. A `ScrollView` is right here and a
// FlatList is not: the content is four fixed elements, and wrapping them into
// stacked lines at 390px pushes the first task off the screen.

import React from "react";
import { Pressable, ScrollView, View } from "react-native";

import { nextSort } from "@centraid/blueprints/apps/tasks/board-view";
import type {
  TasksLensKey,
  TasksSortKey,
} from "@centraid/blueprints/apps/tasks/board-view";
import {
  LENSES,
  SORT_LABELS,
  boardCount,
} from "@centraid/blueprints/apps/tasks/view-copy";

import { Text } from "../../kit/components/NativeText";
import type { TasksStyles } from "./TasksHome.styles";

export interface TasksToolbarProps {
  count: number;
  unit: string;
  lenses: readonly TasksLensKey[];
  sort: TasksSortKey;
  styles: TasksStyles;
  onLens: (key: TasksLensKey) => void;
  onSort: () => void;
}

export default function TasksToolbar({
  count,
  unit,
  lenses,
  sort,
  styles,
  onLens,
  onSort,
}: TasksToolbarProps): React.JSX.Element {
  const target = SORT_LABELS[nextSort(sort)];
  return (
    <View style={styles.toolbar}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.toolbarRow}
      >
        <Text style={styles.num}>{boardCount(count, unit)}</Text>
        {LENSES.map((lens) => {
          const on = lenses.includes(lens.key);
          return (
            <Pressable
              key={lens.key}
              accessibilityRole="button"
              accessibilityLabel={lens.label}
              accessibilityState={{ selected: on }}
              onPress={() => onLens(lens.key)}
              style={[styles.chip, on ? styles.chipOn : undefined]}
            >
              <Text
                style={[styles.chipText, on ? styles.chipTextOn : undefined]}
              >
                {lens.label}
              </Text>
            </Pressable>
          );
        })}
        {/* The verb names the order it WILL take, so the press is legible
            before it happens. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={target}
          onPress={onSort}
          style={styles.footVerb}
        >
          <Text style={styles.verbText}>{target}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
