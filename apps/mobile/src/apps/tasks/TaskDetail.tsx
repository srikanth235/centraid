// THE TASK DETAIL PLACE (Tasks spec §5) — reached by pressing a row's body,
// and a place WITHIN the one Tasks screen rather than a pushed route.
//
// A FLATLIST, NOT A SCROLLVIEW: the fields are bounded but the family under
// them is not, so the subtasks ARE the list and the fields ride its header.
//
// TWO EXITS, TWO WEIGHTS. Release is a plain secondary — it destroys nothing
// and the Logbook keeps the row as won't do — and Delete is the one outlined
// `net` control in this room. Both name what happens before they happen.

import React, { useCallback } from "react";
import { Alert, FlatList, Pressable, View } from "react-native";

import {
  PROMOTION_AT,
  anchorWrite,
  familySize,
  lifecycleAct,
  projectNameOf,
  projectWrite,
  subtaskNotes,
} from "@centraid/blueprints/apps/tasks/detail";
import { TASK } from "@centraid/blueprints/apps/tasks/shelves";
import type { Project, Task } from "@centraid/blueprints/apps/tasks/types";
import {
  CANCEL,
  DELETE_CONFIRM,
  FIELDS,
  PROMOTION_VERB,
  RELEASE_CONFIRM,
  familyProgress,
  shelfCopy,
} from "@centraid/blueprints/apps/tasks/view-copy";

import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import {
  READ_ONLY_SOURCE_REASON,
  rowCanWrite,
  rowScopeLabels,
} from "../../kit/replica/row-provenance";
import { useTheme } from "../../kit/theme";
import TaskDetailFields from "./TaskDetailFields";
import TaskRow, { isClosed } from "./TaskRow";
import { NOTE_PLACEHOLDER } from "./tasks-seat-copy";
import type { TasksStyles } from "./TasksHome.styles";
import TasksPlaceHeader from "./TasksPlaceHeader";
import type { TasksWrite } from "./useTasks";

/** The vault carrying the row, or nothing — a personal task stays silent. */
function homeVaultOf(task: Task): { vault: string } | null {
  const vault = rowScopeLabels(task)[0];
  return vault ? { vault } : null;
}

/** The zone an anchor is stamped with when the row carries none of its own. */
function seatTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export interface TaskDetailProps {
  task: Task;
  now: string;
  projects: readonly Project[];
  styles: TasksStyles;
  /** The place the member returns to — the one they opened this row from. */
  backTo: string;
  onBack: () => void;
  onOpen: (task: Task) => void;
  write: TasksWrite;
}

export default function TaskDetail({
  task,
  now,
  projects,
  styles,
  backTo,
  onBack,
  onOpen,
  write,
}: TaskDetailProps): React.JSX.Element {
  const { colors } = useTheme();
  const writable = rowCanWrite(task);
  const children = task.children ?? [];
  const lifecycle = lifecycleAct(task);
  const timeZone = seatTimeZone();

  const act = useCallback(
    (action: string, input: Record<string, string | number | boolean>) => {
      void write(action, input, task.scope_id);
    },
    [task.scope_id, write]
  );

  const setStatus = useCallback(
    (row: Task, status: Task["status"]) => {
      if (!rowCanWrite(row)) return;
      void write("set-status", { task_id: row.task_id, status }, row.scope_id);
    },
    [write]
  );

  const toggle = useCallback(
    (row: Task) => {
      setStatus(row, isClosed(row) ? "needs-action" : "completed");
    },
    [setStatus]
  );

  // Both exits name what happens to the row before it happens; the two-sentence
  // body is the table's pair, rendered as the one paragraph a dialog can hold.
  const confirmRelease = useCallback(() => {
    Alert.alert(
      RELEASE_CONFIRM.title,
      `${RELEASE_CONFIRM.bodyA} ${RELEASE_CONFIRM.bodyB}`,
      [
        { text: CANCEL, style: "cancel" },
        {
          text: RELEASE_CONFIRM.verb,
          onPress: () => setStatus(task, "cancelled"),
        },
      ]
    );
  }, [setStatus, task]);

  const confirmDelete = useCallback(() => {
    Alert.alert(
      DELETE_CONFIRM.title,
      `${DELETE_CONFIRM.bodyA} ${DELETE_CONFIRM.bodyB}`,
      [
        { text: CANCEL, style: "cancel" },
        {
          text: DELETE_CONFIRM.verb,
          style: "destructive",
          onPress: () => {
            act("delete", { task_id: task.task_id });
            onBack();
          },
        },
      ]
    );
  }, [act, onBack, task.task_id]);

  const head = (
    <View>
      <View style={styles.detailTop}>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel={task.title}
          accessibilityState={{ checked: isClosed(task), disabled: !writable }}
          accessibilityHint={writable ? undefined : READ_ONLY_SOURCE_REASON}
          disabled={!writable}
          onPress={() => toggle(task)}
          style={styles.box}
        >
          {isClosed(task) ? (
            <Icon name="Check" size={14} color={colors.text} />
          ) : null}
        </Pressable>
        <TextInput
          key={task.task_id}
          accessibilityLabel={task.title}
          defaultValue={task.title}
          editable={writable}
          onEndEditing={(event) => {
            const title = event.nativeEvent.text.trim();
            if (title && title !== task.title)
              act("edit", { task_id: task.task_id, title });
          }}
          style={styles.detailTitle}
        />
      </View>
      <View style={styles.pane}>
        <TextInput
          key={`note:${task.task_id}`}
          accessibilityLabel={FIELDS.notes}
          defaultValue={task.description ?? ""}
          editable={writable}
          multiline
          placeholder={NOTE_PLACEHOLDER}
          placeholderTextColor={colors.textGhost}
          onEndEditing={(event) => {
            const next = event.nativeEvent.text.trim();
            if (next === (task.description ?? "")) return;
            act(
              "edit",
              next
                ? { task_id: task.task_id, description: next }
                : { task_id: task.task_id, clear_description: true }
            );
          }}
          style={styles.detailNote}
        />
        {writable ? null : (
          <Text style={styles.readOnly}>{READ_ONLY_SOURCE_REASON}</Text>
        )}
        <TaskDetailFields
          task={task}
          now={now}
          projects={projects}
          projectName={projectNameOf(task, projects)}
          home={homeVaultOf(task)}
          writable={writable}
          styles={styles}
          onAnchor={(anchor) =>
            act("organize-task", anchorWrite(task, anchor, timeZone))
          }
          onPriority={(priority) =>
            act("edit", { task_id: task.task_id, priority })
          }
          onEffort={(effort_min) =>
            act("edit", { task_id: task.task_id, effort_min })
          }
          onProject={(projectId) =>
            act("organize-task", projectWrite(task, projectId))
          }
          onAddTag={(label) => act("add-tag", { task_id: task.task_id, label })}
          onRemoveTag={(tagId) => act("remove-tag", { tag_id: tagId })}
        />
        <View style={styles.fieldRow}>
          <Text style={styles.fieldKey}>{FIELDS.subtasks}</Text>
          <View style={styles.fieldBody}>
            <Text style={styles.num}>
              {familyProgress(task.done_children ?? 0, children.length)}
            </Text>
            {subtaskNotes(task).map((note) => (
              <Text key={note} style={styles.fieldNote}>
                {note}
              </Text>
            ))}
            {familySize(task) >= PROMOTION_AT && writable ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={PROMOTION_VERB}
                onPress={() => void write("save-project", { name: task.title })}
                style={styles.footVerb}
              >
                <Text style={styles.verbText}>{PROMOTION_VERB}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>
    </View>
  );

  const foot = (
    <View style={[styles.foot, styles.pane]}>
      {lifecycle && writable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={lifecycle.verb}
          onPress={() => setStatus(task, lifecycle.status)}
          style={styles.footVerb}
        >
          <Text style={styles.verbText}>{lifecycle.verb}</Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={RELEASE_CONFIRM.verb}
        accessibilityState={{ disabled: !writable }}
        accessibilityHint={writable ? undefined : READ_ONLY_SOURCE_REASON}
        disabled={!writable}
        onPress={confirmRelease}
        style={styles.footVerb}
      >
        <Text style={styles.verbText}>{RELEASE_CONFIRM.verb}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={DELETE_CONFIRM.verb}
        accessibilityState={{ disabled: !writable }}
        accessibilityHint={writable ? undefined : READ_ONLY_SOURCE_REASON}
        disabled={!writable}
        onPress={confirmDelete}
        style={[styles.footVerb, styles.footNet]}
      >
        <Text style={[styles.verbText, styles.footNetText]}>
          {DELETE_CONFIRM.verb}
        </Text>
      </Pressable>
    </View>
  );

  return (
    <>
      <TasksPlaceHeader
        title={shelfCopy(TASK).title}
        backTo={backTo}
        onBack={onBack}
        styles={styles}
      />
      <FlatList
        data={children}
        keyExtractor={(child) => child.task_id}
        renderItem={({ item }) => (
          <TaskRow
            task={item}
            now={now}
            styles={styles}
            child
            onToggle={toggle}
            onOpen={onOpen}
          />
        )}
        ListHeaderComponent={head}
        ListFooterComponent={foot}
        contentContainerStyle={styles.listContent}
      />
    </>
  );
}
