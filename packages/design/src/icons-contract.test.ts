import { readFileSync, readdirSync, statSync } from "node:fs";
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

// ── WHO CONSUMES THE REGISTRY, AND HOW THAT MOVED ─────────────────────────
//
// Until #1029 the two tests below scanned `packages/blueprints` — the app
// adapters and their `app.json` catalogues were the surfaces that could fork
// the icon set or name a key it did not hold. That tree was deleted with the
// rest of v0, and both tests then died on `ENOENT` inside `readdirSync` before
// asserting anything. An icon contract that scans nothing is worse than no
// icon contract: it reports two green cases per run for a guarantee nobody is
// making any more.
//
// The consumers now are the two native shells, and they reach the registry
// through ONE emitted artifact each: `contracts/tools/export-native-catalog.ts`
// lowers `icons` into `design/native-catalog.json`, `Catalog.kt` and
// `Catalog.swift`. So the same two questions re-point, and both still have
// teeth here:
//
//   1. does anything OUTSIDE that emitted pair carry silhouette path data?
//   2. does every icon key a shipped artifact or a shell names RESOLVE?
//
// Question 2 is the one with a real failure mode behind it. `Icon.swift` reads
// `CentraidCatalog.icons[iconKey] ?? []` and `Icon.kt` reads
// `.icons[iconKey].orEmpty()`, so a misspelled key draws NOTHING and nothing
// throws — the silent blank mark `CatalogSpec` was written after. That spec and
// `IconSilhouetteTests` cover the keys the Kotlin POLICIES name; this file
// covers the string literals typed into the view layer and the emitted table
// itself, neither of which needs a JVM or an Xcode toolchain to read.

/** The hand-written shell sources, plus the two emitted catalogue files that
 *  live among them. `iosApp/Sources/Generated` holds protobuf output and is
 *  walked like anything else — it is generated, but it is not the icon
 *  lowering, so it may not carry path data either. */
const SHELL_ROOTS = [
  "mobile/iosApp/Sources",
  "mobile/iosApp/Design",
  "mobile/androidApp/src",
  "mobile/shared/src/commonMain",
];

/** The ONLY two files permitted to carry silhouette path data, and both are
 *  generated. Hand-editing either is caught elsewhere — the gate's `emitters`
 *  step and the `mobile-jvm` profile both regenerate and fail on a diff. */
const EMITTED_CATALOGUES = new Set([
  "mobile/iosApp/Design/Catalog.swift",
  "mobile/shared/src/commonMain/kotlin/dev/centraid/design/Catalog.kt",
]);

const SHELL_EXTENSIONS = [".swift", ".kt"];

function walkShellSources(): string[] {
  const out: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (SHELL_EXTENSIONS.some((suffix) => entry.endsWith(suffix)))
        out.push(path.relative(ROOT, full));
    }
  };
  for (const root of SHELL_ROOTS) walk(path.join(ROOT, root));
  return out;
}

describe("single icon registry", () => {
  test("no shell source outside the emitted catalogue carries path data", () => {
    // A `"M…"` string literal in a 24-box is what a silhouette IS, so a view
    // that holds one is holding artwork the registry cannot revise — the
    // native form of the local SVG dictionary this case has always forbidden.
    const pathData = /"M-?[\d.]+[\s,]/u;
    const sources = walkShellSources();
    expect(
      sources.length,
      "the shell trees produced no sources"
    ).toBeGreaterThan(0);
    const offenders = sources.filter(
      (file) =>
        !EMITTED_CATALOGUES.has(file) &&
        pathData.test(readFileSync(path.join(ROOT, file), "utf8"))
    );
    expect(
      offenders,
      "SVG path data outside Catalog.kt/Catalog.swift"
    ).toStrictEqual([]);
  });

  test("the element layer hand-rolls no icon markup", () => {
    const elements = path.join(ROOT, "packages/design/src/elements");
    for (const file of readdirSync(elements)) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(path.join(elements, file), "utf8");
      expect(source, file).not.toContain("<svg");
    }
  });

  test("the emitted native catalogue is this registry, not a second one", () => {
    // `design/native-catalog.json` is COMMITTED, so it can go stale against the
    // registry it was lowered from. The drift gate that catches that lives in
    // `cargo xtask gate` (`emitters`, and the `mobile-jvm` profile), which is
    // neither cheap nor run on a TypeScript-only change — and the emitted table
    // is what both shells actually draw.
    const catalogue = json<{
      apps: { id: string; iconKey: string }[];
      icons: Record<string, unknown[]>;
    }>("design/native-catalog.json");
    expect(Object.keys(catalogue.icons).sort()).toStrictEqual(
      Object.keys(icons).sort()
    );
    expect(catalogue.apps.map((app) => app.id)).toStrictEqual(
      apps.map((app) => app.id)
    );
    for (const app of catalogue.apps) {
      expect(isIconName(app.iconKey), `${app.id} → ${app.iconKey}`).toBe(true);
    }
  });

  test("every icon key a shell names by literal resolves", () => {
    // `Icon.swift` and `Icon.kt` both fall back to an EMPTY path list, so a key
    // the table does not hold renders a blank chip and nothing fails. These are
    // the keys typed into the views rather than declared in a Kotlin policy —
    // the half `CatalogSpec` cannot enumerate.
    const literal = /iconKey\s*[:=]\s*"(?<key>[^"]+)"/gu;
    const named = new Map<string, string>();
    for (const file of walkShellSources()) {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      for (const match of source.matchAll(literal)) {
        const key = match.groups?.key ?? "";
        if (!named.has(key)) named.set(key, file);
      }
    }
    expect(named.size, "no shell source names an icon key").toBeGreaterThan(0);
    for (const [key, file] of named) {
      expect(isIconName(key), `${file} names icon '${key}'`).toBe(true);
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
// The brief's two-tone filled mark — evenodd knockouts plus a 50%-opacity
// decorative path — is not what this repo ships: icons are single-tone strokes,
// so a test for "identity absent from the secondary path" would pass vacuously.
// This suite pins the stronger guarantee the current model does give: no path
// carries baked-in colour, only `currentColor`. `fillRule` is the seam —
// `pathMarkup` already emits it, so the contract activates the day a filled
// mark is authored.
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

  // Legibility at 14px is human-verified; these two proxies only rule out the
  // failure modes a heuristic can see. Necessary, never sufficient.
  const SMALLEST_SIZE_IN_USE = 14;
  const VIEW_BOX = 24;
  const MIN_DEVICE_STROKE_PX = 0.75;
  // Margin above the densest shipped icon (AddressBook, 18 commands).
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
// The lowercase names are the binding part, so these are checked by literal key
// and deliberately never through the PascalCase `ICON_CONCEPTS` layer.
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
    // Aliases share exact path data rather than drawing a competing glyph.
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

  // Shared artwork on purpose; every other key must be distinct.
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
