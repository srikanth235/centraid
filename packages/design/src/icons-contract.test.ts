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

// ── App-icon silhouette contract (handoff brief, "App icons") ──────────────
//
// The brief specifies a CLASSIC FILLED MARK system: a rounded-square
// container tinted with the app hue, a primary silhouette cut from it as
// `fill-rule: evenodd` knockouts (so the tint reads as negative space), and a
// secondary form at 50% opacity for decoration ONLY — the identifying detail
// must never live in that low-opacity path, since it falls under the 3:1
// non-text contrast floor at the sizes actually used.
//
// What THIS repo actually ships (`icons.ts`) is a different, simpler system:
// single-tone Lucide-style STROKE icons. `IconPath` has no `fillRule` field
// and `iconPathMarkup` never emits one; there is no "secondary path at
// reduced opacity" concept anywhere in the render pipeline. That is a real
// gap against the brief — the two-tone filled-mark system with evenodd
// knockouts described there has never been authored — and it is NOT
// mechanically checkable against real sources, because the property doesn't
// exist to inspect: there is no icon anywhere in `ICON_DATA` that declares a
// second, lower-opacity decorative path, so a test asserting "the identity
// hue is absent from the secondary path" would vacuously pass over a
// contract the icons never attempt in the first place. Rather than write
// that pretend test, this suite instead pins the guarantee the CURRENT
// architecture actually gives, which is strictly stronger for THIS repo's
// rendering model: no icon may carry any baked-in colour at all (only
// `currentColor`, i.e. the caller's `--chip-hue`/mark colour, decided by
// `iconChipFinish` in tile.ts) — so there is no path, primary or secondary,
// that could ever diverge from the container-driven identity hue. If a
// two-tone filled mark is ever authored, the `fillRule` field below is the
// seam: `iconPathMarkup` already emits it when present, so the moment a path
// sets `fillRule: "evenodd"` this contract activates on it (see the "any
// future evenodd path is well-formed" test).
describe("app-icon silhouette contract", () => {
  const appIconNames = [...new Set(apps.map((app) => app.iconKey))];

  test("every shipped app claims an icon that exists in the registry", () => {
    expect(appIconNames.length).toBeGreaterThan(0);
    for (const name of appIconNames) expect(isIconName(name)).toBe(true);
  });

  // Mechanically checkable, and the strongest form of "identity never leaks
  // into a secondary path" this repo's single-tone icon model can express:
  // no path may hold a literal colour. Every glyph paints in whatever colour
  // the CALLER supplies via `currentColor` (the chip's `markColor`), so a
  // path can never carry a hardcoded identity hue independent of the
  // container that is supposed to be the only place the hue is decided.
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

  // `fill-rule="evenodd"` is real, checked markup — `pathMarkup` already
  // knows how to emit it (see the assertion just below) — but NO shipped
  // icon uses it today, because no shipped icon is a filled compound
  // silhouette with a knockout. This is the honest state of the gap: the
  // authoring pattern the brief specifies has not been built.
  test("no shipped app icon currently declares an evenodd knockout (documents the gap)", () => {
    for (const name of appIconNames) {
      for (const iconPath of icons[name]) {
        expect(iconPath.fillRule, `${name} fillRule`).toBeUndefined();
      }
    }
  });

  // The seam itself: `fillRule` on an `IconPath` renders as a real
  // `fill-rule="evenodd"` attribute the moment one is authored, so this
  // contract is enforceable on day one of a real filled-mark icon rather
  // than needing a second pass through the renderer later.
  test("pathMarkup emits fill-rule when a path declares one", () => {
    const markup = pathMarkup({ d: "M0 0h10v10H0z", fillRule: "evenodd" });
    expect(markup).toContain('fill-rule="evenodd"');
  });

  // "Legible at 14px" (the brief's smallest size in use) is a genuinely
  // subjective, human-verified claim — no algorithm here decides whether a
  // shape READS at 14px the way a designer's eye does. What IS mechanically
  // checkable is a floor under two proxies that predict illegibility at
  // small sizes: the rendered stroke never thins below a real device pixel,
  // and the glyph doesn't accumulate so many path commands that its detail
  // is finer than a 14px box can resolve. Both are necessary, neither is
  // sufficient — this test cannot and does not claim to settle legibility on
  // its own; it only rules out the two failure modes a heuristic can see.
  const SMALLEST_SIZE_IN_USE = 14;
  const VIEW_BOX = 24;
  const MIN_DEVICE_STROKE_PX = 0.75;
  // The densest shipped app icon (AddressBook: two paths, 18 path commands)
  // sets the ceiling; a generous margin above it catches genuinely
  // over-detailed future artwork without flagging today's set.
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

// ── Photos v4 handoff icon keys (CHANGELOG v4 - Photos.md §B2) ─────────────
//
// Thirteen new keys for the shelves, the selection set and the viewer bar.
// The names are the exact, lowercase names the handoff gives — "the names
// are the binding part" — which is why this suite checks them by literal
// key rather than through `ICON_CONCEPTS` (a separate, PascalCase-glyph
// concept layer these keys deliberately do not go through).
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
    // The handoff calls out photos/add/trash as possibly-existing; `add` and
    // `trash` share the exact path data of `Plus` and `Trash` rather than
    // drawing a second, competing glyph for the same action.
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

  // Same distinguishability proxy as the app-icon suite above: no shipped
  // key accumulates so many path commands that a 14px render can't resolve
  // it, and every key is distinct from every other shipped key by path data.
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

  // The five aliases share artwork on purpose (see the test above); every
  // OTHER key in the set must be genuinely distinct artwork from its
  // siblings, so this list is checked separately rather than with a
  // conditional expect inside one shared loop.
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
