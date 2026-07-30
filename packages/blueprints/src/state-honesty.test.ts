import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const appsRoot = path.resolve(import.meta.dirname, "../apps");

const read = (relative: string): string =>
  readFileSync(path.resolve(appsRoot, relative), "utf8");

describe("blueprint state honesty", () => {
  test.each(["agenda", "locker", "notes", "people", "tasks"])(
    "%s paints a skeleton until its first read settles",
    (app) => {
      expect(read(`${app}/Chrome.tsx`)).toContain("LoadingSkeleton");
      expect(read(`${app}/app-root.tsx`)).toMatch(/loading=\{!.*loaded\}/u);
    }
  );

  test.each([
    "agenda",
    "locker",
    "notes",
    "people",
    "tasks",
    "docs",
    "tally",
    "photos",
  ])("%s gives denied reads a direct vault-access action", (app) => {
    expect(read(`${app}/Chrome.tsx`)).toContain("VaultAccessButton");
  });

  test.each([
    ["agenda", "agenda/components/ScheduleView.tsx"],
    ["locker", "locker/components/List.tsx"],
    ["notes", "notes/components/Wall.tsx"],
    ["people", "people/app-root.tsx"],
    ["tasks", "tasks/components/Board.tsx"],
    ["docs", "docs/app-root.tsx"],
    ["tally", "tally/components/Ledger.tsx"],
    ["photos", "photos/Chrome.tsx"],
  ])("%s primary empty state uses kit vocabulary with a CTA", (_app, file) => {
    const source = read(file);
    expect(source).toContain("kit-empty");
    expect(source).toContain("kit-btn");
  });
});
