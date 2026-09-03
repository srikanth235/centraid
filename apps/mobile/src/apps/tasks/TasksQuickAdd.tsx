import React from "react";
import { Pressable, ScrollView, View } from "react-native";

import {
  quickAddLandsIn,
  quickAddReady,
} from "@centraid/blueprints/apps/tasks/quick-add";
import type { QuickAddDraft } from "@centraid/blueprints/apps/tasks/quick-add";
import type { Project } from "@centraid/blueprints/apps/tasks/types";
import {
  FIELDS,
  GROUPS,
  PRIORITY_CHIPS,
  QUICK_ADD,
  QUICK_ADD_WHEN,
} from "@centraid/blueprints/apps/tasks/view-copy";

import { Text, TextInput } from "../../kit/components/NativeText";
import { TEST_IDS } from "../../kit/test-ids";
import { useTheme } from "../../kit/theme";
import type { TasksStyles } from "./TasksHome.styles";

export interface QuickAddScope {
  id: string | null;
  label: string;
  canWrite: boolean;
}

export interface TasksQuickAddProps {
  draft: QuickAddDraft;
  projects: readonly Project[];
  scopes: readonly QuickAddScope[];
  styles: TasksStyles;
  onDraft: (next: QuickAddDraft) => void;
  onAdd: () => void;
}

function ChipRow({
  label,
  choices,
  styles,
}: {
  label: string;
  choices: readonly {
    key: string;
    label: string;
    on: boolean;
    disabled?: boolean;
    press: () => void;
  }[];
  styles: TasksStyles;
}): React.JSX.Element {
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldKey}>{label}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
      >
        {choices.map((choice) => (
          <Pressable
            key={choice.key}
            accessibilityRole="button"
            accessibilityLabel={choice.label}
            accessibilityState={{
              selected: choice.on,
              disabled: choice.disabled === true,
            }}
            disabled={choice.disabled === true}
            onPress={() => choice.press()}
            style={[styles.chip, choice.on ? styles.chipOn : undefined]}
          >
            <Text
              style={[
                styles.chipText,
                choice.on ? styles.chipTextOn : undefined,
              ]}
            >
              {choice.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

export default function TasksQuickAdd({
  draft,
  projects,
  scopes,
  styles,
  onDraft,
  onAdd,
}: TasksQuickAddProps): React.JSX.Element {
  const { colors } = useTheme();
  const ready = quickAddReady(draft);
  const vault =
    scopes.find((scope) => scope.id === draft.scopeId)?.label ??
    scopes[0]?.label ??
    "";
  const projectName =
    projects.find((project) => project.project_id === draft.projectId)?.name ??
    null;

  return (
    <View>
      {ready ? (
        <View style={styles.pane}>
          <ChipRow
            label={FIELDS.when}
            styles={styles}
            choices={QUICK_ADD_WHEN.map((choice) => ({
              key: choice.key,
              label: choice.label,
              on: draft.when === choice.key,
              press: () => onDraft({ ...draft, when: choice.key }),
            }))}
          />
          <ChipRow
            label={FIELDS.where}
            styles={styles}
            choices={[
              {
                key: "inbox",
                label: GROUPS.inbox,
                on: draft.projectId === null,
                press: () => onDraft({ ...draft, projectId: null }),
              },
              ...projects.map((project) => ({
                key: project.project_id,
                label: project.name,
                on: draft.projectId === project.project_id,
                press: () =>
                  onDraft({ ...draft, projectId: project.project_id }),
              })),
            ]}
          />
          <ChipRow
            label={FIELDS.priority}
            styles={styles}
            choices={PRIORITY_CHIPS.map((label, level) => ({
              key: label,
              label,
              on: draft.priority === level,
              press: () => onDraft({ ...draft, priority: level }),
            }))}
          />
          {/* One vault is where it lands with no choice to make; the row
              appears only where there is genuinely more than one. */}
          {scopes.length > 1 ? (
            <ChipRow
              label={FIELDS.landsIn}
              styles={styles}
              choices={scopes.map((scope) => ({
                key: scope.id ?? "own",
                label: scope.label,
                on: (draft.scopeId ?? null) === scope.id,
                disabled: !scope.canWrite,
                press: () => onDraft({ ...draft, scopeId: scope.id }),
              }))}
            />
          ) : null}
          <Text style={styles.fieldNote}>{QUICK_ADD.assistant}</Text>
          <Text style={styles.num}>
            {quickAddLandsIn({ projectName, vault })}
          </Text>
        </View>
      ) : null}
      <View style={styles.capture}>
        <TextInput
          accessibilityLabel={QUICK_ADD.add}
          testID={TEST_IDS.tasks.capture}
          placeholder={QUICK_ADD.touchPlaceholder}
          placeholderTextColor={colors.textGhost}
          value={draft.title}
          onChangeText={(title) => onDraft({ ...draft, title })}
          onSubmitEditing={onAdd}
          style={styles.captureField}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={QUICK_ADD.add}
          accessibilityState={{ disabled: !ready }}
          disabled={!ready}
          onPress={onAdd}
          style={[styles.primary, ready ? undefined : styles.primaryOff]}
        >
          <Text style={styles.primaryText}>{QUICK_ADD.add}</Text>
        </Pressable>
      </View>
    </View>
  );
}
