// The Projects place (Tasks spec §2): projects under their areas, each row
// carrying its own dot, and a New project that asks for what a project needs.
//
// THE DOT IS A CONTENT MARKER, NOT A CONTROL — it is inside the row's press
// target and carries no state of its own.

import React, { useMemo, useState } from "react";
import { FlatList, Pressable, View } from "react-native";

import {
  newProjectWrite,
  projectAreas,
  projectHue,
} from "@centraid/blueprints/apps/tasks/projects";
import type { Project } from "@centraid/blueprints/apps/tasks/types";
import {
  AREAS,
  FIELDS,
  GROUPS,
  NEW_PROJECT,
} from "@centraid/blueprints/apps/tasks/view-copy";
import type { ColorKey } from "@centraid/design";

import { Text, TextInput } from "../../kit/components/NativeText";
import { useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { PROJECT_NAME_PLACEHOLDER } from "./tasks-seat-copy";
import type { TasksStyles } from "./TasksHome.styles";
import type { QuickAddScope } from "./TasksQuickAdd";

function hueColor(colors: ThemeColors, key: ColorKey): string {
  return (
    colors[`c${key.charAt(0).toUpperCase()}${key.slice(1)}`] ?? colors.textFaint
  );
}

type ProjectsItem =
  | { kind: "area"; key: string; label: string }
  | { kind: "project"; key: string; project: Project };

export interface TasksProjectsProps {
  projects: readonly Project[];
  counts: Readonly<Record<string, number>>;
  scopes: readonly QuickAddScope[];
  /** Set while a row has been picked up: a press FILES rather than opens. */
  filing: boolean;
  styles: TasksStyles;
  onOpen: (projectId: string) => void;
  onFile: (projectId: string) => void;
  onCreate: (input: Record<string, string>, scopeId: string | null) => void;
}

export default function TasksProjects({
  projects,
  counts,
  scopes,
  filing,
  styles,
  onOpen,
  onFile,
  onCreate,
}: TasksProjectsProps): React.JSX.Element {
  const { colors } = useTheme();
  const [name, setName] = useState("");
  const [area, setArea] = useState<string>("");
  const [scopeId, setScopeId] = useState<string | null>(scopes[0]?.id ?? null);

  const items = useMemo<ProjectsItem[]>(
    () =>
      projectAreas(projects, GROUPS.inbox).flatMap((entry) => [
        { kind: "area" as const, key: `a:${entry.key}`, label: entry.label },
        ...entry.projects.map((project) => ({
          kind: "project" as const,
          key: project.project_id,
          project,
        })),
      ]),
    [projects]
  );

  const ready = name.trim().length > 0;

  const form = (
    <View style={styles.pane}>
      <Text style={styles.groupLabel}>{NEW_PROJECT.title}</Text>
      <TextInput
        accessibilityLabel={NEW_PROJECT.name}
        placeholder={PROJECT_NAME_PLACEHOLDER}
        placeholderTextColor={colors.textGhost}
        value={name}
        onChangeText={setName}
        style={styles.searchField}
      />
      <View style={styles.fieldRow}>
        <Text style={styles.fieldKey}>{FIELDS.area}</Text>
        <View style={styles.chipRow}>
          {AREAS.map((option) => (
            <Pressable
              key={option}
              accessibilityRole="button"
              accessibilityLabel={option}
              accessibilityState={{ selected: area === option }}
              onPress={() => setArea(area === option ? "" : option)}
              style={[styles.chip, area === option ? styles.chipOn : undefined]}
            >
              <Text
                style={[
                  styles.chipText,
                  area === option ? styles.chipTextOn : undefined,
                ]}
              >
                {option}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      {scopes.length > 1 ? (
        <View style={styles.fieldRow}>
          <Text style={styles.fieldKey}>{FIELDS.homeVault}</Text>
          <View style={styles.chipRow}>
            {scopes.map((scope) => (
              <Pressable
                key={scope.id ?? "own"}
                accessibilityRole="button"
                accessibilityLabel={scope.label}
                accessibilityState={{
                  selected: scopeId === scope.id,
                  disabled: !scope.canWrite,
                }}
                disabled={!scope.canWrite}
                onPress={() => setScopeId(scope.id)}
                style={[
                  styles.chip,
                  scopeId === scope.id ? styles.chipOn : undefined,
                ]}
              >
                <Text
                  style={[
                    styles.chipText,
                    scopeId === scope.id ? styles.chipTextOn : undefined,
                  ]}
                >
                  {scope.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
      <Text style={styles.fieldNote}>{NEW_PROJECT.note}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={NEW_PROJECT.verb}
        accessibilityState={{ disabled: !ready }}
        disabled={!ready}
        onPress={() => {
          onCreate(newProjectWrite({ name, area }), scopeId);
          setName("");
          setArea("");
        }}
        style={[styles.primary, ready ? undefined : styles.primaryOff]}
      >
        <Text style={styles.primaryText}>{NEW_PROJECT.verb}</Text>
      </Pressable>
    </View>
  );

  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.key}
      renderItem={({ item }) => {
        if (item.kind === "area") {
          return (
            <View style={styles.groupHead}>
              <Text style={styles.groupLabel}>{item.label}</Text>
            </View>
          );
        }
        const project = item.project;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={project.name}
            onPress={() =>
              filing ? onFile(project.project_id) : onOpen(project.project_id)
            }
            style={styles.projectRow}
          >
            <View
              style={[
                styles.dot,
                { backgroundColor: hueColor(colors, projectHue(project)) },
              ]}
            />
            <Text style={styles.title}>{project.name}</Text>
            <Text style={styles.num}>{counts[project.project_id] ?? 0}</Text>
            {filing ? (
              <Text style={styles.verbText}>{GROUPS.addTask}</Text>
            ) : null}
          </Pressable>
        );
      }}
      ListFooterComponent={form}
      contentContainerStyle={styles.listContent}
    />
  );
}
