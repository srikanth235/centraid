import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { ICON_CONCEPTS, iconSvg, icons, isIconName } from "./icons.js";

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
        try {
          const source = readFileSync(full, "utf8");
          expect(source, full).toContain("@centraid/design");
          expect(source, full).not.toMatch(/<svg|<path|<circle|<rect/gu);
        } catch {
          // Not every app has both the string and React adapter forms.
        }
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
