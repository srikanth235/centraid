// THE APP CATALOGUE AND THE ICON SILHOUETTES, LOWERED NATIVELY
// (#1020, wave A; the same road as `export-native-theme.ts`).
//
// Home's tile header is an INVARIANT — icon chip, name, count, in that order —
// and it is what makes eight unlike bodies read as one grid
// (v0 `apps/mobile/src/screens/home/LauncherGrid.tsx:1-4`). Three of those four
// things are design data that lived only in TypeScript: the app's display name,
// its slot on the identity hue ring, and the shared single-tone icon stroke.
//
// A hand-written Kotlin copy of that table would be exactly the fourth lowering
// with no drift gate that `export-native-theme.ts` exists to prevent, so it is
// emitted here instead, from the same `packages/design` the CSS and the native
// theme come from, and gated by the same `git diff --exit-code` line:
//
//   bun contracts/tools/export-native-theme.ts   (calls this emitter)
//   bun run format
//   git diff --exit-code design copy mobile
//
// WHAT CROSSES, AND WHY IT IS NOT A DECISION.
//
//  * `apps` — id, name, desc, icon key, hue key. Verbatim.
//  * The ICON CHIP's two resolved colours per app per scheme. `iconChipFinish`
//    composites the hue over the page at 13% (light) / 20% (dark) and solves
//    the mark's own text rung; RN has no `color-mix()` and neither do Compose
//    or SwiftUI, so v0 already computed this in TypeScript. Computing it twice
//    natively would be two implementations of one blend, so the ANSWER crosses
//    rather than the arithmetic. The surface is `bg`, which is the surface
//    `AppMark` passes at every call site.
//  * The icon PATH DATA, viewBox 24, verbatim. Compose parses SVG path data
//    with `PathParser`; the iOS side has one parser beside the renderer.
//  * The geometry constants both shells need and the theme table does not
//    carry: the hairline, the phone's page margin, the two durations, the app
//    mark's stroke rule and the chip's radius ratio.
//
// Nothing here is a colour ROLE, so `NATIVE_COLOR_ROLES` and its contract test
// are untouched: these are resolved identity values, not theme slots.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  APP_MARK_SMALL_STROKE,
  APP_MARK_STROKE,
  APP_MARK_VIEWBOX,
  ICON_CHIP_RADIUS_RATIO,
  ICON_CHIP_TINT,
  apps,
  borders,
  iconChipFinish,
  icons,
  toNativeTheme,
} from "../../packages/design/src/index.ts";
import type { IconName, IconPath } from "../../packages/design/src/icons.ts";
import type { NativeScheme } from "../../packages/design/src/native.ts";

const SCHEMES: readonly NativeScheme[] = ["light", "dark"];

interface Channels {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Hex only. Every value this emitter lowers is already an opaque hex — the
 *  `rgba()` entries live in the theme table, whose own emitter parses them. */
function parseHex(value: string): Channels {
  const hex = value.trim().replace("#", "");
  const wide =
    hex.length === 3
      ? hex
          .split("")
          .map((char) => char + char)
          .join("")
      : hex;
  if (!/^[0-9a-fA-F]{6}$/u.test(wide))
    throw new Error(
      `export-native-catalog: '${value}' is not an opaque hex colour. ` +
        `Identity values are resolved by packages/design before they reach ` +
        `this emitter; a function or a var() here means the lowering changed.`
    );
  return {
    a: 255,
    b: Number.parseInt(wide.slice(4, 6), 16),
    g: Number.parseInt(wide.slice(2, 4), 16),
    r: Number.parseInt(wide.slice(0, 2), 16),
  };
}

const kotlinColor = (value: string): string => {
  const { a, b, g, r } = parseHex(value);
  const hex = [a, r, g, b]
    .map((channel) => channel.toString(16).padStart(2, "0").toUpperCase())
    .join("");
  return `0x${hex}L`;
};

const swiftColor = (value: string): string => {
  const { a, b, g, r } = parseHex(value);
  const channel = (n: number): string => (n / 255).toFixed(6);
  return (
    `Color(.sRGB, red: ${channel(r)}, green: ${channel(g)}, ` +
    `blue: ${channel(b)}, opacity: ${channel(a)})`
  );
};

const quote = (value: string): string =>
  `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;

interface Mark {
  chipBackground: string;
  hue: string;
  markColor: string;
}

function marksFor(scheme: NativeScheme): Record<string, Mark> {
  const theme = toNativeTheme(scheme);
  const surface = theme.colors.bg;
  const ring = Object.fromEntries(
    Object.entries(theme.colors)
      .filter(([role]) => role.startsWith("c") && role.length > 1)
      .map(([role, value]) => [
        `${role.slice(1, 2).toLowerCase()}${role.slice(2)}`,
        String(value),
      ])
  );
  return Object.fromEntries(
    apps.map((app) => {
      // The scheme's own ring, never the light hex baked into `app.color`:
      // `apps.ts` resolves `palette` (light) at module load, and a dark phone
      // draws the dark ring.
      const hue = ring[app.colorKey] ?? app.color;
      const finish = iconChipFinish(hue, surface, scheme);
      return [
        app.id,
        {
          chipBackground: finish.backgroundColor,
          hue,
          markColor: finish.markColor,
        },
      ];
    })
  );
}

const ICON_NAMES: readonly IconName[] = Object.keys(icons).sort() as IconName[];

const header = (language: "kotlin" | "swift"): string =>
  [
    `// GENERATED by contracts/tools/export-native-catalog.ts. Do not edit.`,
    `//`,
    `// The app catalogue, the resolved identity marks and the shared icon`,
    `// silhouettes, lowered from packages/design (#1020, wave A). A hand-edited`,
    `// copy of this table is a lowering with no drift gate, which is what`,
    `// \`git diff --exit-code design copy mobile\` in the mobile-jvm gate step`,
    `// exists to prevent.`,
    language === "kotlin" ? `` : ``,
  ].join("\n");

const geometry = (scheme: NativeScheme = "light"): Record<string, number> => {
  const theme = toNativeTheme(scheme);
  return {
    appMarkSmallStroke: APP_MARK_SMALL_STROKE,
    appMarkStroke: APP_MARK_STROKE,
    appMarkViewBox: APP_MARK_VIEWBOX,
    durationOne: theme.durations.one,
    durationTwo: theme.durations.two,
    hairline: borders.hairline,
    iconChipRadiusRatio: ICON_CHIP_RADIUS_RATIO,
    iconChipTintDark: ICON_CHIP_TINT.dark,
    iconChipTintLight: ICON_CHIP_TINT.light,
    pageMargin: theme.pageMargin,
    targetMinCoarse: theme.targetMin.coarse,
    targetMinFine: theme.targetMin.fine,
  };
};

function kotlinIcons(): string[] {
  const lines: string[] = [
    "    /**",
    "     * Lucide-style silhouettes as raw SVG path data, viewBox 24x24.",
    "     *",
    "     * ONE ordered list per icon, drawn in order. Compose reads these with",
    "     * `PathParser`, which speaks SVG path data directly; the iOS side has",
    "     * its own parser beside its renderer. Neither shell ships a second",
    "     * icon set, because two silhouettes for one concept is two products.",
    "     */",
    "    public val icons: Map<String, List<NativeIconPath>> = mapOf(",
  ];
  for (const name of ICON_NAMES) {
    const paths = icons[name] as readonly IconPath[];
    lines.push(`        ${quote(name)} to listOf(`);
    for (const entry of paths) {
      lines.push(
        `            NativeIconPath(` +
          `d = ${quote(entry.d)}, ` +
          `filled = ${entry.fill === "currentColor"}, ` +
          `evenOdd = ${entry.fillRule === "evenodd"}),`
      );
    }
    lines.push(`        ),`);
  }
  lines.push("    )");
  return lines;
}

function swiftIcons(): string[] {
  const lines: string[] = [
    "    /// Lucide-style silhouettes as raw SVG path data, viewBox 24x24.",
    "    ///",
    "    /// ONE ordered list per icon, drawn in order. See the Kotlin table:",
    "    /// neither shell ships a second icon set.",
    "    public static let icons: [String: [CentraidIconPath]] = [",
  ];
  for (const name of ICON_NAMES) {
    const paths = icons[name] as readonly IconPath[];
    lines.push(`        ${quote(name)}: [`);
    for (const entry of paths) {
      lines.push(
        `            CentraidIconPath(` +
          `d: ${quote(entry.d)}, ` +
          `filled: ${entry.fill === "currentColor"}, ` +
          `evenOdd: ${entry.fillRule === "evenodd"}),`
      );
    }
    lines.push(`        ],`);
  }
  lines.push("    ]");
  return lines;
}

export function emitNativeCatalog(repositoryRoot: string): {
  apps: number;
  icons: number;
  paths: number;
} {
  const marks = Object.fromEntries(
    SCHEMES.map((scheme) => [scheme, marksFor(scheme)])
  ) as Record<NativeScheme, Record<string, Mark>>;
  const constants = geometry();

  // --- the JSON, for a reader and for the drift gate ----------------------

  mkdirSync(path.join(repositoryRoot, "design"), { recursive: true });
  writeFileSync(
    path.join(repositoryRoot, "design/native-catalog.json"),
    `${JSON.stringify(
      {
        $generatedBy: "contracts/tools/export-native-catalog.ts",
        $note:
          "The app catalogue, the identity marks resolved over --bg per " +
          "scheme, and the shared icon path data. Lowered from " +
          "packages/design for the Kotlin and Swift shells.",
        apps: apps.map((app) => ({
          colorKey: app.colorKey,
          desc: app.desc,
          iconKey: app.iconKey,
          id: app.id,
          name: app.name,
        })),
        geometry: constants,
        icons: Object.fromEntries(
          ICON_NAMES.map((name) => [name, icons[name]])
        ),
        marks,
      },
      undefined,
      2
    )}\n`
  );

  // --- the Kotlin table ---------------------------------------------------

  const kotlin: string[] = [
    header("kotlin"),
    "package dev.centraid.design",
    "",
    "/** One first-party app's launcher identity. */",
    "public data class NativeApp(",
    "    public val id: String,",
    "    public val name: String,",
    "    public val desc: String,",
    "    public val iconKey: String,",
    "    public val colorKey: String,",
    ")",
    "",
    "/**",
    " * An app's icon chip, already composited.",
    " *",
    " * `chipBackground` is [hue] over the page at the scheme's tint share and",
    " * `markColor` is the hue's solved text rung — both computed by",
    " * `packages/design`'s `iconChipFinish`, because a blend computed twice is",
    " * two blends. The chip is the ONLY place an app's hue appears on Home: the",
    " * springboard itself takes no identity hue.",
    " */",
    "public data class NativeAppMark(",
    "    public val hue: Long,",
    "    public val chipBackground: Long,",
    "    public val markColor: Long,",
    ")",
    "",
    "/** One `<path>` of a silhouette: SVG path data in a 24x24 viewBox. */",
    "public data class NativeIconPath(",
    "    public val d: String,",
    "    /** Filled with the mark colour rather than stroked. */",
    "    public val filled: Boolean,",
    "    /** The knockout rule the silhouette contract specifies. */",
    "    public val evenOdd: Boolean,",
    ")",
    "",
    "public object CentraidCatalog {",
    "    /**",
    "     * The eight first-party apps, in CATALOGUE order.",
    "     *",
    "     * This is the all-apps listing's order and says nothing about the grid",
    "     * — `SpringboardPolicy.SPRINGBOARD_ORDER` owns that.",
    "     */",
    "    public val apps: List<NativeApp> = listOf(",
    ...apps.map(
      (app) =>
        `        NativeApp(id = ${quote(app.id)}, name = ${quote(app.name)}, ` +
        `desc = ${quote(app.desc)}, iconKey = ${quote(app.iconKey)}, ` +
        `colorKey = ${quote(app.colorKey)}),`
    ),
    "    )",
    "",
    "    /** By id, for the header that names one app. */",
    "    public val byId: Map<String, NativeApp> = apps.associateBy { it.id }",
    "",
  ];
  for (const scheme of SCHEMES) {
    kotlin.push(
      `    public val ${scheme}Marks: Map<String, NativeAppMark> = mapOf(`,
      ...Object.entries(marks[scheme]).map(
        ([id, mark]) =>
          `        ${quote(id)} to NativeAppMark(` +
          `hue = ${kotlinColor(mark.hue)}, ` +
          `chipBackground = ${kotlinColor(mark.chipBackground)}, ` +
          `markColor = ${kotlinColor(mark.markColor)}),`
      ),
      "    )",
      ""
    );
  }
  kotlin.push(...kotlinIcons(), "}", "");
  kotlin.push(
    "/** Geometry both shells need that the token table does not carry. */",
    "public object CentraidGeometry {",
    ...Object.entries(constants).map(([name, value]) => {
      const constName = name
        .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
        .toUpperCase();
      return Number.isInteger(value)
        ? `    public const val ${constName}: Int = ${value}`
        : `    public const val ${constName}: Double = ${value}`;
    }),
    "}",
    ""
  );

  mkdirSync(
    path.join(
      repositoryRoot,
      "mobile/shared/src/commonMain/kotlin/dev/centraid/design"
    ),
    { recursive: true }
  );
  writeFileSync(
    path.join(
      repositoryRoot,
      "mobile/shared/src/commonMain/kotlin/dev/centraid/design/Catalog.kt"
    ),
    `${kotlin.join("\n")}`
  );

  // --- the Swift table ----------------------------------------------------

  const swift: string[] = [
    header("swift"),
    "import SwiftUI",
    "",
    "/// One first-party app's launcher identity.",
    "///",
    "/// `…Meta`, not `CentraidApp`: the shell's `@main` entry point is a SwiftUI",
    "/// `App` named `CentraidApp`, and the two would collide.",
    "public struct CentraidAppMeta {",
    "    public let id: String",
    "    public let name: String",
    "    public let desc: String",
    "    public let iconKey: String",
    "    public let colorKey: String",
    "}",
    "",
    "/// An app's icon chip, already composited. See the Kotlin table.",
    "public struct CentraidAppMark {",
    "    public let hue: Color",
    "    public let chipBackground: Color",
    "    public let markColor: Color",
    "}",
    "",
    "/// One `<path>` of a silhouette: SVG path data in a 24x24 viewBox.",
    "public struct CentraidIconPath {",
    "    public let d: String",
    "    public let filled: Bool",
    "    public let evenOdd: Bool",
    "}",
    "",
    "public enum CentraidCatalog {",
    "    /// The eight first-party apps, in CATALOGUE order — the all-apps",
    "    /// listing's order, which says nothing about the grid.",
    "    public static let apps: [CentraidAppMeta] = [",
    ...apps.map(
      (app) =>
        `        CentraidAppMeta(id: ${quote(app.id)}, name: ${quote(app.name)}, ` +
        `desc: ${quote(app.desc)}, iconKey: ${quote(app.iconKey)}, ` +
        `colorKey: ${quote(app.colorKey)}),`
    ),
    "    ]",
    "",
    "    /// By id, for the header that names one app.",
    "    public static let byID: [String: CentraidAppMeta] = Dictionary(",
    "        uniqueKeysWithValues: apps.map { ($0.id, $0) })",
    "",
  ];
  for (const scheme of SCHEMES) {
    swift.push(
      `    public static let ${scheme}Marks: [String: CentraidAppMark] = [`,
      ...Object.entries(marks[scheme]).map(
        ([id, mark]) =>
          `        ${quote(id)}: CentraidAppMark(` +
          `hue: ${swiftColor(mark.hue)}, ` +
          `chipBackground: ${swiftColor(mark.chipBackground)}, ` +
          `markColor: ${swiftColor(mark.markColor)}),`
      ),
      "    ]",
      ""
    );
  }
  swift.push(...swiftIcons(), "}", "");
  swift.push(
    "/// Geometry both shells need that the token table does not carry.",
    "public enum CentraidGeometry {",
    ...Object.entries(constants).map(([name, value]) =>
      Number.isInteger(value)
        ? `    public static let ${name}: CGFloat = ${value}`
        : `    public static let ${name}: CGFloat = ${value}`
    ),
    "}",
    ""
  );

  mkdirSync(path.join(repositoryRoot, "mobile/iosApp/Design"), {
    recursive: true,
  });
  writeFileSync(
    path.join(repositoryRoot, "mobile/iosApp/Design/Catalog.swift"),
    `${swift.join("\n")}`
  );

  return {
    apps: apps.length,
    icons: ICON_NAMES.length,
    paths: ICON_NAMES.reduce((total, name) => total + icons[name].length, 0),
  };
}
