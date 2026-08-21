import { describe, expect, it } from "vitest";

import { updateAppMetaFiles } from "./app-meta.js";
import type { ScaffoldFile } from "./scaffold-types.js";

function byPath(files: ScaffoldFile[]): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

describe(updateAppMetaFiles, () => {
  const base = (description?: string): ScaffoldFile[] => [
    {
      path: "app.json",
      content:
        JSON.stringify(
          {
            manifestVersion: 1,
            id: "todos",
            name: "Todos",
            version: "0.1.0",
            ...(description === undefined ? {} : { description }),
          },
          null,
          2
        ) + "\n",
    },
  ];

  it("rewrites app.json#name on rename and touches nothing else", () => {
    const changed = byPath(
      updateAppMetaFiles(base(), "todos", { name: "Tasks" })
    );
    expect([...changed.keys()]).toStrictEqual(["app.json"]);
    expect(
      (JSON.parse(changed.get("app.json")!) as { name: string }).name
    ).toBe("Tasks");
  });

  it("propagates a rename into every automations/<id>/automation.json", () => {
    const files: ScaffoldFile[] = [
      ...base(),
      {
        path: "automations/wake/automation.json",
        content: JSON.stringify({ name: "Todos" }, null, 2) + "\n",
      },
    ];
    const changed = byPath(
      updateAppMetaFiles(files, "todos", { name: "Tasks" })
    );
    expect([...changed.keys()].sort()).toStrictEqual([
      "app.json",
      "automations/wake/automation.json",
    ]);
    expect(
      (
        JSON.parse(changed.get("automations/wake/automation.json")!) as {
          name: string;
        }
      ).name
    ).toBe("Tasks");
  });

  it("clears description on empty patch and only touches app.json", () => {
    const changed = byPath(
      updateAppMetaFiles(base("x"), "todos", { description: "   " })
    );
    expect([...changed.keys()]).toStrictEqual(["app.json"]);
    expect(
      (JSON.parse(changed.get("app.json")!) as { description?: string })
        .description
    ).toBeUndefined();
  });

  it("rejects an empty name and a duplicate display name", () => {
    expect(() => updateAppMetaFiles(base(), "todos", { name: "  " })).toThrow(
      /cannot be empty/u
    );
    expect(() =>
      updateAppMetaFiles(base(), "todos", { name: "Other" }, [
        { id: "x", name: "other" },
      ])
    ).toThrow(/already exists/u);
  });

  it("allows renaming to the apps own current name (self excluded)", () => {
    const changed = updateAppMetaFiles(base(), "todos", { name: "Todos" }, [
      { id: "todos", name: "Todos" },
    ]);
    expect(changed.some((f) => f.path === "app.json")).toBeTruthy();
  });
});
