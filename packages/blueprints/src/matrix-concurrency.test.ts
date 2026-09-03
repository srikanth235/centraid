import { describe, expect, it } from "vitest";

import { cloneTemplateFiles } from "./clone.js";
import type { ScaffoldFile } from "./scaffold-types.js";

const TEMPLATE: ScaffoldFile[] = [
  {
    path: "app.json",
    content:
      JSON.stringify(
        { manifestVersion: 1, id: "source", name: "Source" },
        null,
        2
      ) + "\n",
  },
];

describe("blueprint clone concurrency", () => {
  it("parallel cloneTemplateFiles calls return independent file maps", () => {
    const maps = Array.from({ length: 24 }, (_, i) =>
      cloneTemplateFiles({
        newAppId: `app-${i}`,
        newName: `App ${i}`,
        templateFiles: TEMPLATE,
      })
    );
    expect(maps).toHaveLength(24);
    for (let i = 0; i < maps.length; i += 1) {
      const appJson = JSON.parse(
        maps[i]!.find((f) => f.path === "app.json")!.content
      ) as {
        id: string;
        name: string;
      };
      expect(appJson.id).toBe(`app-${i}`);
      expect(appJson.name).toBe(`App ${i}`);
    }
    maps[0]![0]!.content = "MUTATED";
    for (let i = 1; i < maps.length; i += 1) {
      expect(maps[i]![0]!.content).not.toBe("MUTATED");
      const appJson = JSON.parse(
        maps[i]!.find((f) => f.path === "app.json")!.content
      ) as {
        id: string;
      };
      expect(appJson.id).toBe(`app-${i}`);
    }
    expect(TEMPLATE[0]!.content).toContain('"id": "source"');
  });
});
