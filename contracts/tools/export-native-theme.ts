// ONE EMITTER, N COMMITTED ARTIFACTS, ONE LINT THAT FAILS ON DRIFT
// (#1020, D-1020-E6; census §E8).
//
// `packages/design` is the one token source with two lowerings from one token
// set: `toCss()` for web and desktop, `toNativeTheme(scheme)` for native
// (`packages/design/src/native.ts:213`). The native lowering's own doctrine is
// already a KMP theme contract — every value concrete and ready to render, no
// `var()`, `calc()`, `color-mix()`, `oklch()`, stylesheet parser or runtime
// override layer in the mobile path — so a Kotlin `Color` table and a Swift
// `Theme` struct are not a third and fourth lowering. They are the SAME
// lowering, emitted.
//
// The precedent is `scripts/site-tokens.mjs`, which emits a committed
// `centraid-tokens.css` per public surface from the same emitter and is gated
// by `bun run lint:site-tokens`, failing on drift, on a `var()` that resolves
// to nothing, on a literal font family and on a font-CDN reference
// (`docs/decisions.md:411`). A HAND-MAINTAINED Kotlin colour table would be a
// fourth lowering with no drift gate, which is census §E seam 11.
//
//   bun contracts/tools/export-native-theme.ts
//   bun run format
//   git diff --exit-code design copy mobile
//
// The last line is the gate. It is in `cargo xtask`'s `mobile-jvm` step, so a
// token change that forgets to regenerate reds in the same place a test would.
//
// COPY travels the same road. There is no central copy file in v0 — the leaves
// are per-app `*-copy.ts` modules of named strings, deliberately import-free
// where both the shell and the mobile kit read them
// (`packages/blueprints/apps/_shared/shared-copy.ts:1-11`) — so the emitter
// takes the STRING-VALUED exports of the named leaves and leaves the functions
// behind, listing them so a reader can see what did not cross.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { toNativeTheme } from "../../packages/design/src/index.ts";
import type { NativeScheme } from "../../packages/design/src/native.ts";
// NOT re-exported from the package index (`grep -n assertNativeColorRole
// packages/design/src/index.ts` finds nothing), so the module is imported
// directly rather than the assertion being skipped.
import { assertNativeColorRoleContract } from "../../packages/design/src/roles.ts";

const repositoryRoot = new URL("../..", import.meta.url).pathname;

const SCHEMES: readonly NativeScheme[] = ["light", "dark"];

/**
 * The copy leaves that reach a native surface, and the app each belongs to.
 *
 * READ AS TEXT, not imported. Two of these four leaves are import-free by
 * design — "a leaf with no imports is the only shape both worlds can read"
 * (`packages/blueprints/apps/_shared/shared-copy.ts:1-11`) — and the other two
 * are not, so importing them pulls a `.tsx` app frame and `@centraid/design`
 * into a build script. `contracts/tools/export-v0-registries.ts` already reads
 * v0 declarations as text for the same reason, and the precedent is the right
 * one: a script that needed the whole web graph to resolve would be a script
 * that breaks whenever a component moves.
 */
const COPY_LEAVES: Record<string, string> = {
  notes: "packages/blueprints/apps/notes/view-copy.ts",
  photos: "packages/blueprints/apps/photos/shared-copy.ts",
  shared: "packages/blueprints/apps/_shared/shared-copy.ts",
  tally: "packages/blueprints/apps/tally/route-copy.ts",
};

/**
 * `export const NAME = "…";` and nothing else.
 *
 * Deliberately narrow: a template literal, a concatenation or a computed value
 * is a DECISION about how a sentence is composed, and the emitter leaves those
 * to the kit rather than half-porting them. What it does not match, it lists.
 */
const STRING_EXPORT =
  /^export const (?<name>[A-Z][A-Z0-9_]*)\s*=\s*(?<literal>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*;/gmu;
const FUNCTION_EXPORT = /^export function (?<name>[A-Za-z][A-Za-z0-9_]*)/gmu;
const OTHER_CONST_EXPORT =
  /^export const (?<name>[A-Za-z][A-Za-z0-9_]*)\s*[=:]/gmu;

// --- the token table -------------------------------------------------------

const themes = Object.fromEntries(
  SCHEMES.map((scheme) => {
    const theme = toNativeTheme(scheme);
    // THE ROLE CONTRACT IS RE-ASSERTED over the emitted table, not only inside
    // the lowering. `assertNativeColorRoleContract` is the fixture that keeps
    // an emitted table honest (census §E seam 11); asserting only at lowering
    // time would leave the emitted artifact unchecked.
    assertNativeColorRoleContract(theme.colors);
    return [scheme, theme];
  })
);

/**
 * NOT EVERY `NativeColors` ENTRY IS A COLOUR — a FINDING, handled rather than
 * hidden (#1020 lane E; census §E seam 11).
 *
 * `packages/design/src/native.ts:1-9` says every value in the native lowering
 * is "concrete and ready to render", with "no `var()`, `calc()`,
 * `color-mix()`, `oklch()`, stylesheet parser or runtime override layer in the
 * mobile path". Two kinds of value in `colors` break that promise for a
 * non-CSS consumer:
 *
 *   * `rgba(20,20,20,.08)` — a CSS colour function. A Compose `Color(Long)` and
 *     a SwiftUI `Color(.sRGB, …)` both need channels, so the emitter PARSES it.
 *   * `0 24px 48px -16px rgba(20,20,20,.16)` — a CSS `box-shadow`, in
 *     `shadowLg`/`shadowSm`. That is not a colour at all, and no amount of
 *     parsing makes it one.
 *
 * So the emitter splits them: real colours become channels, and the rest go
 * into `effects` as the strings they are, with their names listed so a reader
 * of the Kotlin table can see what did not become a `Color`. The receipt files
 * the underlying issue against `packages/design`; inventing a shadow API here
 * would be this lane deciding a design question.
 */
const parseColor = (
  value: string
):
  | {
      readonly red: number;
      readonly green: number;
      readonly blue: number;
      readonly alpha: number;
    }
  | undefined => {
  const hex = /^#(?<body>[0-9a-f]{6})(?<opacity>[0-9a-f]{2})?$/iu.exec(
    value.trim()
  );
  if (hex?.groups) {
    const { body, opacity } = hex.groups;
    return {
      red: Number.parseInt(body.slice(0, 2), 16),
      green: Number.parseInt(body.slice(2, 4), 16),
      blue: Number.parseInt(body.slice(4, 6), 16),
      alpha: opacity === undefined ? 1 : Number.parseInt(opacity, 16) / 255,
    };
  }
  const rgba =
    /^rgba?\(\s*(?<red>\d+)\s*,\s*(?<green>\d+)\s*,\s*(?<blue>\d+)\s*(?:,\s*(?<opacity>[0-9.]+)\s*)?\)$/u.exec(
      value.trim()
    );
  if (rgba?.groups) {
    const channels = rgba.groups;
    return {
      red: Number(channels.red),
      green: Number(channels.green),
      blue: Number(channels.blue),
      alpha: channels.opacity === undefined ? 1 : Number(channels.opacity),
    };
  }
  return undefined;
};

const allColorEntries = Object.entries(themes.light.colors).map(
  ([name, value]) => ({
    name,
    parsed: parseColor(String(value)),
  })
);
const colorNames = allColorEntries
  .filter((entry) => entry.parsed !== undefined)
  .map((entry) => entry.name)
  .sort();
const effectNames = allColorEntries
  .filter((entry) => entry.parsed === undefined)
  .map((entry) => entry.name)
  .sort();
const spacingNames = Object.keys(themes.light.spacing).sort();
const radiiNames = Object.keys(themes.light.radii).sort();
const typeNames = Object.keys(themes.light.type).sort();

mkdirSync(path.join(repositoryRoot, "design"), { recursive: true });
writeFileSync(
  path.join(repositoryRoot, "design/native-theme.json"),
  `${JSON.stringify(
    {
      $generatedBy: "contracts/tools/export-native-theme.ts",
      $note:
        "The native lowering of packages/design, emitted for the KMP shared " +
        "module and for SwiftUI. Regenerate with " +
        "`bun contracts/tools/export-native-theme.ts && bun run format`; " +
        "`git diff --exit-code design copy mobile` is the drift check (#1020).",
      schemes: themes,
    },
    undefined,
    2
  )}\n`
);

const header = (language: "kotlin" | "swift"): string => {
  const comment = language === "kotlin" ? "//" : "//";
  return [
    `${comment} GENERATED by contracts/tools/export-native-theme.ts. Do not edit.`,
    `${comment}`,
    `${comment} The native lowering of packages/design (#1020, D-1020-E6). A hand-edited`,
    `${comment} copy of this table is a fourth lowering with no drift gate, which is what`,
    `${comment} \`git diff --exit-code design copy mobile\` in the mobile-jvm gate step`,
    `${comment} exists to prevent.`,
    "",
  ].join("\n");
};

const byte = (part: number): string =>
  Math.round(Math.max(0, Math.min(255, part)))
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();

/** Compose wants `0xAARRGGBB` as a `Long`, so the literal carries its `L`. */
const kotlinColor = (value: string): string => {
  const parsed = parseColor(value);
  if (parsed === undefined) throw new Error(`not a colour: ${value}`);
  return `0x${byte(parsed.alpha * 255)}${byte(parsed.red)}${byte(parsed.green)}${byte(
    parsed.blue
  )}L`;
};

const kotlinLines: string[] = [
  header("kotlin"),
  "package dev.centraid.design",
  "",
  "/** One scheme's concrete, ready-to-render values. */",
  "public data class NativeTheme(",
  "    public val scheme: String,",
  "    public val colors: Map<String, Long>,",
  "    /**",
  "     * Values `packages/design` puts in `NativeColors` that are NOT colours:",
  "     * CSS `box-shadow` strings. See the emitter's `parseColor` comment and the",
  "     * receipt's findings — a shadow API is a design decision, not an emitter's.",
  "     */",
  "    public val effects: Map<String, String>,",
  "    public val spacing: Map<String, Int>,",
  "    public val radii: Map<String, Int>,",
  "    public val type: Map<String, NativeTypeStyle>,",
  ")",
  "",
  "public data class NativeTypeStyle(",
  "    public val family: String,",
  "    public val fontSize: Double,",
  "    public val lineHeight: Double,",
  "    public val weight: Int,",
  ")",
  "",
  "/** Every colour role the contract names. The list is asserted, not assumed. */",
  "public val NATIVE_COLOR_ROLES: List<String> = listOf(",
  ...colorNames.map((name) => `    "${name}",`),
  ")",
  "",
  "/** The `NativeColors` entries that are not colours. See `NativeTheme.effects`. */",
  "public val NATIVE_EFFECT_ROLES: List<String> = listOf(",
  ...effectNames.map((name) => `    "${name}",`),
  ")",
  "",
  "public object CentraidTokens {",
];

for (const scheme of SCHEMES) {
  const theme = themes[scheme];
  kotlinLines.push(
    `    public val ${scheme}: NativeTheme = NativeTheme(`,
    `        scheme = "${scheme}",`,
    "        colors = mapOf(",
    ...colorNames.map(
      (name) =>
        `            "${name}" to ${kotlinColor(String(theme.colors[name]))},`
    ),
    "        ),",
    "        effects = mapOf(",
    ...effectNames.map(
      (name) =>
        `            "${name}" to ${JSON.stringify(String(theme.colors[name]))},`
    ),
    "        ),",
    "        spacing = mapOf(",
    ...spacingNames.map(
      (name) =>
        `            "${name}" to ${Math.round(Number(theme.spacing[name]))},`
    ),
    "        ),",
    "        radii = mapOf(",
    ...radiiNames.map(
      (name) =>
        `            "${name}" to ${Math.round(Number(theme.radii[name]))},`
    ),
    "        ),",
    "        type = mapOf(",
    ...typeNames.map((name) => {
      const style = theme.type[name] as Record<string, unknown>;
      return (
        `            "${name}" to NativeTypeStyle(` +
        `family = "${String(style.family)}", ` +
        `fontSize = ${Number(style.fontSize).toFixed(1)}, ` +
        `lineHeight = ${Number(style.lineHeight).toFixed(1)}, ` +
        `weight = ${Number(style.weight)}),`
      );
    }),
    "        ),",
    "    )",
    ""
  );
}
kotlinLines.push("}", "");

mkdirSync(
  path.join(
    repositoryRoot,
    "mobile/shared/src/commonMain/kotlin/dev/centraid/design"
  ),
  {
    recursive: true,
  }
);
writeFileSync(
  path.join(
    repositoryRoot,
    "mobile/shared/src/commonMain/kotlin/dev/centraid/design/Tokens.kt"
  ),
  `${kotlinLines.join("\n")}`
);

// --- the Swift table ------------------------------------------------------

const swiftLines: string[] = [
  header("swift"),
  "import SwiftUI",
  "",
  "public struct CentraidTypeStyle {",
  "    public let family: String",
  "    public let fontSize: CGFloat",
  "    public let lineHeight: CGFloat",
  "    public let weight: Int",
  "}",
  "",
  "public struct CentraidTheme {",
  "    public let scheme: String",
  "    public let colors: [String: Color]",
  "    /// See `NativeTheme.effects` in the Kotlin table: CSS box-shadow strings.",
  "    public let effects: [String: String]",
  "    public let spacing: [String: CGFloat]",
  "    public let radii: [String: CGFloat]",
  "    public let type: [String: CentraidTypeStyle]",
  "}",
  "",
  "/// Every colour role the contract names. The list is asserted, not assumed.",
  "public let centraidColorRoles: [String] = [",
  ...colorNames.map((name) => `    "${name}",`),
  "]",
  "",
  "public enum CentraidTokens {",
];

const swiftColor = (value: string): string => {
  const parsed = parseColor(value);
  if (parsed === undefined) throw new Error(`not a colour: ${value}`);
  const round = (part: number): string => part.toFixed(6);
  return (
    `Color(.sRGB, red: ${round(parsed.red / 255)}, green: ${round(parsed.green / 255)}, ` +
    `blue: ${round(parsed.blue / 255)}, opacity: ${round(parsed.alpha)})`
  );
};

for (const scheme of SCHEMES) {
  const theme = themes[scheme];
  swiftLines.push(
    `    public static let ${scheme} = CentraidTheme(`,
    `        scheme: "${scheme}",`,
    "        colors: [",
    ...colorNames.map(
      (name) =>
        `            "${name}": ${swiftColor(String(theme.colors[name]))},`
    ),
    "        ],",
    "        effects: [",
    ...effectNames.map(
      (name) =>
        `            "${name}": ${JSON.stringify(String(theme.colors[name]))},`
    ),
    "        ],",
    "        spacing: [",
    ...spacingNames.map(
      (name) =>
        `            "${name}": ${Math.round(Number(theme.spacing[name]))},`
    ),
    "        ],",
    "        radii: [",
    ...radiiNames.map(
      (name) =>
        `            "${name}": ${Math.round(Number(theme.radii[name]))},`
    ),
    "        ],",
    "        type: [",
    ...typeNames.map((name) => {
      const style = theme.type[name] as Record<string, unknown>;
      return (
        `            "${name}": CentraidTypeStyle(` +
        `family: "${String(style.family)}", ` +
        `fontSize: ${Number(style.fontSize)}, ` +
        `lineHeight: ${Number(style.lineHeight)}, ` +
        `weight: ${Number(style.weight)}),`
      );
    }),
    "        ],",
    "    )",
    ""
  );
}
swiftLines.push("}", "");

mkdirSync(path.join(repositoryRoot, "mobile/iosApp/Design"), {
  recursive: true,
});
writeFileSync(
  path.join(repositoryRoot, "mobile/iosApp/Design/Theme.swift"),
  `${swiftLines.join("\n")}`
);

// --- copy -----------------------------------------------------------------

mkdirSync(path.join(repositoryRoot, "copy"), { recursive: true });

const copyKotlin: string[] = [
  header("kotlin"),
  "package dev.centraid.design",
  "",
  "/**",
  " * Copy, emitted from v0's per-app `*-copy.ts` leaves (#1020, D-1020-E6).",
  " *",
  " * STRINGS ONLY. A leaf's function exports are listed in `copy/<app>.json`'s",
  " * `functions` array and are NOT emitted: a function is a decision about how to",
  " * compose a sentence, and a generated Kotlin port of one would be a second",
  " * implementation that drifts. Wave 4 moves those into the kit.",
  " */",
  "public object CentraidCopy {",
];

for (const [app, leafPath] of Object.entries(COPY_LEAVES).sort(
  ([left], [right]) => left.localeCompare(right)
)) {
  const source = readFileSync(path.join(repositoryRoot, leafPath), "utf8");
  const strings: Record<string, string> = {};
  const functions: string[] = [];
  for (const match of source.matchAll(FUNCTION_EXPORT)) {
    functions.push(match.groups?.name ?? "");
  }
  const literals = new Map<string, string>();
  for (const match of source.matchAll(STRING_EXPORT)) {
    const literal = match.groups?.literal ?? '""';
    literals.set(
      match.groups?.name ?? "",
      JSON.parse(`"${literal.slice(1, -1).replace(/"/gu, '\\"')}"`) as string
    );
  }
  // Every other exported const is NOT emitted, and is listed so a reader can
  // see what did not cross rather than wondering whether it was missed.
  for (const match of source.matchAll(OTHER_CONST_EXPORT)) {
    const name = match.groups?.name ?? "";
    if (!literals.has(name)) functions.push(name);
  }
  for (const [name, value] of [...literals.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    strings[name] = value;
    {
      // SENTENCE CASE IS A RULE (`docs/decisions.md:98`), and the mobile kit
      // has its own discipline for it (`apps/mobile/src/kit/copy-case.ts`).
      // The emitter ASSERTS what it can check without a dictionary: a string
      // that begins lower-case in a position that should be a sentence would
      // be a finding, and a string in Title Case Like This is one it can spot.
      const words = value
        .split(" ")
        .filter((word) => /^[A-Z][a-z]+$/u.test(word));
      if (words.length >= 4) {
        throw new Error(
          `copy/${app}.json: "${name}" looks like Title Case ("${value}"), and ` +
            `DESIGN.md's copy rules are sentence case (docs/decisions.md:98).`
        );
      }
    }
  }
  writeFileSync(
    path.join(repositoryRoot, `copy/${app}.json`),
    `${JSON.stringify(
      {
        $generatedBy: "contracts/tools/export-native-theme.ts",
        app,
        strings,
        functions,
      },
      undefined,
      2
    )}\n`
  );
  copyKotlin.push(`    public object ${app[0].toUpperCase()}${app.slice(1)} {`);
  for (const [name, value] of Object.entries(strings)) {
    copyKotlin.push(
      `        public const val ${name}: String = ${JSON.stringify(value)}`
    );
  }
  copyKotlin.push("    }", "");
}
copyKotlin.push("}", "");

writeFileSync(
  path.join(
    repositoryRoot,
    "mobile/shared/src/commonMain/kotlin/dev/centraid/design/Copy.kt"
  ),
  `${copyKotlin.join("\n")}`
);

console.error(
  `emitted design/native-theme.json, mobile/shared .../design/{Tokens,Copy}.kt, ` +
    `mobile/iosApp/Design/Theme.swift and copy/*.json ` +
    `(${colorNames.length} colour roles, ${effectNames.length} non-colour effect ` +
    `entries, ${Object.keys(COPY_LEAVES).length} copy leaves)`
);
