import { IDENTITY_HUE_KEYS, identityHueKey } from "@centraid/design";
import type { ColorKey } from "@centraid/design";

import { isOpen } from "./logic.ts";
import type { Project, Section, Task, TaskGroup } from "./types.ts";
import { SECTIONS } from "./view-copy.ts";

export interface ProjectArea {
  key: string;
  label: string;
  projects: Project[];
}

export function projectAreas(
  projects: readonly Project[],
  unfiledLabel: string
): ProjectArea[] {
  const areas = new Map<string, Project[]>();
  for (const project of projects) {
    const key = project.area ?? "";
    const list = areas.get(key);
    if (list) list.push(project);
    else areas.set(key, [project]);
  }
  return [...areas.entries()]
    .sort(([a], [b]) => {
      if (a === "" || b === "") return a === "" ? 1 : -1;
      return a.localeCompare(b);
    })
    .map(([key, list]) => ({
      key,
      label: key || unfiledLabel,
      projects: [...list].sort(
        (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
      ),
    }));
}

export function openCountByProject(
  tasks: readonly Task[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    if (!task.project_id || !isOpen(task)) continue;
    counts[task.project_id] = (counts[task.project_id] ?? 0) + 1;
  }
  return counts;
}

export function projectRows(tasks: readonly Task[], projectId: string): Task[] {
  return tasks.filter((task) => task.project_id === projectId && isOpen(task));
}

export function projectSections(
  sections: readonly Section[],
  projectId: string
): Section[] {
  return sections
    .filter((section) => section.project_id === projectId)
    .sort(
      (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
    );
}

export function projectSectionGroups(input: {
  sections: readonly Section[];
  rows: readonly Task[];
}): TaskGroup[] {
  const bySection = new Map<string, Task[]>();
  for (const task of input.rows) {
    const key = task.section_id ?? "";
    const list = bySection.get(key);
    if (list) list.push(task);
    else bySection.set(key, [task]);
  }
  const unfiled = bySection.get("") ?? [];
  return [
    ...(unfiled.length > 0
      ? [{ key: "no-section", label: SECTIONS.none, rows: unfiled }]
      : []),
    ...input.sections.map((section) => ({
      key: section.section_id,
      label: section.name,
      rows: bySection.get(section.section_id) ?? [],
    })),
  ];
}

const HUES = new Set<string>(IDENTITY_HUE_KEYS);

export function projectHue(project: Project): ColorKey {
  const stored = (project.color ?? "").replace(/^var\(--c-|\)$/gu, "");
  return HUES.has(stored)
    ? (stored as ColorKey)
    : identityHueKey(project.project_id);
}

export function newProjectWrite(input: {
  name: string;
  area?: string | null;
}): Record<string, string> {
  const name = input.name.trim();
  const area = (input.area ?? "").trim();
  return { name, ...(area ? { area } : {}) };
}

export function sectionWrite(input: {
  projectId: string;
  name: string;
  sortOrder: number;
}): Record<string, string | number> {
  return {
    project_id: input.projectId,
    name: input.name.trim(),
    sort_order: input.sortOrder,
  };
}
