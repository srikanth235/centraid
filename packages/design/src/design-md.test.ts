import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { apps } from "./apps.js";
import { DENSITY_TIERS, metrics, spacing } from "./density.js";
import { toNativeTheme } from "./native.js";
import { APP_HUES, palette, paletteDark, paletteText } from "./palette.js";
import { radii } from "./radii.js";
import { RECIPE_NAMES } from "./recipes/index.js";
import { themes } from "./themes/index.js";
import {
  ACCENT_HOVER,
  ACCENT_HOVER_DARK,
  ACCENT_INK_HOVER,
  ACCENT_INK_HOVER_DARK,
  ACCENT_LIGHT,
  ACCENT_LIGHT_DARK,
  ATTENTION,
  ATTENTION_DARK,
  BRAND,
  BRAND_DARK,
  DANGER,
  DANGER_DARK,
  EASE,
  EASE_ENTRY,
  LINK,
  LINK_DARK,
  NET,
  NET_DARK,
  NET_HOVER,
  NET_HOVER_DARK,
  NET_WASH,
  NET_WASH_DARK,
  ON_STAGE,
  RING,
  RING_DARK,
  SEAM,
  SEAM_DARK,
  STAGE,
  STAGE_LINE,
  SUCCESS,
  SUCCESS_LIGHT,
  WARNING,
  WARNING_LIGHT,
} from "./themes/shared.js";
import {
  fonts,
  NATIVE_DELTA_BY_FAMILY,
  NATIVE_DELTA_OVERRIDES,
  type,
  typeKeyToKebab,
  typeSizeRungs,
} from "./typography.js";

const DESIGN_MD = fileURLToPath(new URL("../../../DESIGN.md", import.meta.url));
const source = readFileSync(DESIGN_MD, "utf8");
const [frontMatter = "", body = ""] = source.split(/^---$/mu).slice(1);

function frontMatterValue(key: string): string {
  const line = frontMatter
    .split("\n")
    .find((candidate) => new RegExp(`^\\s*${key}:`, "u").test(candidate));
  return (
    line
      ?.split(":")
      .slice(1)
      .join(":")
      .trim()
      .replace(/^['"]|['"]$/gu, "") ?? ""
  );
}

function hasNestedRole(group: string, role: string): boolean {
  const start = frontMatter.indexOf(`${group}:`);
  const end = frontMatter.indexOf("\n---", start);
  return new RegExp(`^ {2}${role}:$`, "mu").test(
    frontMatter.slice(start, end < 0 ? undefined : end)
  );
}

function nestedKeys(group: string): string[] {
  const start = frontMatter.indexOf(`${group}:`);
  const rest = frontMatter.slice(start + group.length + 1);
  const nextGroup = rest.search(/\n(?=[A-Za-z][\w-]*:)/u);
  const end = nextGroup < 0 ? undefined : start + group.length + 1 + nextGroup;
  return [
    ...frontMatter
      .slice(start, end)
      .matchAll(/^ {2}["']?(?<key>[\w-]+)["']?:/gmu),
  ].map((match) => match.groups?.key ?? "");
}

describe("DESIGN.md front matter", () => {
  test("pins identity, and the identity is ink", () => {
    expect(frontMatterValue("version")).toBe("alpha");
    expect(frontMatterValue("name")).toBe("Centraid");
    expect(frontMatter).toContain(`  brand: "${BRAND}"`);
    expect(frontMatter).toContain(`  accent: "${BRAND}"`);
    expect(frontMatter).toContain('  primary: "{colors.brand}"');
    expect(frontMatterValue("accent")).toBe(themes.light.text);
    expect(frontMatterValue("accent-dark")).toBe(themes.dark.text);
    expect(frontMatter).not.toContain("#3EC8B4");
  });

  test("carries the canonical palette and geometry", () => {
    for (const [key, value] of Object.entries(palette)) {
      expect(frontMatter).toContain(`  c-${key}: "${value}"`);
    }
    for (const [key, value] of Object.entries(paletteDark)) {
      expect(frontMatter).toContain(`  c-${key}-dark: "${value}"`);
    }
    for (const [key, value] of Object.entries(radii)) {
      expect(frontMatter).toContain(`  ${key}: "${value}px"`);
    }
    for (const [key, value] of Object.entries(spacing)) {
      expect(frontMatter).toContain(`  "${key}": "${value}px"`);
    }
    expect(frontMatter).toContain('  pill: "999px"');
    expect(nestedKeys("rounded")).toStrictEqual(Object.keys(radii));
    expect(nestedKeys("spacing")).toStrictEqual(
      Object.keys(spacing).map(String)
    );
  });

  test("pins every solved color cell and every surface tone", () => {
    const expected = {
      brand: BRAND,
      accent: BRAND,
      "accent-light": ACCENT_LIGHT,
      "accent-light-dark": ACCENT_LIGHT_DARK,
      "accent-deep": BRAND,
      "accent-deep-dark": themes.dark.accentDeep,
      "accent-hover": ACCENT_HOVER,
      "accent-hover-dark": ACCENT_HOVER_DARK,
      "accent-ink-hover": ACCENT_INK_HOVER,
      "accent-ink-hover-dark": ACCENT_INK_HOVER_DARK,
      "accent-text": BRAND,
      "accent-text-dark": BRAND_DARK,
      attention: ATTENTION,
      "attention-dark": ATTENTION_DARK,
      link: LINK,
      "link-dark": LINK_DARK,
      net: NET,
      "net-dark": NET_DARK,
      "net-hover": NET_HOVER,
      "net-hover-dark": NET_HOVER_DARK,
      "net-wash": NET_WASH,
      "net-wash-dark": NET_WASH_DARK,
      seam: SEAM,
      "seam-dark": SEAM_DARK,
      ring: RING,
      "ring-dark": RING_DARK,
      success: SUCCESS_LIGHT,
      "success-dark": SUCCESS,
      danger: DANGER,
      "danger-dark": DANGER_DARK,
      warning: WARNING_LIGHT,
      "warning-dark": WARNING,
      stage: STAGE,
      "on-stage": ON_STAGE,
      "stage-line": STAGE_LINE,
    };
    for (const [key, value] of Object.entries(expected)) {
      expect(frontMatterValue(key), key).toBe(value);
    }
    for (const [key, value] of Object.entries(palette)) {
      expect(frontMatterValue(`c-${key}`), `c-${key}`).toBe(value);
      const paletteKey = key as keyof typeof paletteText.light;
      expect(frontMatterValue(`c-${key}-text`)).toBe(
        paletteText.light[paletteKey]
      );
      expect(frontMatterValue(`c-${key}-text-dark`)).toBe(
        paletteText.dark[paletteKey]
      );
    }
  });

  test("pins the two ramps against the emitted native theme", () => {
    const light = toNativeTheme("light").colors;
    const dark = toNativeTheme("dark").colors;
    for (const [key, value] of Object.entries({
      "light-bg": light.bg,
      "light-bg-app": themes.light.bgApp,
      "light-bg-elev": light.bgElev,
      "light-bg-sunken": light.bgSunken,
      "light-text": light.text,
      "light-text-soft": light.textSoft,
      "light-text-faint": light.textFaint,
      "light-text-ghost": light.textGhost,
      "light-text-disabled": light.textDisabled,
      "light-text-inv": light.textInv,
      "light-line": light.line,
      "light-line-strong": light.lineStrong,
      "dark-bg": dark.bg,
      "dark-bg-app": themes.dark.bgApp,
      "dark-bg-elev": dark.bgElev,
      "dark-bg-sunken": dark.bgSunken,
      "dark-text": dark.text,
      "dark-text-soft": dark.textSoft,
      "dark-text-faint": dark.textFaint,
      "dark-text-ghost": dark.textGhost,
      "dark-text-disabled": dark.textDisabled,
      "dark-text-inv": dark.textInv,
      "dark-line": dark.line,
      "dark-line-strong": dark.lineStrong,
    })) {
      expect(frontMatterValue(key), key).toBe(value);
    }
    expect(frontMatterValue("light-skel")).toBe(themes.light.skel);
    expect(frontMatterValue("dark-skel")).toBe(themes.dark.skel);
  });

  test("pins typography and every recipe component", () => {
    for (const [key, styleValue] of Object.entries(type)) {
      const role = typeKeyToKebab(key);
      expect(frontMatter).toContain(`  ${role}:`);
      expect(frontMatter).toContain(
        `    fontFamily: "${fonts[styleValue.family]}"`
      );
      expect(frontMatter).toContain(`    fontSize: "${styleValue.size}px"`);
      expect(frontMatter).toContain(`    fontWeight: "${styleValue.weight}"`);
      expect(frontMatter).toContain(
        `    lineHeight: "${styleValue.lineHeight}px"`
      );
      const override = (
        NATIVE_DELTA_OVERRIDES as Record<string, typeof styleValue.nativeDelta>
      )[key];
      expect(styleValue.nativeDelta).toStrictEqual(
        override ?? NATIVE_DELTA_BY_FAMILY[styleValue.family]
      );
    }
    expect(frontMatter).toContain('    letterSpacing: "-0.01em"');
    expect(frontMatter).toContain('    letterSpacing: "0.06em"');
    expect(frontMatter).toContain('    textTransform: "uppercase"');
    expect(frontMatter).toContain('    fontVariantNumeric: "tabular-nums"');
    for (const name of RECIPE_NAMES) {
      expect(hasNestedRole("components", name), name).toBe(true);
    }
  });

  test("pins every type role and the ramp's own laws in the body", () => {
    for (const [key, styleValue] of Object.entries(type)) {
      expect(hasNestedRole("typography", typeKeyToKebab(key))).toBe(true);
      expect(body).toContain(`--t-${typeKeyToKebab(key)}`);
      expect(body).toContain(`${styleValue.size} / ${styleValue.lineHeight}`);
      expect(body).toContain(fonts[styleValue.family]);
    }
    expect(body).toContain("mandatory CJK fallbacks");
    expect(body).toContain("nativeDelta");
    expect(body).toContain("11px");
    expect(body).toContain("tabular");
    expect(body).toContain("`--t-hero`");
    expect(body).toContain("`--t-greeting`");
    expect(body).toContain("`--bg-l`");
  });

  test("pins the solved theme values", () => {
    expect(frontMatter).toContain(`  light-bg: "${themes.light.bg}"`);
    expect(frontMatter).toContain(`  light-text: "${themes.light.text}"`);
    expect(frontMatter).toContain(`  dark-text: "${themes.dark.text}"`);
    expect(frontMatter).toContain(`  dark-line: "${themes.dark.line}"`);
  });
});

describe("DESIGN.md body", () => {
  test("uses the canonical sections", () => {
    const canonical = [
      "Overview",
      "Colors",
      "Typography",
      "Layout",
      "Elevation & Depth",
      "Shapes",
      "Components",
      "Copy",
      "Responsive Behavior",
      "Agent Prompt Guide",
      "Do's and Don'ts",
    ];
    const present = [...body.matchAll(/^## (?<title>.+)$/gmu)].map(
      (match) => match.groups?.title?.trim() ?? ""
    );
    expect(present).toStrictEqual(canonical);
  });

  test("states the five invariants as laws", () => {
    expect(body.length).toBeGreaterThan(7000);
    expect(body).toContain("docs/traps/design-tokens.md");
    expect(body).toContain("packages/design/src/roles.ts");
    expect(body).toContain("packages/design/src/recipes/index.ts");
    expect(body).toContain("The five invariants");
    expect(body).toContain(`${metrics.stem}px`);
    expect(body).toContain("logical properties");
    expect(body).toContain("5 apps plus More");
    expect(body).toContain("One ramp, one face");
    expect(body).toContain("hierarchy comes from named roles");
    expect(body).not.toContain("reading or scanning");
    expect(body).toContain("the shell owns no colour");
    expect(body).toContain("one filled ink element per view");
    expect(body).toContain("outlined");
    expect(body).toContain("`--net`");
    expect(body).toContain("`--link`");
    expect(body).toContain(`\`--h-control\` ${metrics.control}px`);
    expect(body).toContain(`\`--h-row\` ${metrics.row}px`);
    expect(body).toContain(`\`--h-segmented\` ${metrics.segmented}px`);
    expect(body).toContain(
      `\`--w-key-col\` — the fact-list key column, ${metrics.keyCol}px under a pointer and ${metrics.keyColTouch}px on touch`
    );
    expect(body).toContain("line-clamped");
    expect(body).toContain("status line");
    expect(body).toContain("determinate");
  });

  test("publishes the freedom table an app is judged against", () => {
    expect(body).toContain("What an app may set for itself");
    for (const tier of Object.keys(DENSITY_TIERS)) expect(body).toContain(tier);
    expect(body).toContain("`data-density`");
    expect(body).toContain("Never on a control");
    expect(body).not.toContain("| Surface tone |");
    expect(body).not.toContain("| Primary register |");
    expect(body).toContain("| Surface |");
    expect(body).toContain("Width is a canvas, not a surface");
  });

  test("records the brief-to-repo mapping and the app hue table", () => {
    expect(body).toContain("The brief-to-repo role mapping");
    const row = (...cells: string[]): RegExp =>
      new RegExp(
        `\\|\\s*${cells.map((cell) => cell.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("\\s*\\|\\s*")}\\s*\\|`,
        "u"
      );
    for (const [brief, repo] of [
      ["`ink`", "`--text`"],
      ["`ink2`", "`--text-soft`"],
      ["`ink3`", "`--text-faint`"],
      ["`surf`", "`--bg-elev`"],
      ["`lineS`", "`--line`"],
      ["`onAccent`", "`--text-inv`"],
      ["`ring`", "`--focus-ring-color`"],
      ["`netHover`", "`--net-hover`"],
      ["`netWash`", "`--net-wash`"],
      ["`seam`", "`--seam`"],
      ["`accentHover`", "`--accent-hover`"],
      ["`ghost`", "`--text-ghost`"],
      ["`label` / `band-on`", "`--t-body` / `--t-control`"],
      ["`label-on`", "`--t-label-on`"],
      [
        "`annot-label` / `annot-label-on`",
        "`--t-annot-label` / `--t-annot-label-on`",
      ],
      ["`band`", "`--t-band`"],
    ] as const) {
      expect(body, brief).toMatch(row(brief, repo));
    }
    for (const app of apps) {
      expect(body, app.id).toMatch(
        row(app.id, String(APP_HUES[app.colorKey]), `\`${app.colorKey}\``)
      );
    }
  });

  test("documents every composable role size", () => {
    for (const [name, value] of Object.entries(typeSizeRungs(type))) {
      expect(body).toContain(`\`${name}\` ${value}`);
    }
    expect(body).toContain("Duplicate values keep semantic names");
    expect(body).toContain("There are no line-height rungs");
  });

  test("quotes the motion and responsive accessibility contracts", () => {
    expect(body).toContain(EASE);
    expect(body).toContain(EASE_ENTRY);
    expect(body).toContain("140ms");
    expect(body).toContain("280ms");
    expect(body).toContain("44px");
    expect(body).toContain("34px");
    expect(body).toContain("720px");
    expect(body).toContain("prefers-reduced-motion");
    expect(body).toContain("ONE global rule");
  });

  test("documents the stage/skel roles and the numeric role's own direction", () => {
    expect(body).toContain("`--stage`");
    expect(body).toContain("`--on-stage`");
    expect(body).toContain("`--stage-line`");
    expect(body).toContain("`--skel`");
    expect(body).toContain(STAGE);
    expect(body).toContain(ON_STAGE);
    expect(body).toContain(STAGE_LINE);
    expect(body).toContain(themes.light.skel);
    expect(body).toContain(themes.dark.skel);
    expect(body).toContain("the same literal in both themes");
    expect(body).toContain("`--t-mono-direction`");
    expect(body).toContain("`--t-mono-bidi`");
    expect(body).toContain("never per span");
    expect(body).toContain(
      "layout container must never carry the numeric face"
    );
  });

  test("names the deeper docs and machine checks", () => {
    expect(body).toContain("google-labs-code/design.md");
    expect(body).toContain("bun run lint:design-md");
    expect(body).toContain("bun run check:pr");
    expect(body).toContain("centraid/issues/707");
  });
});
