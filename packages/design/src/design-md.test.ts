/**
 * Drift guard for the root DESIGN.md brief (#686).
 *
 * DESIGN.md is the machine-readable design brief handed to AI coding agents,
 * in the official google-labs-code/design.md format: YAML front matter carrying the tokens,
 * markdown body carrying the reasoning.
 *
 * Two gates guard it, and they check different things:
 *
 *   - `bun run lint:design-md` (@google/design.md) checks the file is a valid
 *     DESIGN.md — schema, resolvable `{token.refs}`, WCAG pairs, section order.
 *     It has no idea what Centraid's real tokens are.
 *   - this file checks the values are TRUE — every number and hex in the front
 *     matter is compared against the TypeScript source of truth, so the brief
 *     cannot silently rot when someone edits `palette.ts` / `radii.ts` /
 *     `density.ts` / `typography.ts` / `themes/*`.
 *
 * The front matter is parsed with a deliberately small hand parser (the shape
 * is ours, two levels deep, and we do not want a YAML dependency here just to
 * read a file we also write). The markdown body is still matched loosely: the
 * prose may be reformatted freely as long as the reasoning and the canonical
 * section order hold.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { paletteText } from "./color.js";
import { spacing } from "./density.js";
import { palette } from "./palette.js";
import { radii } from "./radii.js";
import { themes } from "./themes/index.js";
import { BRAND, EASE } from "./themes/shared.js";
import { fonts, type, typeSizeRungs } from "./typography.js";

const DESIGN_MD = fileURLToPath(new URL("../../../DESIGN.md", import.meta.url));
const doc = readFileSync(DESIGN_MD, "utf8");

/** Split the file into its YAML front matter and its markdown body. */
function split(source: string): { frontMatter: string; body: string } {
  const match = /^---\n(?<fm>[\s\S]*?)\n---\n(?<body>[\s\S]*)$/u.exec(source);
  if (!match?.groups) {
    throw new Error(
      "DESIGN.md has no YAML front matter — the spec requires it"
    );
  }
  return { body: match.groups.body ?? "", frontMatter: match.groups.fm ?? "" };
}

type Scalar = string;
type Group = Record<string, Scalar | Record<string, Scalar>>;

/**
 * Minimal parser for the two-level `key:` / `  key: value` / `    key: value`
 * shape this front matter uses. Comments, blank lines, and folded scalars
 * (`description: >-`) are skipped; quotes are stripped.
 */
function parseFrontMatter(fm: string): Record<string, Group | Scalar> {
  const out: Record<string, Group | Scalar> = {};
  let top: string | undefined;
  let mid: string | undefined;
  const unquote = (v: string): string => v.replace(/^["']|["']$/gu, "");

  let folded: string | undefined;

  for (const raw of fm.split("\n")) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) {
      continue;
    }
    // Continuation lines of a `key: >-` folded scalar are indented under it.
    if (folded !== undefined && /^\s/u.test(raw)) {
      out[folded] = `${(out[folded] as string) ?? ""}${raw.trim()} `;
      continue;
    }
    folded = undefined;
    const entry = /^(?<indent> *)(?<key>[^\s:#][^:]*):(?<rest>.*)$/u.exec(raw);
    if (!entry?.groups) {
      continue;
    }
    const indent = (entry.groups.indent ?? "").length;
    const key = unquote((entry.groups.key ?? "").trim());
    const value = (entry.groups.rest ?? "").trim();

    if (indent === 0) {
      top = key;
      mid = undefined;
      if (value === "") {
        out[key] = {};
      } else if (value.startsWith(">") || value.startsWith("|")) {
        folded = key;
        out[key] = "";
      } else {
        out[key] = unquote(value);
      }
    } else if (indent === 2 && top !== undefined) {
      const group = out[top];
      if (typeof group !== "object") {
        continue;
      }
      mid = key;
      group[key] = value === "" ? {} : unquote(value);
    } else if (indent === 4 && top !== undefined && mid !== undefined) {
      const group = out[top];
      if (typeof group !== "object") {
        continue;
      }
      const nested = group[mid];
      if (typeof nested === "object") {
        nested[key] = unquote(value);
      }
    }
  }
  return out;
}

const { body, frontMatter } = split(doc);
const fm = parseFrontMatter(frontMatter);

const group = (name: string): Group => {
  const value = fm[name];
  if (typeof value !== "object") {
    throw new Error(`DESIGN.md front matter is missing the \`${name}:\` group`);
  }
  return value;
};

const scalar = (g: Group, key: string): string => {
  const value = g[key];
  expect(value, `front-matter key \`${key}\` is missing`).toBeTypeOf("string");
  return value as string;
};

const nested = (g: Group, key: string): Record<string, Scalar> => {
  const value = g[key];
  expect(value, `front-matter group \`${key}\` is missing`).toBeTypeOf(
    "object"
  );
  return value as Record<string, Scalar>;
};

const colors = group("colors");
const typography = group("typography");
const rounded = group("rounded");
const spacingFm = group("spacing");

/** `bodyStrong` → `body-strong`, matching the front-matter token names. */
const kebab = (key: string): string =>
  key.replace(/(?<l>[a-z])(?<u>[A-Z])/gu, "$<l>-$<u>").toLowerCase();

describe("DESIGN.md front matter", () => {
  test("carries the spec's required identity fields", () => {
    expect(fm.version).toBe("alpha");
    expect(fm.name).toBe("Centraid");
    expect(fm.description).toContain("packages/design/src");
  });

  test("brand hex matches themes/shared.ts", () => {
    expect(scalar(colors, "brand")).toBe(BRAND);
    expect(scalar(colors, "accent")).toBe(BRAND);
    // `primary` is the spec's expected name; ours is an alias, not a 2nd brand.
    expect(scalar(colors, "primary")).toBe("{colors.brand}");
  });

  test("accent ramp hexes match the shipped light theme", () => {
    expect(scalar(colors, "accent-light")).toBe(themes.light.accentLight);
    expect(scalar(colors, "accent-deep")).toBe(themes.light.accentDeep);
    // The filled rung takes opposite halves of the `--text-inv` pair per
    // theme, so the brief carries both — the dark one is not a derivation of
    // the light one and a checker cannot infer it.
    expect(scalar(colors, "accent-deep-dark")).toBe(themes.dark.accentDeep);
    expect(scalar(colors, "accent-midnight")).toBe(themes.light.accentMidnight);
    expect(scalar(colors, "accent-text")).toBe(themes.light.accentText);
  });

  test("semantic state colors match both ramps", () => {
    expect(scalar(colors, "success")).toBe(themes.light.success);
    expect(scalar(colors, "success-dark")).toBe(themes.dark.success);
    // `danger` used to be one shared literal. It cannot be: the two ramps pull
    // the solve in opposite directions (deepen under a near-white surface,
    // lift under a near-black one), which is exactly why the single `#C44A4A`
    // measured 3.74:1 on dark `--bg-elev`. Both halves are written out, the
    // same way `success` / `success-dark` are.
    expect(scalar(colors, "danger")).toBe(themes.light.danger);
    expect(scalar(colors, "danger-dark")).toBe(themes.dark.danger);
    expect(scalar(colors, "danger")).not.toBe(scalar(colors, "danger-dark"));
    expect(scalar(colors, "warning")).toBe(themes.light.warning);
    expect(scalar(colors, "warning-dark")).toBe(themes.dark.warning);
  });

  test("every palette hue is carried as `c-<name>`, and nothing extra", () => {
    for (const [name, hex] of Object.entries(palette)) {
      expect(scalar(colors, `c-${name}`)).toBe(hex);
    }
    const listed = Object.keys(colors)
      .filter((k) => k.startsWith("c-") && !k.includes("-text"))
      .map((k) => k.slice(2));
    expect(listed.sort()).toStrictEqual(Object.keys(palette).sort());
    // and the prose still names them alongside their hexes
    for (const [name, hex] of Object.entries(palette)) {
      expect(body, `${name} missing from the Colors prose`).toContain(
        `${name} ${hex}`
      );
    }
  });

  test("every palette hue's solved TEXT rung is carried, per theme", () => {
    // The fills above are theme-independent; this rung is not, and neither
    // half is derivable from the other by a checker reading the file — so both
    // are written out, the same way `success` / `success-dark` are.
    for (const [name, hex] of Object.entries(paletteText.light)) {
      expect(scalar(colors, `c-${name}-text`), `c-${name}-text`).toBe(hex);
    }
    for (const [name, hex] of Object.entries(paletteText.dark)) {
      expect(scalar(colors, `c-${name}-text-dark`), `c-${name}-text-dark`).toBe(
        hex
      );
    }
    const listed = Object.keys(colors).filter(
      (k) => k.startsWith("c-") && k.includes("-text")
    );
    expect(listed).toHaveLength(Object.keys(palette).length * 2);
    // and the prose still carries the measured grid, not just the values —
    // the whole point of the rung is the number beside it.
    for (const name of Object.keys(palette)) {
      // The prose carries one table row per hue: both halves plus the ratios
      // they were measured at. Column padding is the formatter's business, so
      // the row is matched by its contents rather than its spacing.
      const row = body
        .split("\n")
        .filter(
          (line) => line.includes(`\`--c-${name}\``) && line.includes("|")
        )
        .join("\n");
      expect(row, `--c-${name} has no row in the Colors prose`).not.toBe("");
      expect(row).toContain(paletteText.light[name as keyof typeof palette]);
      expect(row).toContain(paletteText.dark[name as keyof typeof palette]);
    }
    expect(body).toContain("--c-<name>-text");
  });

  test("light-theme surfaces and ink match themes/centraid.ts", () => {
    for (const [token, value] of [
      ["light-bg", themes.light.bg],
      ["light-bg-app", themes.light.bgApp],
      ["light-bg-elev", themes.light.bgElev],
      ["light-bg-sunken", themes.light.bgSunken],
      ["light-text", themes.light.text],
      ["light-text-soft", themes.light.textSoft],
      ["light-text-faint", themes.light.textFaint],
      ["light-text-ghost", themes.light.textGhost],
      ["light-text-inv", themes.light.textInv],
      ["light-line", themes.light.line],
      ["light-line-strong", themes.light.lineStrong],
    ] as const) {
      expect(scalar(colors, token), token).toBe(value);
    }
  });

  test("dark-theme ink matches, and its surfaces resolve the --bg-l anchor", () => {
    for (const [token, value] of [
      ["dark-text", themes.dark.text],
      ["dark-text-soft", themes.dark.textSoft],
      ["dark-text-faint", themes.dark.textFaint],
      ["dark-text-ghost", themes.dark.textGhost],
      ["dark-text-inv", themes.dark.textInv],
      ["dark-line", themes.dark.line],
      ["dark-line-strong", themes.dark.lineStrong],
    ] as const) {
      expect(scalar(colors, token), token).toBe(value);
    }
    // Dark surfaces are `hsl(0 0% calc(var(--bg-l) ± n))`; a contrast checker
    // cannot read a var(), so the front matter carries them resolved. Pin the
    // anchor those hexes were resolved from.
    const anchor = themes.dark.bgL;
    expect(anchor).toBeDefined();
    expect(body).toContain(`--bg-l: ${anchor}`);
    const lightness = Number(String(anchor).replace("%", "")) / 100;
    const channel = Math.round(lightness * 255);
    const hex = `#${channel.toString(16).padStart(2, "0").repeat(3)}`;
    expect(scalar(colors, "dark-bg").toLowerCase()).toBe(hex);
  });

  test("every spacing rung is carried, in order, with its px unit", () => {
    const rungs = Object.entries(spacing);
    expect(Object.keys(spacingFm)).toStrictEqual(rungs.map(([k]) => k));
    for (const [key, value] of rungs) {
      expect(scalar(spacingFm, key), `--sp-${key}`).toBe(`${value}px`);
    }
    // the prose still states the whole scale on one line
    expect(body).toContain(rungs.map(([, v]) => v).join(" · "));
    expect(body).toContain(`--sp-${rungs.length}`);
  });

  test("every radius step is carried with its px unit", () => {
    for (const [key, value] of Object.entries(radii)) {
      expect(scalar(rounded, key), `--r-${key}`).toBe(`${value}px`);
    }
    expect(Object.keys(rounded).sort()).toStrictEqual(
      Object.keys(radii).sort()
    );
    for (const [key, value] of Object.entries(radii)) {
      expect(body).toMatch(new RegExp(`--r-${key}\`\\s*${value}\\b`, "u"));
    }
  });

  test("the type scale carries each role's size, line-height, weight, face", () => {
    for (const [key, style] of Object.entries(type)) {
      const role = nested(typography, kebab(key));
      expect(role.fontSize, `${key} fontSize`).toBe(`${style.size}px`);
      expect(role.lineHeight, `${key} lineHeight`).toBe(
        `${style.lineHeight}px`
      );
      expect(role.fontWeight, `${key} fontWeight`).toBe(style.weight);
      expect(role.fontFamily, `${key} fontFamily`).toBe(fonts[style.family]);
    }
    expect(Object.keys(typography).sort()).toStrictEqual(
      Object.keys(type).map(kebab).sort()
    );
  });
});

describe("DESIGN.md body", () => {
  test("uses the spec's canonical section order", () => {
    const canonical = [
      "Overview",
      "Colors",
      "Typography",
      "Layout",
      "Elevation & Depth",
      "Shapes",
      "Components",
      "Do's and Don'ts",
    ];
    const present = [...body.matchAll(/^## (?<title>.+)$/gmu)].map((m) =>
      (m.groups?.title ?? "").trim()
    );
    expect(present).toStrictEqual(canonical);
  });

  test("points at the deeper docs it defers to", () => {
    expect(body.length).toBeGreaterThan(1000);
    expect(body).toContain("docs/traps/design-tokens.md");
    expect(body).toContain("packages/design/src/contract.ts");
    expect(body).toContain("google-labs-code/design.md");
    expect(body).toContain("lint:design-md");
  });

  test("the type scale prose restates each role's size and weight", () => {
    for (const [key, style] of Object.entries(type)) {
      const token = `--t-${kebab(key)}`;
      const line = body
        .split("\n")
        .filter((l) => l.includes(token))
        .join("\n");
      expect(line, `${token} missing from DESIGN.md prose`).not.toBe("");
      expect(line).toContain(`${style.size} / ${style.lineHeight}`);
      expect(line).toContain(style.weight);
    }
  });

  test("the composable size rungs are documented with their values", () => {
    const rungs = typeSizeRungs(type);
    for (const [name, value] of Object.entries(rungs)) {
      const line = body
        .split("\n")
        .filter((l) => l.includes(`\`${name}\``))
        .join("\n");
      expect(line, `${name} missing from DESIGN.md prose`).not.toBe("");
      expect(line, name).toContain(value);
    }
    // The dedupe is the point: a rung the emitters do not publish would send
    // authors at a name that resolves to nothing, so the prose has to say so
    // rather than leave the gap unexplained.
    expect(rungs["--t-body-strong-size"]).toBeUndefined();
    expect(body).toMatch(/`--t-body-strong-size` does not exist/u);
    // …and the reason the shorthands cannot cover this case is stated, not
    // left for the reader to rediscover.
    expect(body).toMatch(/all-or-nothing/u);
    expect(body).toMatch(/no line-height rungs/u);
  });

  test("the easing curve is quoted verbatim", () => {
    const line = body
      .split("\n")
      .filter((l) => l.includes("--ease"))
      .join("\n");
    expect(line).toContain(EASE);
    expect(body).toContain("200ms");
  });

  test("states roles-not-families and the system stacks", () => {
    expect(body).toContain(fonts.sans);
    expect(body).toContain(fonts.mono);
    expect(body).toMatch(/Roles, not families/u);
  });

  test("carries the reasoning, not just the values", () => {
    expect(body).toContain("Field notebook");
    expect(body).toContain("instrument, not a pillow");
    expect(body).toMatch(/Neutrals do the work/u);
    expect(body).toMatch(/measured, not eyeballed/u);
  });
});
