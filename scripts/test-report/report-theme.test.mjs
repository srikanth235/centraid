import { describe, expect, test } from "vitest";

import { designSystemCss, REPORT_CSS, verifySheet } from "./report-theme.mjs";
import { renderFixture } from "./smoke.mjs";

const AUTHORED = REPORT_CSS;

function live(css) {
  return css.replaceAll(/\/\*[\s\S]*?\*\//gu, "");
}

function declared(css) {
  return new Set(
    [...css.matchAll(/(?<name>--[a-zA-Z0-9-]+)\s*:/gu)].map(
      (hit) => hit.groups?.name ?? ""
    )
  );
}

function referenced(css) {
  return new Set(
    [...css.matchAll(/var\(\s*(?<name>--[a-zA-Z0-9-]+)/gu)].map(
      (hit) => hit.groups?.name ?? ""
    )
  );
}

function blocks(css, query = "") {
  const found = [];
  let cursor = 0;
  while (cursor < css.length) {
    const open = css.indexOf("{", cursor);
    if (open === -1) break;
    const selector = css.slice(cursor, open).trim();
    let depth = 1;
    let close = open + 1;
    while (close < css.length && depth > 0) {
      if (css[close] === "{") depth += 1;
      else if (css[close] === "}") depth -= 1;
      close += 1;
    }
    const body = css.slice(open + 1, close - 1);
    if (selector.startsWith("@media")) {
      found.push(...blocks(body, `${query} ${selector}`));
    } else if (!selector.startsWith("@")) {
      found.push({ body, query, selector });
    }
    cursor = close;
  }
  return found;
}

function themeTokens(theme) {
  const values = new Map();
  for (const { body, query, selector } of blocks(live(designSystemCss()))) {
    const darkQuery = query.includes("prefers-color-scheme: dark");
    const darkPin = /^(?::root)?\[data-theme=['"]dark['"]\]/u.test(selector);
    const lightPin = /^(?::root)?\[data-theme=['"]light['"]\]/u.test(selector);
    const unscoped = !darkQuery && !darkPin && !lightPin;
    const applies =
      theme === "light"
        ? unscoped || lightPin
        : unscoped || darkPin || darkQuery;
    if (!applies) continue;
    for (const hit of body.matchAll(
      /(?<name>--[\w-]+)\s*:\s*(?<value>[^;]+);/gu
    )) {
      values.set(hit.groups?.name ?? "", (hit.groups?.value ?? "").trim());
    }
  }
  return values;
}

const THEMES = { dark: themeTokens("dark"), light: themeTokens("light") };

function literal(theme, name) {
  let value = THEMES[theme].get(name);
  for (let hop = 0; hop < 12 && value !== undefined; hop += 1) {
    const alias = /^var\(\s*(?<name>--[\w-]+)\s*\)$/u.exec(value);
    if (!alias) return value;
    value = THEMES[theme].get(alias.groups?.name ?? "");
  }
  return null;
}

function channel(byte) {
  const ratio = byte / 255;
  return ratio <= 0.040_45 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const digits = /^#(?<hex>[0-9a-fA-F]{6})$/u.exec(hex.trim())?.groups?.hex;
  if (!digits) throw new Error(`not a hex colour: ${hex}`);
  const packed = Number.parseInt(digits, 16);
  return (
    0.2126 * channel((packed >> 16) & 255) +
    0.7152 * channel((packed >> 8) & 255) +
    0.0722 * channel(packed & 255)
  );
}

function contrast(one, other) {
  const [bright, dim] = [luminance(one), luminance(other)].sort(
    (left, right) => right - left
  );
  return (bright + 0.05) / (dim + 0.05);
}

function rung(value) {
  return /^var\(\s*(?<name>--[\w-]+)\s*\)$/u.exec(value ?? "")?.groups?.name;
}

const REGISTER = {
  ".cell.degraded": {
    fact: "over budget, or outside its noise band",
    family: "the promise degraded",
  },
  ".cell.failed": {
    fact: "the lane falsified its claim tonight",
    family: "the run went wrong",
  },
  ".cell.na": {
    fact: "the claim cannot arise here",
    family: "the claim cannot arise here",
  },
  ".cell.no-evidence": {
    fact: "the lane wrote nothing for this candidate",
    family: "the evidence is absent",
  },
  ".cell.parked": {
    fact: "red, with an expiry and an issue against it",
    family: "the failure has a date on it",
  },
  ".cell.passed": {
    fact: "the lane ran and the claim held",
    family: "the claim held",
  },
};

const WORD_SEPARATED = [];

const SEMANTIC_STATES = {
  "nw:absent": ["--nw-grey", "--nw-greybg"],
  "nw:attention": ["--nw-attn", "--nw-attnbg"],
  "nw:bug": ["--nw-bug", "--nw-bugbg"],
  "nw:failed": ["--nw-danger", "--nw-dangerbg"],
  "nw:parked": ["--nw-park", "--nw-parkbg"],
  "nw:gap": ["--nw-gap", "--nw-gapbg"],
  "nw:partial": ["--nw-partial", "--nw-partialbg"],
  "nw:passed": ["--nw-ok", "--nw-okbg"],
  "st:absent": ["--st-absent", "--st-absent-text"],
  "st:degraded": ["--st-degraded", "--st-degraded-text"],
  "st:failed": ["--st-failed", "--st-failed-text"],
  "st:flaky": ["--st-flaky", "--st-flaky-text"],
  "st:gap": ["--st-gap", "--st-gap-text"],
  "st:missing": ["--st-missing", "--st-missing-text"],
  "st:na": ["--st-na", "--st-na-text"],
  "st:partial": ["--st-partial", "--st-partial-text"],
  "st:pinned": ["--st-pinned"],
  "st:s1": ["--st-s1"],
  "st:s2": ["--st-s2"],
  "st:s3": ["--st-s3"],
  "st:s4": ["--st-s4"],
  "st:silent": ["--st-silent", "--st-silent-text"],
  "st:solid": ["--st-solid", "--st-solid-text"],
  "st:unmatched": ["--st-unmatched", "--st-unmatched-text"],
};

const DELIBERATE_ALIASES = [
  ["nw:failed", "st:failed", "st:s1"],
  ["st:s3", "st:silent"],
];

function modifiers(selector) {
  return new Set(selector.split(".").filter(Boolean).slice(1));
}

const CELL_RULES = [
  ...live(REPORT_CSS).matchAll(/(?<selectors>[^{}]+)\{(?<body>[^}]*)\}/gu),
]
  .flatMap((hit) =>
    (hit.groups?.selectors ?? "")
      .split(",")
      .map((selector) => selector.trim())
      .filter((selector) => /^\.cell(?:\.[\w-]+)*$/u.test(selector))
      .map((selector) => ({ body: hit.groups?.body ?? "", selector }))
  )
  .map((rule, order) => ({ ...rule, order }));

function effective(selector) {
  const own = modifiers(selector);
  const applied = CELL_RULES.filter((rule) =>
    [...modifiers(rule.selector)].every((name) => own.has(name))
  ).sort(
    (a, b) =>
      modifiers(a.selector).size - modifiers(b.selector).size ||
      a.order - b.order
  );
  const declarations = {};
  for (const rule of applied) {
    for (const hit of rule.body.matchAll(
      /(?<property>[\w-]+)\s*:\s*(?<value>[^;]+)/gu
    )) {
      declarations[hit.groups?.property ?? ""] = (
        hit.groups?.value ?? ""
      ).trim();
    }
  }
  return declarations;
}

describe("the generated design-system sheet", () => {
  test("carries the product's tokens and the report's status ramp", () => {
    const css = designSystemCss();
    expect(css).toContain("--font-sans:");
    expect(css).toContain("--t-display:");
    expect(css).toContain("--st-solid:");
    expect(css).toContain("--st-on-fill:");
  });

  test("inlines every bundled face rather than linking it", () => {
    const css = designSystemCss();
    const sources = [...css.matchAll(/src:\s*url\((?<href>[^)]*)/gu)].map(
      (hit) => hit.groups?.href ?? ""
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source.startsWith("data:font/woff2;base64,")).toBe(true);
    }
  });

  test("refuses a sheet whose ramp or face is gone", () => {
    expect(() => verifySheet("--font-sans: x;", "fixture")).toThrow(
      /--st-solid/u
    );
    expect(() =>
      verifySheet(
        "--font-sans: x;--st-solid: y;@font-face{src: url(fonts/a.woff2)}",
        "fixture"
      )
    ).toThrow(/links a face/u);
    expect(verifySheet(designSystemCss(), "fixture")).toBeTruthy();
  });

  test("declares both themes, and follows the system when neither is pinned", () => {
    const css = designSystemCss();
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toMatch(/\[data-theme=['"]dark['"]\]/u);
    expect(css).toMatch(/\[data-theme=['"]light['"]\]/u);
    expect(css).toContain(":root:not([data-theme])");
  });
});

describe("the layers the report authors", () => {
  test("declare no colour of their own", () => {
    expect(live(AUTHORED).match(/#[0-9a-fA-F]{6}\b/gu)).toBeNull();
  });

  test("name no face outside the two token stacks", () => {
    for (const hit of live(AUTHORED).matchAll(
      /font-family\s*:\s*(?<value>[^;}]+)/gu
    )) {
      expect((hit.groups?.value ?? "").trim()).toMatch(
        /^(?:inherit|var\(\s*--font-(?:sans|code)\s*\))$/u
      );
    }
    expect(live(AUTHORED)).not.toMatch(/\bInter\b\s*,/u);
  });

  test("reference only tokens the generated sheet declares", () => {
    const resolvable = declared(designSystemCss());
    const unresolved = [...referenced(live(AUTHORED))].filter(
      (name) => !resolvable.has(name)
    );
    expect(unresolved).toEqual([]);
  });

  test("paints one tint per meaning, across every grid on the page", () => {
    const backgrounds = new Map();
    for (const [selector, { family }] of Object.entries(REGISTER)) {
      const value = effective(selector).background;
      expect(value, `${selector} paints no background`).toBeTruthy();
      backgrounds.set(value, (backgrounds.get(value) ?? new Set()).add(family));
    }
    const doubled = [...backgrounds]
      .filter(([, meanings]) => meanings.size > 1)
      .map(([value, meanings]) => [value, [...meanings].sort()]);
    expect(doubled).toEqual([]);
    const tints = new Map();
    for (const [selector, { family }] of Object.entries(REGISTER)) {
      tints.set(
        family,
        (tints.get(family) ?? new Set()).add(effective(selector).background)
      );
    }
    expect(
      [...tints].filter(([, values]) => values.size > 1).map(([name]) => name)
    ).toEqual([]);
  });

  test("separates two states inside a family, or says why it does not", () => {
    const treatments = new Map(
      Object.keys(REGISTER).map((selector) => [
        selector,
        JSON.stringify(effective(selector)),
      ])
    );
    for (const [left, leftBody] of treatments) {
      for (const [right, rightBody] of treatments) {
        if (left >= right) continue;
        const oneTreatment =
          REGISTER[left].fact === REGISTER[right].fact ||
          WORD_SEPARATED.some(
            (pair) => pair.includes(left) && pair.includes(right)
          );
        expect(
          leftBody === rightBody,
          oneTreatment
            ? `${left} and ${right} say the same thing and must be drawn the same`
            : `${left} and ${right} state different facts and must be drawn differently`
        ).toBe(oneTreatment);
      }
    }
  });

  test("registers every cell class the layer paints", () => {
    const painted = new Set(
      [...live(REPORT_CSS).matchAll(/\.cell(?<mods>(?:\.[\w-]+)+)/gu)].map(
        (hit) => `.cell${hit.groups?.mods ?? ""}`
      )
    );
    expect([...painted].sort()).toEqual(Object.keys(REGISTER).sort());
  });
});

describe("the Night Watch palette", () => {
  test("clears 4.5:1 for every word on its own tint, in both themes", () => {
    const checked = [];
    for (const selector of Object.keys(REGISTER)) {
      const paint = effective(selector);
      const ink = rung(paint.color);
      const tint =
        paint.background === "transparent"
          ? "--nw-ground"
          : rung(paint.background);
      expect(ink, `${selector} inks in a literal, not a rung`).toBeTruthy();
      expect(tint, `${selector} tints in a literal, not a rung`).toBeTruthy();
      for (const theme of ["light", "dark"]) {
        const ratio = contrast(literal(theme, ink), literal(theme, tint));
        expect(
          ratio,
          `${selector} reads at ${ratio.toFixed(2)}:1 in ${theme}`
        ).toBeGreaterThanOrEqual(4.5);
        checked.push(ratio);
      }
    }
    expect(checked).toHaveLength(Object.keys(REGISTER).length * 2);
  });

  test("gives no two semantic states the same literal, in either theme", () => {
    for (const theme of ["light", "dark"]) {
      const owners = new Map();
      for (const [state, names] of Object.entries(SEMANTIC_STATES)) {
        for (const name of names) {
          const value = literal(theme, name)?.toLowerCase();
          expect(value, `${name} resolves to nothing in ${theme}`).toBeTruthy();
          owners.set(value, (owners.get(value) ?? new Set()).add(state));
        }
      }
      const shared = [...owners]
        .filter(([, states]) => states.size > 1)
        .map(([value, states]) => [value, [...states].sort()]);
      const allowed = DELIBERATE_ALIASES.map((group) => group.join(" · "));
      for (const [value, states] of shared) {
        expect(
          allowed,
          `${states.join(" and ")} all resolve to ${value} in ${theme}`
        ).toContain(states.join(" · "));
      }
      expect(shared.map(([, states]) => states.join(" · ")).sort()).toEqual(
        [...allowed].sort()
      );
    }
  });

  test("catches a collision when there is one to catch", () => {
    const collided = new Map([
      ["attn", "#B4441F"],
      ["gap", "#B4441F"],
    ]);
    const owners = new Map();
    for (const [state, value] of collided) {
      owners.set(value, (owners.get(value) ?? new Set()).add(state));
    }
    expect([...owners].filter(([, states]) => states.size > 1)).toHaveLength(1);
  });
});

describe("the rendered page", () => {
  test("resolves every token it references and names no withdrawn face", async () => {
    const { html } = await renderFixture();
    const style =
      /<style>(?<css>[\s\S]*?)<\/style>/u.exec(html)?.groups?.css ?? "";
    expect(style.length).toBeGreaterThan(0);
    const resolvable = declared(style);
    const unresolved = [...referenced(live(style))].filter(
      (name) => !resolvable.has(name)
    );
    expect(unresolved).toEqual([]);
    expect(style).not.toMatch(/\bInter\b\s*,/u);
    expect(style).not.toMatch(/url\((?!data:)/u);
  });
});
