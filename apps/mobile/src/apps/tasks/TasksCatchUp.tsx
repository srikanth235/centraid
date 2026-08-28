// CATCH UP — the pressure valve (Tasks spec §3, ruling 2).
//
// NOTHING HERE IS A FAILURE. The head states two numbers, the leads say nothing
// was deleted and nothing repeated itself into a pile, and each bucket carries
// exactly ONE bulk verb. A row belongs to exactly one bucket, so no verb acts
// on the same task twice — `reentryBuckets` guarantees that, and this surface
// never re-partitions what it was handed.

import React from "react";
import { FlatList, Pressable, View } from "react-native";

import {
  absence,
  catchUpWrites,
  reentryBuckets,
} from "@centraid/blueprints/apps/tasks/logic";
import type {
  ReentryBucket,
  Task,
} from "@centraid/blueprints/apps/tasks/types";
import {
  REENTRY_BUCKETS,
  REENTRY_FOOT_A,
  REENTRY_FOOT_B,
  REENTRY_LEAD_A,
  REENTRY_LEAD_B,
  REENTRY_NONE,
  reentryHead,
} from "@centraid/blueprints/apps/tasks/view-copy";

import { Text } from "../../kit/components/NativeText";
import { rowCanWrite } from "../../kit/replica/row-provenance";
import TaskRow from "./TaskRow";
import type { TasksStyles } from "./TasksHome.styles";
import type { TasksWrite } from "./useTasks";

type Item =
  | { kind: "bucket"; key: string; bucket: ReentryBucket }
  | { kind: "task"; key: string; task: Task };

export interface TasksCatchUpProps {
  tasks: readonly Task[];
  now: string;
  styles: TasksStyles;
  write: TasksWrite;
  onToggle: (task: Task) => void;
  onOpen: (task: Task) => void;
}

export default function TasksCatchUp({
  tasks,
  now,
  styles,
  write,
  onToggle,
  onOpen,
}: TasksCatchUpProps): React.JSX.Element {
  const away = absence(tasks, now);
  const buckets = reentryBuckets(tasks, now, REENTRY_BUCKETS);

  /** The bucket's own verb, resolved to the writes it actually fires. A
   *  read-only row is skipped rather than dispatched and refused. */
  const runBulk = (bucket: ReentryBucket): void => {
    const rows = bucket.rows.filter((row) => rowCanWrite(row));
    for (const entry of catchUpWrites(bucket.key, rows, now.slice(0, 10))) {
      const row = rows.find((task) => task.task_id === entry.input["task_id"]);
      void write(
        entry.action,
        entry.input as Record<string, string>,
        row?.scope_id
      );
    }
  };

  const items: Item[] = buckets.flatMap((bucket) => [
    { kind: "bucket" as const, key: `b:${bucket.key}`, bucket },
    ...bucket.rows.map((task) => ({
      kind: "task" as const,
      key: task.task_id,
      task,
    })),
  ]);

  const head = (
    <View style={styles.pane}>
      {away ? (
        <Text style={styles.emptyTitle}>
          {reentryHead(away.days, away.due)}
        </Text>
      ) : null}
      <Text style={styles.lead}>{REENTRY_LEAD_A}</Text>
      <Text style={styles.lead}>{REENTRY_LEAD_B}</Text>
      {buckets.length === 0 ? (
        <Text style={styles.lead}>{REENTRY_NONE}</Text>
      ) : null}
    </View>
  );

  const foot = (
    <View style={styles.pane}>
      <Text style={styles.fieldNote}>{REENTRY_FOOT_A}</Text>
      <Text style={styles.fieldNote}>{REENTRY_FOOT_B}</Text>
    </View>
  );

  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.key}
      renderItem={({ item }) =>
        item.kind === "task" ? (
          <TaskRow
            task={item.task}
            now={now}
            styles={styles}
            onToggle={onToggle}
            onOpen={onOpen}
          />
        ) : (
          <View style={styles.groupHead}>
            <Text style={styles.groupLabel}>{item.bucket.label}</Text>
            {item.bucket.rows.some((row) => rowCanWrite(row)) ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={item.bucket.verb}
                onPress={() => runBulk(item.bucket)}
                style={styles.headVerb}
              >
                <Text style={styles.verbText}>{item.bucket.verb}</Text>
              </Pressable>
            ) : null}
          </View>
        )
      }
      ListHeaderComponent={head}
      ListFooterComponent={foot}
      contentContainerStyle={styles.listContent}
    />
  );
}
