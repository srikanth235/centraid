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
// COPY NO LONGER TRAVELS THIS ROAD, AND THAT IS A SUPERSESSION RATHER THAN A
// REGRESSION (#1020, wave 6). `export-copy.ts` read v0's per-app `*-copy.ts`
// leaves under `packages/blueprints`, and wave 6 deleted that tree; the emitter
// and its input went with it. So `copy/*.json` and
// `mobile/shared/.../design/Copy.kt` are no longer generated — they are the
// SOURCE now, the last artifact of a lowering whose upstream is retired, and
// their own banners say so. Leaving the dead `emitCopy` import here is what
// made this whole command — the one command that writes every native artifact —
// unrunnable between the retire commit and wave A.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { toNativeTheme } from "../../packages/design/src/index.ts";
import type { NativeScheme } from "../../packages/design/src/native.ts";
import {
  NATIVE_COLOR_ROLE_MAP,
  assertNativeColorRoleContract,
} from "../../packages/design/src/roles.ts";
import { emitIdentityCorpus } from "./export-design-corpus.ts";
import { emitNativeCatalog } from "./export-native-catalog.ts";

const repositoryRoot = new URL("../..", import.meta.url).pathname;

const SCHEMES: readonly NativeScheme[] = ["light", "dark"];

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

// --- the faces -------------------------------------------------------------
//
// EVERY TYPE TOKEN HAS SAID `family: "sans"` SINCE THE FIRST ONE, AND NEITHER
// NATIVE SHELL HAS EVER DRAWN IT. SwiftUI asked for `.system(...)` and got SF
// Pro; Compose set no `fontFamily` and got Roboto. The word "sans" resolved to
// whatever Apple and Google happened to ship, on a screen the design system is
// supposed to own down to the line box — and nothing failed, which is exactly
// how it survived the project's whole life unnoticed.
//
// The only faces in the tree were `packages/design/fonts/*.woff2`: Latin
// subsets in a WEB container that neither `UIFont` nor Android's resource
// compiler can open. So the `.ttf` faces now sit beside them — the upstream
// SemiBold and the derived 470 the note further down explains, with that
// directory's README carrying the pinned upstream commit, the instancing
// command and the OFL — and THIS emitter is what carries them across, the same
// road the colour table takes, for the same reason. A face copied into two app
// trees by hand is two more untracked copies of a `packages/design` fact, which
// is census §E seam 11 again.
//
// What crosses is BYTES and NAMES:
//
//   * the `.ttf` itself, copied verbatim into `mobile/iosApp/Resources/Fonts/`
//     and `mobile/androidApp/src/main/res/font/`. Android resource names must
//     be lowercase snake_case or `aapt2` refuses the file outright, so the
//     Android copy is renamed and the iOS copy keeps the source filename.
//   * the PostScript name, READ FROM THE TTF'S OWN `name` TABLE rather than
//     guessed from the filename. `UIFont(name:size:)` matches on the PostScript
//     name and returns nil — silently — for anything else, and "the filename
//     without its extension" is a convention, not a guarantee. Guessing here
//     would have reproduced the silent-fallback defect one layer down.
//
// `code` is deliberately NOT in this table. It is the platform's own monospace
// on both shells, ships no file, and the absence is what says so.

interface Face {
  /**
   * THE RAMP'S WEIGHT, NOT THE FILE'S. These are the only two values
   * `NativeTypeStyle.weight` ever holds, and they are what the emitted tables
   * key on; see the 470 note below for the one row where the two disagree.
   */
  readonly weight: number;
  /** The upstream filename, which is also the iOS bundle resource name. */
  readonly file: string;
  /** Lowercase snake_case, because `aapt2` accepts nothing else. */
  readonly androidResource: string;
}

// THE 400 REGISTER IS DRAWN BY A 470 FACE, AND ONLY HERE (decisions.md, ruled
// 2026-08-19, restored for these shells 2026-09-22 under #1029).
//
// This is a LOWERING AND NOT A THIRD WEIGHT, so read the table below carefully:
// the `weight` of the first sans row is `400` and stays `400`, because that is
// what the ramp says and what every emitted `NativeTypeStyle.weight` carries.
// What the row changes is which FILE that register resolves to. DESIGN.md
// specifies two weights; nothing in the ramp may name a 470, and nothing does —
// grep the emitted Kotlin and Swift tables and the only 470 you will find is
// inside a filename.
//
// The reason is the touch step this very emitter applies. `NATIVE_DELTA_BY_FAMILY`
// concedes that the phone needs +2px size and +3px leading over a desktop pane
// at the same role, and that step scales the GLYPH without scaling the stroke's
// optical presence; iOS compounds it, because CoreText draws with grayscale
// antialiasing where a desktop browser gets stem darkening. Same token, same
// face, objectively lighter strokes on the device — so a true 400 reads correct
// at a desk and THIN in the hand, and no edit to the shared ramp could fix one
// without wrecking the other. 500 was measured and overshot; 470 sits about
// three-quarters of the way from 400 to 500 in ink coverage.
//
// WEB AND DESKTOP ARE UNTOUCHED. `scripts/site-tokens.mjs` and
// `toFontFaceCss()` lower the same tokens against the `.woff2` subsets at
// weight 400, and they must keep doing so: the gallery depicts the ramp's
// specification and the device now deliberately differs from it on this one
// axis. A change here that reached the CSS would be the bug.
//
// The 400 static is NOT in `packages/design/fonts` any more, because after this
// row nothing anywhere renders it — the web reads woff2, and native reads the
// two files named below.
const FACES: Readonly<Record<string, readonly Face[]>> = {
  sans: [
    {
      weight: 400,
      file: "InstrumentSans_470Book.ttf",
      androidResource: "instrument_sans_book",
    },
    {
      weight: 600,
      file: "InstrumentSans-SemiBold.ttf",
      androidResource: "instrument_sans_semibold",
    },
  ],
};

/**
 * THE POSTSCRIPT NAME, OUT OF THE FONT ITSELF.
 *
 * An OpenType `name` table is a run of records keyed by (platform, encoding,
 * language, nameID); nameID 6 is the PostScript name. Both platform 3 (Windows,
 * UTF-16BE) and platform 1 (Macintosh, MacRoman) records are accepted because
 * a font may carry either; the Windows one wins when both are present, since it
 * is the one modern tooling writes.
 *
 * Hand-rolled rather than pulled from a font library: this is forty lines of
 * big-endian struct reading against a format that has not changed since 1991,
 * and a dependency that runs at emit time is a dependency in the drift gate.
 */
const postScriptName = (file: string): string => {
  const bytes = readFileSync(file);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tableCount = view.getUint16(4);
  let nameOffset: number | undefined;
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + 16 * index;
    const tag = String.fromCharCode(
      ...[0, 1, 2, 3].map((byteIndex) => view.getUint8(record + byteIndex))
    );
    if (tag === "name") nameOffset = view.getUint32(record + 8);
  }
  if (nameOffset === undefined) throw new Error(`no name table: ${file}`);
  const recordCount = view.getUint16(nameOffset + 2);
  const stringOffset = view.getUint16(nameOffset + 4);
  let found: string | undefined;
  for (let index = 0; index < recordCount; index += 1) {
    const record = nameOffset + 6 + 12 * index;
    const platform = view.getUint16(record);
    const nameId = view.getUint16(record + 6);
    if (nameId !== 6) continue;
    const length = view.getUint16(record + 8);
    const offset = nameOffset + stringOffset + view.getUint16(record + 10);
    const slice = bytes.subarray(offset, offset + length);
    const value =
      platform === 3
        ? new TextDecoder("utf-16be").decode(slice)
        : new TextDecoder("latin1").decode(slice);
    if (platform === 3) return value;
    found ??= value;
  }
  if (found === undefined) throw new Error(`no PostScript name: ${file}`);
  return found;
};

const fontSource = path.join(repositoryRoot, "packages/design/fonts");
const iosFonts = path.join(repositoryRoot, "mobile/iosApp/Resources/Fonts");
const androidFonts = path.join(
  repositoryRoot,
  "mobile/androidApp/src/main/res/font"
);
mkdirSync(iosFonts, { recursive: true });
mkdirSync(androidFonts, { recursive: true });

const resolvedFaces = Object.entries(FACES).map(([family, faces]) => ({
  family,
  faces: faces.map((face) => {
    const source = path.join(fontSource, face.file);
    // A BYTE COPY AND NOTHING ELSE. `git diff --exit-code` after regeneration
    // is the gate (CONSTITUTION, and the banner at the top of this file), so a
    // re-emit that rewrote, subsetted or re-timestamped the file would red a
    // clean tree. `copyFileSync` is deterministic; anything cleverer is not.
    copyFileSync(source, path.join(iosFonts, face.file));
    copyFileSync(
      source,
      path.join(androidFonts, `${face.androidResource}.ttf`)
    );
    return { ...face, postScript: postScriptName(source) };
  }),
}));

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
      // THE ROLE CONTRACT, AS DATA (#1020, D-1020-T1). It is asserted above
      // over the emitted table, in TypeScript; carrying the map lets
      // `crates/design` re-assert the same thing over the same bytes rather
      // than holding a second copy of which fields a native theme must have.
      colorRoleContract: NATIVE_COLOR_ROLE_MAP,
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
    `${comment}`,
    `${comment} THE FACE TABLE BELOW IS EMITTED TOO, and so are the .ttf files it names:`,
    `${comment} \`packages/design/fonts\` is the one source and this emitter copies them into`,
    `${comment} both app trees. A face added or renamed there moves through here.`,
    `${comment}`,
    `${comment} THE TYPE SIZES HERE ARE THE TOUCH STEP AND WILL NOT MATCH THE SOURCE.`,
    `${comment} \`packages/design/src/typography.ts\` holds the web value and a`,
    `${comment} \`nativeDelta\` per role; this table is the sum. For sans that is +2 size`,
    `${comment} and +3 line-height, so \`small\` reads 13/19 there and 15/22 here — the`,
    `${comment} same role, not a second scale. \`NATIVE_DELTA_OVERRIDES\` is the whole`,
    `${comment} list of roles that refuse the step (\`band\`, \`bodyStrong\`, \`control\`,`,
    `${comment} \`display\`, \`eyebrow\`, \`reading\`, \`title\`). Change a value THERE.`,
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
  "/**",
  " * THE FACES BEHIND THE FAMILY NAMES, AS ANDROID RESOURCE NAMES.",
  " *",
  " * `NativeTypeStyle.family` is a word — `sans` — and Compose needs a",
  " * `FontFamily` built from `R.font.*`. Kotlin cannot turn a string into an",
  " * `R` id without reflection, so this table does NOT replace the `R.font`",
  " * references in the shell: it is what a test compares them against, so a",
  " * face renamed in `packages/design/fonts` reds here instead of falling back",
  " * to Roboto on a device. `code` is absent because it is the platform's own",
  " * monospace and ships no file.",
  " *",
  " * THE 400 KEY RESOLVES TO A 470 FACE ON PURPOSE. It is a LOWERING and not a",
  " * third weight: the key is the ramp's 400, the file is `instrument_sans_book`",
  " * (`usWeightClass` 470), and the touch step this table already carries is why",
  " * — see `docs/decisions.md` and the emitter's own note. Web and desktop draw",
  " * a true 400 and are untouched.",
  " */",
  "public val NATIVE_TYPE_FACES: Map<String, Map<Int, String>> = mapOf(",
  ...resolvedFaces.map(
    ({ family, faces }) =>
      `    "${family}" to mapOf(${faces
        .map((face) => `${face.weight} to "${face.androidResource}"`)
        .join(", ")}),`
  ),
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
  "/// THE FACES BEHIND THE FAMILY NAMES, AS POSTSCRIPT NAMES.",
  "///",
  "/// `UIFont(name:size:)` matches a PostScript name and nothing else, and it",
  "/// returns nil rather than complaining. These strings are read out of the",
  "/// TTF's own `name` table by the emitter, so they cannot drift from the",
  "/// bytes in `Resources/Fonts`. `code` is absent: it is the system monospace",
  "/// and ships no file.",
  "///",
  "/// THE 400 KEY RESOLVES TO `InstrumentSans-Book` ON PURPOSE. It is a",
  "/// LOWERING and not a third weight: the key is the ramp's 400, the face is",
  "/// the derived 470 instance, and the touch step plus CoreText's grayscale",
  "/// antialiasing is why — see `docs/decisions.md` and the emitter's own note.",
  "/// Web and desktop draw a true 400 and are untouched.",
  "public let centraidTypeFaces: [String: [Int: String]] = [",
  ...resolvedFaces.map(
    ({ family, faces }) =>
      `    "${family}": [${faces
        .map((face) => `${face.weight}: "${face.postScript}"`)
        .join(", ")}],`
  ),
  "]",
  "",
  "/// The files `UIAppFonts` in `project.yml` must name, one for one.",
  "public let centraidFontFiles: [String] = [",
  ...resolvedFaces.flatMap(({ faces }) =>
    faces.map((face) => `    "${face.file}",`)
  ),
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

// --- the identity corpus and the app catalogue ----------------------------
//
// Both are their OWN emitters and are called here, so one command still emits
// every artifact it can (#1020, D-1020-T5). Copy is no longer among them — see
// the banner at the top of this file.

const corpusCounts = emitIdentityCorpus(repositoryRoot);
const catalogCounts = emitNativeCatalog(repositoryRoot);

console.error(
  `emitted design/native-{theme,catalog}.json, ` +
    `mobile/iosApp/Resources/Fonts and mobile/androidApp/.../res/font ` +
    `(${resolvedFaces.reduce((count, family) => count + family.faces.length, 0)} faces), ` +
    `mobile/shared .../design/{Tokens,Catalog}.kt and ` +
    `mobile/iosApp/Design/{Theme,Catalog}.swift ` +
    `(${colorNames.length} colour roles, ${effectNames.length} non-colour effect ` +
    `entries, ` +
    `${corpusCounts.hues + corpusCounts.initials + corpusCounts.tones} corpus rows, ` +
    `${catalogCounts.apps} apps, ${catalogCounts.icons} icons, ` +
    `${catalogCounts.paths} icon paths)`
);
