// Projects and one project's screen (§2, §5). The two rules worth pinning:
// a project with no area is not filed under an invented one, and an empty
// section keeps its head so the writing surface still has somewhere to add.
import { describe, expect, it } from "vitest";

import { IDENTITY_HUE_KEYS } from "@centraid/design";

import {
  newProjectWrite,
  openCountByProject,
  projectAreas,
  projectHue,
  projectRows,
  projectSectionGroups,
  projectSections,
  sectionWrite,
} from "./projects.ts";
import type { Project, Section, Task } from "./types.ts";
import { GROUPS, SECTIONS } from "./view-copy.ts";

function project(patch: Partial<Project> & { project_id: string }): Project {
  return { name: patch.project_id, sort_order: 0, ...patch };
}

function task(patch: Partial<Task> & { task_id: string }): Task {
  return { status: "needs-action", title: patch.task_id, ...patch };
}

const PROJECTS: Project[] = [
  project({ project_id: "work-a", name: "Ship it", area: "Work" }),
  project({ project_id: "home-a", name: "Kitchen", area: "Home" }),
  project({ project_id: "loose", name: "Someday" }),
];

describe("projects under their areas", () => {
  it("orders the areas and leaves the unfiled ones last", () => {
    const areas = projectAreas(PROJECTS, GROUPS.inbox);
    expect(areas.map((area) => area.label)).toStrictEqual([
      "Home",
      "Work",
      GROUPS.inbox,
    ]);
    expect(areas.at(-1)?.key).toBe("");
  });

  it("keeps the member's manual order inside an area", () => {
    const areas = projectAreas(
      [
        project({
          project_id: "b",
          name: "Bathroom",
          area: "Home",
          sort_order: 2,
        }),
        project({
          project_id: "a",
          name: "Attic",
          area: "Home",
          sort_order: 1,
        }),
      ],
      GROUPS.inbox
    );
    expect(areas[0]?.projects.map((entry) => entry.project_id)).toStrictEqual([
      "a",
      "b",
    ]);
  });

  it("counts only the OPEN rows a project holds", () => {
    const counts = openCountByProject([
      task({ task_id: "1", project_id: "home-a" }),
      task({ task_id: "2", project_id: "home-a", status: "completed" }),
      task({ task_id: "3" }),
    ]);
    expect(counts).toStrictEqual({ "home-a": 1 });
  });

  it("gives every project a stable dot from the ring", () => {
    expect(
      projectHue(project({ project_id: "p", color: "var(--c-teal)" }))
    ).toBe("teal");
    expect(projectHue(project({ project_id: "p", color: "forest" }))).toBe(
      "forest"
    );
    const derived = projectHue(project({ project_id: "p" }));
    expect(IDENTITY_HUE_KEYS).toContain(derived);
    expect(projectHue(project({ project_id: "p" }))).toBe(derived);
  });
});

describe("one project's own screen", () => {
  const sections: Section[] = [
    { section_id: "s2", project_id: "home-a", name: "Later", sort_order: 2 },
    { section_id: "s1", project_id: "home-a", name: "Now", sort_order: 1 },
    {
      section_id: "other",
      project_id: "work-a",
      name: "Elsewhere",
      sort_order: 1,
    },
  ];

  it("takes only this project's sections, in its own order", () => {
    expect(
      projectSections(sections, "home-a").map((entry) => entry.section_id)
    ).toStrictEqual(["s1", "s2"]);
  });

  it("takes only this project's OPEN rows", () => {
    const rows = projectRows(
      [
        task({ task_id: "a", project_id: "home-a" }),
        task({ task_id: "b", project_id: "home-a", status: "cancelled" }),
        task({ task_id: "c", project_id: "work-a" }),
      ],
      "home-a"
    );
    expect(rows.map((row) => row.task_id)).toStrictEqual(["a"]);
  });

  it("keeps an empty section's head so it still has somewhere to add", () => {
    const groups = projectSectionGroups({
      sections: projectSections(sections, "home-a"),
      rows: [task({ task_id: "a", section_id: "s1" })],
    });
    expect(groups.map((group) => group.label)).toStrictEqual(["Now", "Later"]);
    expect(groups[1]?.rows).toStrictEqual([]);
  });

  it("heads the unsectioned rows, and only when there are some", () => {
    const rows = [task({ task_id: "loose" })];
    expect(projectSectionGroups({ sections: [], rows })[0]?.label).toBe(
      SECTIONS.none
    );
    expect(projectSectionGroups({ sections: [], rows: [] })).toStrictEqual([]);
  });
});

describe("what the two New verbs write", () => {
  it("asks a project for its name and area, and drops an empty area", () => {
    expect(
      newProjectWrite({ name: "  Kitchen  ", area: "Home" })
    ).toStrictEqual({ name: "Kitchen", area: "Home" });
    expect(newProjectWrite({ name: "Kitchen", area: "  " })).toStrictEqual({
      name: "Kitchen",
    });
  });

  it("puts a new section at the end of the project's own order", () => {
    expect(
      sectionWrite({ projectId: "home-a", name: " Now ", sortOrder: 3 })
    ).toStrictEqual({ project_id: "home-a", name: "Now", sort_order: 3 });
  });
});
