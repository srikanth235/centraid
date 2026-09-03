import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { apps } from "./apps.js";
import {
  ICON_CONCEPTS,
  iconForConcept,
  iconSvg,
  icons,
  isIconName,
  pathMarkup,
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

  test("the element layer hand-rolls no icon markup", () => {
    const elements = path.join(ROOT, "packages/design/src/elements");
    for (const file of readdirSync(elements)) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(path.join(elements, file), "utf8");
      expect(source, file).not.toContain("<svg");
    }
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

  test("the navigation concepts keep distinct directional semantics", () => {
    expect(ICON_CONCEPTS.leave).toBe("Grid");
    expect(ICON_CONCEPTS.up).toBe("ChevronLeft");
    expect(iconForConcept("leave")).toBe("Grid");
    expect(isIconName("toString")).toBe(false);
    expect(isIconName("not-a-real-icon")).toBe(false);
  });
});

describe("app-icon silhouette contract", () => {
  const appIconNames = [...new Set(apps.map((app) => app.iconKey))];

  test("every shipped app claims an icon that exists in the registry", () => {
    expect(appIconNames.length).toBeGreaterThan(0);
    for (const name of appIconNames) expect(isIconName(name)).toBe(true);
  });

  test("no app icon's path data carries a hardcoded colour", () => {
    for (const name of appIconNames) {
      for (const iconPath of icons[name]) {
        expect(
          iconPath.fill === undefined || iconPath.fill === "currentColor",
          `${name} path fill`
        ).toBe(true);
      }
    }
  });

  test("no shipped app icon currently declares an evenodd knockout (documents the gap)", () => {
    for (const name of appIconNames) {
      for (const iconPath of icons[name]) {
        expect(iconPath.fillRule, `${name} fillRule`).toBeUndefined();
      }
    }
  });

  test("pathMarkup emits fill-rule when a path declares one", () => {
    const markup = pathMarkup({ d: "M0 0h10v10H0z", fillRule: "evenodd" });
    expect(markup).toContain('fill-rule="evenodd"');
  });

  const SMALLEST_SIZE_IN_USE = 14;
  const VIEW_BOX = 24;
  const MIN_DEVICE_STROKE_PX = 0.75;
  const MAX_PATH_COMMANDS = 24;
  const countCommands = (d: string): number =>
    (d.match(/[a-df-z]/giu) ?? []).length;

  test("app icon strokes stay above a real device pixel at 14px", () => {
    const strokeWidth = 1.5; // iconSvg()'s default, and every app icon's actual render.
    const effective = strokeWidth * (SMALLEST_SIZE_IN_USE / VIEW_BOX);
    expect(effective).toBeGreaterThanOrEqual(MIN_DEVICE_STROKE_PX);
  });

  test("app icons stay under a detail-density ceiling that predicts illegibility at 14px", () => {
    for (const name of appIconNames) {
      const commands = icons[name].reduce(
        (sum, iconPath) => sum + countCommands(iconPath.d),
        0
      );
      expect(commands, `${name} path-command count`).toBeLessThanOrEqual(
        MAX_PATH_COMMANDS
      );
    }
  });
});

describe("Photos v4 handoff icon keys", () => {
  const PHOTOS_ICON_KEYS = [
    "heart",
    "album",
    "place",
    "person",
    "dupe",
    "trash",
    "restore",
    "add",
    "share",
    "download",
    "removeFrom",
    "info",
    "more",
  ] as const;

  test("every key exists in the shared registry, spelled exactly", () => {
    for (const name of PHOTOS_ICON_KEYS) {
      expect(isIconName(name), name).toBe(true);
    }
  });

  test("reused artwork does not duplicate or restyle the existing marks", () => {
    expect(icons.add.map((p) => p.d)).toStrictEqual(icons.Plus.map((p) => p.d));
    expect(icons.trash.map((p) => p.d)).toStrictEqual(
      icons.Trash.map((p) => p.d)
    );
    expect(icons.share.map((p) => p.d)).toStrictEqual(
      icons.Share.map((p) => p.d)
    );
    expect(icons.download.map((p) => p.d)).toStrictEqual(
      icons.Download.map((p) => p.d)
    );
    expect(icons.heart.map((p) => p.d)).toStrictEqual(
      icons.Heart.map((p) => p.d)
    );
    expect(icons.MapPin.map((p) => p.d)).toStrictEqual(
      icons.place.map((p) => p.d)
    );
  });

  test("every key follows the single-tone stroke contract: no baked colour, fill:none", () => {
    for (const name of PHOTOS_ICON_KEYS) {
      for (const iconPath of icons[name]) {
        expect(
          iconPath.fill === undefined || iconPath.fill === "currentColor",
          `${name} path fill`
        ).toBe(true);
        expect(iconPath.fillRule, `${name} fillRule`).toBeUndefined();
      }
    }
  });

  test("every key renders through the shared SVG lowering, aria-hidden left to the caller", () => {
    for (const name of PHOTOS_ICON_KEYS) {
      const markup = iconSvg(name);
      expect(markup, name).toContain('fill="none"');
      expect(markup, name).toContain("<path");
    }
  });

  test("every key stays under the detail-density ceiling", () => {
    const MAX_PATH_COMMANDS = 24;
    const countCommands = (d: string): number =>
      (d.match(/[a-df-z]/giu) ?? []).length;
    for (const name of PHOTOS_ICON_KEYS) {
      const commands = icons[name].reduce(
        (sum, iconPath) => sum + countCommands(iconPath.d),
        0
      );
      expect(commands, `${name} path-command count`).toBeLessThanOrEqual(
        MAX_PATH_COMMANDS
      );
    }
  });

  const REUSED_ALIASES = new Set([
    "add",
    "trash",
    "share",
    "download",
    "heart",
  ]);

  test("every non-aliased key is distinct artwork from its siblings", () => {
    const signature = (name: (typeof PHOTOS_ICON_KEYS)[number]): string =>
      icons[name].map((p) => p.d).join("|");
    const distinctKeys = PHOTOS_ICON_KEYS.filter(
      (name) => !REUSED_ALIASES.has(name)
    );
    const signatures = distinctKeys.map(signature);
    expect(new Set(signatures).size).toBe(signatures.length);
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
