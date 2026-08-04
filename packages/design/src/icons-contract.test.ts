import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  ICON_CONCEPTS,
  iconForConcept,
  iconSvg,
  icons,
  isIconName,
} from "./icons.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function json<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(ROOT, file), "utf8")) as T;
}

describe("single icon registry", () => {
  test("blueprint adapters contain no local SVG dictionaries", () => {
    const appRoot = path.join(ROOT, "packages/blueprints/apps");
    for (const app of readdirSync(appRoot)) {
      const dir = path.join(appRoot, app);
      for (const file of ["icons.ts", "icons.tsx"]) {
        const full = path.join(dir, file);
        if (!existsSync(full)) continue;
        const source = readFileSync(full, "utf8");
        expect(source, full).toContain("@centraid/design");
        expect(source, full).not.toMatch(/<svg|<path|<circle|<rect/gu);
      }
    }
  });

  test("standalone kit routes icons through its browser adapter", () => {
    const kit = readFileSync(
      path.join(ROOT, "packages/design/kit/kit.ts"),
      "utf8"
    );
    expect(kit).toContain("kitIcon");
    expect(kit).not.toContain("<svg");
  });

  test("all shipped catalogs resolve through the shared registry", () => {
    const files = [
      "packages/blueprints/index.json",
      "packages/blueprints/manifest.json",
      ...walkJsonFiles(path.join(ROOT, "packages/blueprints")),
    ];
    const keys: string[] = [];
    for (const file of files) collectIconKeys(json<unknown>(file), keys);
    expect(
      keys.length,
      "catalogs should contain iconKey entries"
    ).toBeGreaterThan(0);
    for (const iconKey of keys) {
      expect(isIconName(iconKey), iconKey).toBe(true);
    }
  });

  test("concept aliases and SVG lowering use the same stroke contract", () => {
    for (const name of Object.values(ICON_CONCEPTS)) {
      expect(isIconName(name)).toBe(true);
      expect(iconSvg(name)).toContain('stroke-width="1.5"');
    }
    expect(Object.keys(icons).length).toBeGreaterThan(40);
  });

  test("the standalone kit dictionary mirrors the shared path data", () => {
    const kit = readFileSync(
      path.join(ROOT, "packages/design/kit/icons.js"),
      "utf8"
    );
    const mirrored = {
      ChevronDown: ["M6 9l6 6 6-6"],
      History: ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5M12 7v5l3 2"],
      Paperclip: [
        "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48",
      ],
    } as const;
    for (const [name, paths] of Object.entries(mirrored)) {
      expect(kit, name).toContain(`${name}:`);
      for (const pathData of paths)
        expect(kit, `${name}:${pathData}`).toContain(pathData);
      expect(
        icons[name as keyof typeof icons].map((segment) => segment.d)
      ).toStrictEqual(paths);
    }
  });

  test("the navigation concepts keep distinct directional semantics", () => {
    expect(ICON_CONCEPTS.leave).toBe("Grid");
    expect(ICON_CONCEPTS.up).toBe("ChevronLeft");
    expect(iconForConcept("leave")).toBe("Grid");
    expect(isIconName("toString")).toBe(false);
    expect(isIconName("not-a-real-icon")).toBe(false);
  });
});

function walkJsonFiles(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) walkJsonFiles(full, out);
    else if (entry === "app.json") out.push(path.relative(ROOT, full));
  }
  return out;
}

function collectIconKeys(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const child of value) collectIconKeys(child, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.iconKey === "string") out.push(record.iconKey);
  for (const child of Object.values(record)) collectIconKeys(child, out);
}
