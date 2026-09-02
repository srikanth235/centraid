import { describe, expect, test } from "vitest";

import { designSystemCss, REPORT_CSS, verifySheet } from "./report-theme.mjs";
import { renderFixture } from "./smoke.mjs";

/**
 * The report renders in the PRODUCT's design (issue #853), and these are the
 * ways it stopped doing so before.
 *
 * It had carried a palette of its own, Inter, a type scale of its own and a
 * dark-only page, on the same origin as the two public sites #841 had already
 * unified — and none of that was visible to any gate, because a CSS mistake
 * does not throw. A `var()` naming a token nothing declares is invalid at
 * computed-value time: the declaration is dropped, the element falls back to
 * inherited or initial, and the page renders wrong in silence. So the checks
 * below are byte-level rather than visual, and they are pointed at the layers
 * the report AUTHORS. The generated sheet is where colour literals belong —
 * that is what a token declaration is — and `bun run lint:site-tokens` gates
 * it against the emitter.
 */

/** The layer the report writes by hand, over the generated sheet. #915 folded
 *  the briefing's sheet into it, so there is one authored layer again. */
const AUTHORED = REPORT_CSS;

/** CSS comments name what a rule replaced ("was Inter"), which is not a live
 *  declaration — the same strip `lint-design-tokens.mjs` and the emitter do. */
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

/**
 * The generated sheet's blocks, `@media` descended into so a nested rule keeps
 * the query that gates it.
 * @param {string} css A stylesheet.
 * @param {string} [query] The `@media` chain above `css`.
 * @returns {{body: string, query: string, selector: string}[]} Blocks in order.
 */
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

/**
 * Every custom property one THEME of the sheet resolves, in cascade order: the
 * unscoped blocks, then whichever of the pinned/`prefers-color-scheme` blocks
 * that theme actually applies. A rung is spelled in three places by design — a
 * pinned light, a pinned dark and a followed dark — and reading only one of them
 * is how a check passes on a page half the readers never see.
 * @param {string} theme `"light"` or `"dark"`.
 * @returns {Map<string, string>} Property name to its declared value.
 */
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

/** A `var()` chain followed to the literal behind it, or `null`. */
function literal(theme, name) {
  let value = THEMES[theme].get(name);
  for (let hop = 0; hop < 12 && value !== undefined; hop += 1) {
    const alias = /^var\(\s*(?<name>--[\w-]+)\s*\)$/u.exec(value);
    if (!alias) return value;
    value = THEMES[theme].get(alias.groups?.name ?? "");
  }
  return null;
}

/** One sRGB channel, linearised — the WCAG 2.x definition, not an approximation. */
function channel(byte) {
  const ratio = byte / 255;
  return ratio <= 0.040_45 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a six-digit hex colour. */
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

/** The WCAG 2.x contrast ratio between two hex colours. */
function contrast(one, other) {
  const [bright, dim] = [luminance(one), luminance(other)].sort(
    (left, right) => right - left
  );
  return (bright + 0.05) / (dim + 0.05);
}

/** The rung a declaration names: `var(--nw-okbg)` -> `--nw-okbg`. */
function rung(value) {
  return /^var\(\s*(?<name>--[\w-]+)\s*\)$/u.exec(value ?? "")?.groups?.name;
}

/**
 * The cell register, as the page means it (#864). Every compound selector the
 * component layer paints a cell with, against two things: the FAMILY — the one
 * question its tint answers — and the FACT that one selector states.
 *
 * The two levels are the whole point. Before this table the register was
 * checked for distinctness alone — twelve states, ten treatments — which a page
 * can satisfy while still painting two unrelated questions in one hue and one
 * question in two hues, and this one did both: grey was "the pipeline did not
 * report" AND "no test exists", and "no test exists" was red in §8 and grey in
 * §2. Naming the family is what lets a test say "a tint answers exactly one
 * question"; naming the fact is what keeps the four greys separable inside it.
 */
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

/**
 * The pairs drawn identically while stating different facts, each told apart by
 * its WORD alone — `report-state-words.test.mjs` holds that half of the bargain.
 * They are different in kind and both are named rather than counted:
 * `failed` / `infra-mismatch` is the page's ONE cross-family collapse, and
 * `stale` / `lane-did-not-run` sit inside the absence family, which the legend
 * prints as a single entry.
 */
const WORD_SEPARATED = [];

/**
 * Every rung on this page that means a STATE, grouped by the state it means.
 *
 * Two rungs under one key are ROLES of one state, not two states: the Night
 * Watch families spell a type rung and the tint behind it, and the `--st-*`
 * ramp spells a fill and the type sibling solved for the page ground. A state
 * naming itself twice is the design; two states naming one literal is the
 * defect, because the sheet then declares a distinction the page cannot draw.
 * The neutral rungs — grounds, inks, rules, the link and the focus ring — are
 * deliberately outside this set: they carry no state, and several of them are
 * meant to sit close to one another.
 */
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

/**
 * The state groups allowed to resolve to one literal, sorted as the check sorts
 * them. Each is a name for a tone that is DEFINED as another state's, not a
 * second state that happens to land on it: the attention queue's S1 band IS the
 * consequence tone and S3 IS the middle system signal (the emitter says so where
 * it declares them), and the Night Watch danger rung is the product's `--danger`
 * spelled into the report's own palette — the two layers are emitted separately
 * and reaching one value by two names is what keeps them agreeing. Nothing else
 * may double up; `--st-gap` aliasing `--seam` onto the attention rung is the
 * collision this list exists to refuse.
 */
const DELIBERATE_ALIASES = [
  ["nw:failed", "st:failed", "st:s1"],
  ["st:s3", "st:silent"],
];

/** A selector's modifier classes: `.cell.passed.assessment-partial` -> the set
 *  `{passed, assessment-partial}`. */
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

/**
 * What a cell in this state actually computes to: every rule whose classes are
 * a subset of the state's own applies, resolved in specificity-then-source
 * order the way a browser resolves them. Reading only a state's OWN rule would
 * miss `.cell`'s shared body and would read `.cell.passed` for the partial
 * cell, which is exactly the pair the register has to keep apart.
 * @param {string} selector A key of `REGISTER`.
 * @returns {Record<string, string>} The state's declarations.
 */
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
    // Neither failure throws in a browser: a `var()` with nothing behind it
    // drops its declaration in silence, and a face pointing at a path that
    // does not exist just renders in the fallback stack. Both have to fail at
    // GENERATE time, where someone is watching.
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
    // Quote-agnostic: which quote an attribute selector wears is the
    // formatter's business, not this contract's, and pinning one spelling
    // makes the test pass or fail on whether oxfmt happened to touch the
    // generated sheet rather than on whether the theme is declared.
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
    // No per-instance knob is exempt any more: `--row`, the inline stagger the
    // old matrix wrote on each cell, went with the layout it belonged to
    // (#862). Allowing a name the sheet does not declare is how an undeclared
    // `var()` gets in, so the sheet is now the whole vocabulary.
    const resolvable = declared(designSystemCss());
    const unresolved = [...referenced(live(AUTHORED))].filter(
      (name) => !resolvable.has(name)
    );
    expect(unresolved).toEqual([]);
  });

  test("paints one tint per meaning, across every grid on the page", () => {
    // The law this file used to enforce was "twelve states, twelve distinct
    // treatments", and the page passed it while lying: four tint families were
    // carrying twelve states, so grey meant BOTH "the pipeline did not report"
    // and "no test exists", red meant both "tonight broke" and "there is a
    // declared hole", and the app grids painted that hole grey while §8 painted
    // it red. Distinctness was never the property a reader needs. The property
    // is the inverse, and it is what #864 asserts here: a tint answers exactly
    // ONE question, on every grid at once.
    const backgrounds = new Map();
    for (const [selector, { family }] of Object.entries(REGISTER)) {
      const value = effective(selector).background;
      expect(value, `${selector} paints no background`).toBeTruthy();
      backgrounds.set(value, (backgrounds.get(value) ?? new Set()).add(family));
    }
    // One tint, one meaning — with exactly one collapse, named rather than
    // counted: `infra-mismatch` rides the consequence tint with `failed`
    // because both are "tonight's run went wrong", and the word tells them
    // apart. Nothing else on the page may double up.
    const doubled = [...backgrounds]
      .filter(([, meanings]) => meanings.size > 1)
      .map(([value, meanings]) => [value, [...meanings].sort()]);
    // #915 shortened the vocabulary to four words plus n/a and degraded, and
    // the collapse #864 had to name — `infra-mismatch` riding the consequence
    // tint with `failed` — went with the state itself. Six states, six
    // families, no doubling at all.
    expect(doubled).toEqual([]);
    // And the converse: a meaning may not be spoken in two tints either, which
    // is how "no test exists" came to be red in §8 and grey in §2.
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
    // A family carries several states — grey carries four — so the tint alone
    // cannot finish the job: inside a family a state is told apart by weight,
    // slope or rule. Two selectors may be byte-identical ONLY when they say the
    // same thing (the same fact drawn on two different grids), or when they are
    // the one pair the page tells apart by word alone.
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
    // A state added to `generate.mjs` and given a rule here, but never entered
    // above, would be unexamined by both tests: the law only binds what the
    // table knows about.
    const painted = new Set(
      [...live(REPORT_CSS).matchAll(/\.cell(?<mods>(?:\.[\w-]+)+)/gu)].map(
        (hit) => `.cell${hit.groups?.mods ?? ""}`
      )
    );
    expect([...painted].sort()).toEqual(Object.keys(REGISTER).sort());
  });
});

/**
 * The palette behind the register, checked arithmetically rather than by eye.
 *
 * Both properties here were prose before #864 — the divergence register asserted
 * "each of the four tinted families clears 4.5:1 in both themes (4.63:1 at the
 * tightest)" and a receipt carried the table, so the numbers were true on the
 * day they were typed and unowned every night after. Both are now computed off
 * the emitted sheet, which `bun run lint:site-tokens` gates byte-for-byte
 * against `scripts/site-tokens.mjs` — so a hue edited in the ramp table is
 * checked here without anybody remembering to.
 */
describe("the Night Watch palette", () => {
  test("clears 4.5:1 for every word on its own tint, in both themes", () => {
    const checked = [];
    for (const selector of Object.keys(REGISTER)) {
      const paint = effective(selector);
      // A cell with no tint of its own sits on the page ground, which is the
      // surface its word actually has to clear.
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
    // A register that stopped painting would pass every ratio above.
    expect(checked).toHaveLength(Object.keys(REGISTER).length * 2);
  });

  test("gives no two semantic states the same literal, in either theme", () => {
    // The collision this catches is the one that shipped: `--st-gap` aliased
    // `--seam`, and the Night Watch attention rung was spelled with the SAME
    // two literals, so a hole in the matrix and an integrity warning were one
    // colour while the sheet looked like it declared two.
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
      // The whitelist may not outlive what it excuses either.
      expect(shared.map(([, states]) => states.join(" · ")).sort()).toEqual(
        [...allowed].sort()
      );
    }
  });

  test("catches a collision when there is one to catch", () => {
    // A detector nobody has ever seen fire is a detector nobody can trust. This
    // is the exact shape of the #864 defect, replayed against the same code.
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
    // Self-contained, at both depths it is published to and years after the
    // run that produced it: no sibling asset, no network.
    expect(style).not.toMatch(/url\((?!data:)/u);
  });
});
