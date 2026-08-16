/**
 * Matrix cell blueprints.durability (#535 coverable-today).
 * Meta updates must preserve identity fields across rewrites.
 */
import { describe, expect, it } from "vitest";

import { updateAppMetaFiles } from "./app-meta.js";
import type { ScaffoldFile } from "./scaffold-types.js";

function appFiles(
  id: string,
  name: string,
  description?: string
): ScaffoldFile[] {
  return [
    {
      path: "app.json",
      content:
        JSON.stringify(
          {
            manifestVersion: 1,
            id,
            name,
            version: "0.1.0",
            ...(description === undefined ? {} : { description }),
          },
          null,
          2
        ) + "\n",
    },
    {
      path: "automations/digest/automation.json",
      content: JSON.stringify({ name }, null, 2) + "\n",
    },
  ];
}

describe("blueprint app-meta durability", () => {
  it("updateAppMetaFiles preserves app id while changing display name", () => {
    const original = appFiles("durable-app", "Original", "keep me");
    const changed = updateAppMetaFiles(original, "durable-app", {
      name: "Renamed",
    });
    const appJson = JSON.parse(
      changed.find((f) => f.path === "app.json")!.content
    ) as {
      id?: string;
      name: string;
      description?: string;
    };
    expect(appJson.id).toBe("durable-app");
    expect(appJson.name).toBe("Renamed");
    expect(appJson.description).toBe("keep me");
    const manifest = changed.find(
      (f) => f.path === "automations/digest/automation.json"
    );
    expect(manifest).toBeDefined();
    expect((JSON.parse(manifest!.content) as { name: string }).name).toBe(
      "Renamed"
    );
    // Original file map still has the old name (pure function, no mutation).
    const originalApp = JSON.parse(
      original.find((f) => f.path === "app.json")!.content
    ) as {
      name: string;
    };
    expect(originalApp.name).toBe("Original");
  });

  it("updateAppMetaFiles does not mutate the input file map", () => {
    const original = appFiles("keep-files", "Keep", "before");
    const before = original.map((f) => ({ ...f }));
    updateAppMetaFiles(original, "keep-files", { description: "after" });
    expect(original).toStrictEqual(before);
  });
});
