import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { icons } from "./icons.js";

// THE EMITTED NATIVE TABLES, RE-ASSERTED WHERE THEY ARE READ (#1020,
// D-1020-E6; #1135).
//
// `contracts/tools/export-native-theme.ts` writes the token table, the app
// catalogue and the kit's words for both shells — Kotlin under
// `mobile/androidApp/.../design`, Swift under `mobile/iosApp/Design` — and the
// `emitters` gate step regenerates them and fails on a diff. What a drift check
// cannot see is an emitter that wrote a COMPLETE-LOOKING table with a hole in
// it, or a half-run that regenerated one language: these cases read the
// committed files themselves, the way a shell compiles them. They were
// `NativeThemeSpec`, `CatalogSpec` and the words half of `KitTimeMoneyCopySpec`
// in the deleted KMP module.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (file: string): string =>
  readFileSync(path.join(ROOT, file), "utf8");

const KOTLIN_DESIGN =
  "mobile/androidApp/src/main/kotlin/dev/centraid/android/design";
const TOKENS_KT = read(`${KOTLIN_DESIGN}/Tokens.kt`);
const WORDS_KT = read(`${KOTLIN_DESIGN}/Words.kt`);
const THEME_SWIFT = read("mobile/iosApp/Design/Theme.swift");
const WORDS_SWIFT = read("mobile/iosApp/Design/Words.swift");
const THEME_JSON = read("design/native-theme.json");

interface Catalogue {
  apps: { id: string; iconKey: string }[];
  geometry: Record<string, number>;
  icons: Record<string, unknown[]>;
  marks: Record<
    "light" | "dark",
    Record<string, { chipBackground: string; hue: string; markColor: string }>
  >;
}
const CATALOGUE = JSON.parse(read("design/native-catalog.json")) as Catalogue;

/** A `listOf(...)` of quoted names after `name`, in the Kotlin table. */
function kotlinList(name: string): string[] {
  const start = TOKENS_KT.indexOf(`public val ${name}: List<String> = listOf(`);
  expect(start, name).toBeGreaterThan(-1);
  const body = TOKENS_KT.slice(start, TOKENS_KT.indexOf(")", start));
  return [...body.matchAll(/"(?<role>[A-Za-z0-9]+)",/gu)].map(
    (match) => match.groups?.role ?? ""
  );
}

/** One scheme's block of the Kotlin token object. */
function kotlinScheme(scheme: "light" | "dark"): string {
  const start = TOKENS_KT.indexOf(`public val ${scheme}: NativeTheme`);
  expect(start, scheme).toBeGreaterThan(-1);
  const end = TOKENS_KT.indexOf("\n    )\n", start);
  return TOKENS_KT.slice(start, end);
}

/** A named `mapOf(...)` inside one scheme block. */
function kotlinMap(block: string, name: string): Map<string, string> {
  const start = block.indexOf(`${name} = mapOf(`);
  expect(start, name).toBeGreaterThan(-1);
  const body = block.slice(start, block.indexOf("\n        ),", start));
  return new Map(
    [...body.matchAll(/"(?<key>[A-Za-z0-9]+)" to (?<value>.+),$/gmu)].map(
      (match) => [match.groups?.key ?? "", match.groups?.value ?? ""]
    )
  );
}

const ROLES = kotlinList("NATIVE_COLOR_ROLES");
const EFFECTS = kotlinList("NATIVE_EFFECT_ROLES");

describe("the emitted token table", () => {
  test("both schemes carry every colour role the contract names, none transparent", () => {
    // 52 since Health's identity hue, `olive` (#1129, R-1129-10).
    expect(ROLES).toHaveLength(52);
    for (const scheme of ["light", "dark"] as const) {
      const colors = kotlinMap(kotlinScheme(scheme), "colors");
      expect([...colors.keys()].sort(), scheme).toStrictEqual(
        [...ROLES].sort()
      );
      for (const [role, literal] of colors) {
        // `0xAARRGGBBL`: a role mapped to zero paints transparent black, and an
        // alpha byte of zero could only be an emitter bug — the native lowering
        // has no `color-mix()` and no runtime override layer.
        expect(literal, `${scheme}.${role}`).toMatch(/^0x[0-9A-F]{8}L$/u);
        expect(literal.slice(2, 4), `${scheme}.${role} alpha`).not.toBe("00");
      }
    }
  });

  test("three NativeColors entries are not colours, and they are named", () => {
    expect(EFFECTS).toHaveLength(3);
    const effects = kotlinMap(kotlinScheme("light"), "effects");
    for (const role of EFFECTS) {
      expect(ROLES).not.toContain(role);
      // They are CSS box-shadow strings, which is the point of keeping them apart.
      expect(effects.get(role), role).toContain("px");
    }
  });

  test("the two schemes are different tables, not one table twice", () => {
    const light = kotlinScheme("light");
    const dark = kotlinScheme("dark");
    expect(kotlinMap(light, "colors")).not.toStrictEqual(
      kotlinMap(dark, "colors")
    );
    // Spacing and radii are one grammar in both schemes.
    expect(kotlinMap(light, "spacing")).toStrictEqual(
      kotlinMap(dark, "spacing")
    );
    expect(kotlinMap(light, "radii")).toStrictEqual(kotlinMap(dark, "radii"));
  });

  test("every type style is concrete and ready to render", () => {
    const styles = [...kotlinMap(kotlinScheme("light"), "type").values()].map(
      (literal) => {
        const match =
          /family = "(?<family>[^"]*)", fontSize = (?<size>[0-9.]+), lineHeight = (?<line>[0-9.]+), weight = (?<weight>\d+)/u.exec(
            literal
          );
        expect(match, literal).not.toBeNull();
        return match?.groups ?? {};
      }
    );
    expect(styles.length).toBeGreaterThan(0);
    for (const style of styles) {
      expect(style.family?.trim()).not.toBe("");
      expect(Number(style.size)).toBeGreaterThan(0);
      expect(Number(style.line)).toBeGreaterThanOrEqual(Number(style.size));
      expect(Number(style.weight)).toBeGreaterThanOrEqual(100);
      expect(Number(style.weight)).toBeLessThanOrEqual(900);
    }
  });

  test("the JSON, the Kotlin table and the Swift table are the same table", () => {
    // ONCE PER SCHEME, COUNTED: a presence check over a file with two schemes
    // in it cannot tell a complete table from half of one. The JSON is counted
    // from `schemes` on, because `colorRoleContract` names every role again.
    const json = THEME_JSON.slice(THEME_JSON.indexOf('"schemes"'));
    for (const role of ROLES) {
      expect(json.split(`"${role}":`).length - 1, `json ${role}`).toBe(2);
      expect(THEME_SWIFT.split(`"${role}":`).length - 1, `swift ${role}`).toBe(
        2
      );
    }
    const swiftRoles = [
      ...THEME_SWIFT.matchAll(/^ {4}"(?<role>[A-Za-z0-9]+)",$/gmu),
    ].map((match) => match.groups?.role ?? "");
    expect(swiftRoles.sort()).toStrictEqual([...ROLES].sort());
  });
});

describe("the emitted catalogue", () => {
  test("Home's roster is the catalogue: Rust's ORDER names every app it lists", () => {
    const policy = read("crates/screens/src/shell/policy.rs");
    const order = /pub const ORDER: \[&str; \d+\] = \[(?<body>[^\]]*)\];/u.exec(
      policy
    )?.groups?.body;
    expect(order, "crates/screens/src/shell/policy.rs ORDER").toBeDefined();
    const ids = [...(order ?? "").matchAll(/"(?<id>\w+)"/gu)].map(
      (match) => match.groups?.id ?? ""
    );
    expect([...ids].sort()).toStrictEqual(
      CATALOGUE.apps.map((app) => app.id).sort()
    );
    expect(ids).not.toContain("tasks");
  });

  test("every app has a mark in BOTH schemes, and a chip's wash is never the hue itself", () => {
    for (const app of CATALOGUE.apps) {
      const light = CATALOGUE.marks.light[app.id];
      const dark = CATALOGUE.marks.dark[app.id];
      expect(light, app.id).toBeDefined();
      expect(dark, app.id).toBeDefined();
      expect(light?.chipBackground).not.toBe(light?.hue);
      expect(dark?.chipBackground).not.toBe(dark?.hue);
      // The identity ring moves between light and dark.
      expect(light?.hue).not.toBe(dark?.hue);
    }
  });

  test("every icon key the band and the lockup name resolves", () => {
    // The band's marks are Rust's (`crates/screens/src/shell/band.rs`); a key
    // the set lacks draws a blank mark on both shells and nothing fails.
    const band = read("crates/screens/src/shell/band.rs");
    for (const key of ["Home", "Sparkle", "Backup"]) {
      expect(band, `band.rs names ${key}`).toContain(`"${key}"`);
    }
    for (const key of [
      ...CATALOGUE.apps.map((app) => app.iconKey),
      "Home",
      "Sparkle",
      "Backup",
      "Search",
      "NewChat",
      "Settings",
    ]) {
      expect(Object.hasOwn(icons, key), key).toBe(true);
      expect(CATALOGUE.icons[key]?.length ?? 0, key).toBeGreaterThan(0);
    }
  });

  test("the geometry both shells read is present and sane", () => {
    expect(CATALOGUE.geometry.pageMargin).toBe(18);
    expect(CATALOGUE.geometry.hairline).toBe(1);
    expect(CATALOGUE.geometry.targetMinCoarse).toBe(44);
    expect(CATALOGUE.geometry.iconChipTintDark ?? 0).toBeGreaterThan(
      CATALOGUE.geometry.iconChipTintLight ?? 0
    );
  });
});

describe("the emitted kit words", () => {
  const rust = new Map(
    [
      ...read("crates/screens/src/strings/shared.rs").matchAll(
        /plain (?<key>[a-z0-9_]+) = \("(?<one>(?:[^"\\]|\\.)*)",/gu
      ),
    ].map((match) => [match.groups?.key ?? "", match.groups?.one ?? ""])
  );
  const kotlin = new Map(
    [
      ...WORDS_KT.matchAll(
        /const val (?<name>[A-Z_]+): String = "(?<text>(?:[^"\\]|\\.)*)"/gu
      ),
    ].map((match) => [match.groups?.name ?? "", match.groups?.text ?? ""])
  );
  const swift = new Map(
    [
      ...WORDS_SWIFT.matchAll(
        /static let (?<name>[A-Z_]+) = "(?<text>(?:[^"\\]|\\.)*)"/gu
      ),
    ].map((match) => [match.groups?.name ?? "", match.groups?.text ?? ""])
  );

  test("both shells hold the same words, each one the Rust catalogue's", () => {
    expect(kotlin.size).toBeGreaterThanOrEqual(10);
    expect(swift).toStrictEqual(kotlin);
    for (const [name, text] of kotlin) {
      const key = name === "BACK" ? "back" : `kit_${name.toLowerCase()}`;
      expect(rust.get(key), `${name} ← strings::shared::${key}`).toBe(text);
    }
  });

  test("the two templates fill the Rust catalogue's slot", () => {
    for (const [key, slot] of [
      ["back_to", "parent"],
      ["search_corrected", "corrected"],
    ] as const) {
      const template = rust.get(key) ?? "";
      expect(template, key).toContain(`{${slot}}`);
      expect(WORDS_KT, key).toContain(JSON.stringify(template));
      expect(WORDS_SWIFT, key).toContain(JSON.stringify(template));
    }
  });
});
