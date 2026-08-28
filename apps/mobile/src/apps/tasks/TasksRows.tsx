// A place's rows, its group heads and its foot (Tasks spec §4, §5). A
// FLATLIST, NOT A SCROLLVIEW — no upper bound on rows — and a SKELETON at the
// row geometry rather than a spinner while the first read lands.

import React, { useCallback } from "react";
import { FlatList, Pressable, View } from "react-native";

import type { Task } from "@centraid/blueprints/apps/tasks/types";
import {
  DAY_ONE,
  GROUPS,
  TODAY_DONE,
  windowEndBoard,
} from "@centraid/blueprints/apps/tasks/view-copy";

import { Text } from "../../kit/components/NativeText";
import SkeletonRows from "../../kit/components/SkeletonRows";
import { rowCanWrite } from "../../kit/replica/row-provenance";
import TaskRow from "./TaskRow";
import type { TasksListItem } from "./tasks-groups";
import type { TasksPlaceKey } from "./tasks-places";
import { READING_TASKS, logbookShown } from "./tasks-seat-copy";
import type { TasksStyles } from "./TasksHome.styles";

export interface TasksRowsProps {
  place: TasksPlaceKey;
  items: readonly TasksListItem[];
  shown: number;
  total: number;
  now: string;
  styles: TasksStyles;
  loading: boolean;
  /** Nothing has ever been added, as opposed to nothing being due. */
  dayOne: boolean;
  moving: Task | null;
  /** The row's ONE act where the place gives it one. */
  act?: { label: string; run: (task: Task) => void };
  projectName: (id: string | null | undefined) => string | null;
  onToggle: (task: Task) => void;
  onOpen: (task: Task) => void;
  onPickUp: (task: Task) => void;
  onMoveAll: (rows: readonly Task[]) => void;
  onShowMore: () => void;
  onRefresh: () => void;
}

export default function TasksRows(props: TasksRowsProps): React.JSX.Element {
  const { styles, moving, now, projectName, act } = props;
  const { onMoveAll, onOpen, onPickUp, onToggle } = props;

  const renderItem = useCallback(
    ({ item }: { item: TasksListItem }): React.JSX.Element => {
      if (item.kind === "header") {
        return (
          <View style={styles.groupHead}>
            <Text
              style={[
                styles.groupLabel,
                item.group.attention ? styles.groupLabelAttention : undefined,
              ]}
            >
              {item.group.label}
            </Text>
            {item.group.meta ? (
              <Text style={styles.num}>{item.group.meta}</Text>
            ) : null}
            {/* Withheld where no row could take it. */}
            {item.group.attention &&
            item.group.rows.some((row) => rowCanWrite(row)) ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={GROUPS.moveAll}
                onPress={() => onMoveAll(item.group.rows)}
                style={styles.headVerb}
              >
                <Text style={styles.verbText}>{GROUPS.moveAll}</Text>
              </Pressable>
            ) : null}
          </View>
        );
      }
      return (
        <TaskRow
          task={item.task}
          now={now}
          styles={styles}
          projectName={projectName(item.task.project_id)}
          child={item.child === true}
          picked={moving?.task_id === item.task.task_id}
          onToggle={onToggle}
          onOpen={onOpen}
          onPickUp={onPickUp}
          {...(act ? { act } : {})}
        />
      );
    },
    [
      act,
      moving,
      now,
      onMoveAll,
      onOpen,
      onPickUp,
      onToggle,
      projectName,
      styles,
    ]
  );

  if (props.loading && props.total === 0) {
    return <SkeletonRows accessibilityLabel={READING_TASKS} />;
  }

  const foot = ((): React.JSX.Element | null => {
    if (props.place === "logbook") {
      // The Logbook here has no denominator; the foot says so.
      return <Text style={styles.num}>{logbookShown(props.shown)}</Text>;
    }
    if (props.shown >= props.total) return null;
    return (
      <View style={styles.windowFoot}>
        <Text style={styles.num}>
          {windowEndBoard(props.shown, props.total)}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={GROUPS.showMore}
          onPress={props.onShowMore}
          style={styles.footVerb}
        >
          <Text style={styles.verbText}>{GROUPS.showMore}</Text>
        </Pressable>
      </View>
    );
  })();

  return (
    <FlatList
      data={props.items}
      keyExtractor={(item) => item.key}
      renderItem={renderItem}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>
            {props.dayOne ? DAY_ONE : TODAY_DONE}
          </Text>
        </View>
      }
      ListFooterComponent={foot}
      contentContainerStyle={styles.listContent}
      refreshing={props.loading}
      onRefresh={props.onRefresh}
    />
  );
}
