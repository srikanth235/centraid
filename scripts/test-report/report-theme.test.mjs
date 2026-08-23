import { describe, expect, test } from "vitest";

import { BRIEFING_CSS } from "./render-briefing.mjs";
import { makeFixtureRoot, runGenerate } from "./report-fixture-root.mjs";
import { designSystemCss, REPORT_CSS, verifySheet } from "./report-theme.mjs";

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

/** The two layers the report writes by hand, over the generated sheet. */
const AUTHORED = `${REPORT_CSS}\n${BRIEFING_CSS}`;

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
    // `--row` is the one per-instance knob: the markup writes it inline on the
    // cell to stagger a matrix row's entry, so it is declared where it is used.
    const resolvable = declared(designSystemCss()).add("--row");
    const unresolved = [...referenced(live(AUTHORED))].filter(
      (name) => !resolvable.has(name)
    );
    expect(unresolved).toEqual([]);
  });

  test("give every matrix state a treatment of its own", () => {
    // Absence has to stay CLASSIFIED, not merely visible: twelve states that
    // collapsed onto one grey would still render, and the page would quietly
    // stop answering the question it exists to answer. Each state's treatment
    // is everything that applies to it — the shared trough rule and its own
    // tone together — so a state is only distinct once the two are merged.
    const rules = [
      ...live(REPORT_CSS).matchAll(/(?<selectors>[^{}]+)\{(?<body>[^}]*)\}/gu),
    ].map((hit) => ({
      body: hit.groups?.body ?? "",
      selectors: hit.groups?.selectors ?? "",
    }));
    const treatments = new Map();
    for (const state of [
      "passed",
      "failed",
      "flaky",
      "skipped",
      "gap",
      "evidence-unmatched",
      "owner-silent",
      "missing",
      "stale",
      "lane-did-not-run",
      "expected-grey",
      "infra-mismatch",
    ]) {
      const own = new RegExp(`\\.cell\\.${state}(?![\\w-])`, "u");
      const applied = rules
        .filter((rule) => own.test(rule.selectors))
        .map((rule) => rule.body);
      expect(applied, `no .cell.${state} rule`).not.toEqual([]);
      treatments.set(state, applied.join(";"));
    }
    // Two pairs deliberately share a treatment, and each is named here rather
    // than absorbed by a loose count: `infra-mismatch` rides the consequence
    // tone with `failed` and is told apart by its glyph, and `lane-did-not-run`
    // is the same absence as `stale` — the legend says "lane did not run /
    // stale" as one entry. Both halves of each pair must still MATCH, so a
    // future edit cannot silently split one of them either.
    const shared = [
      ["failed", "infra-mismatch"],
      ["stale", "lane-did-not-run"],
    ];
    for (const [left, right] of shared) {
      expect(treatments.get(right)).toBe(treatments.get(left));
    }
    const separable = [...treatments].filter(
      ([state]) => !shared.some(([, follower]) => follower === state)
    );
    expect(new Set(separable.map(([, body]) => body)).size).toBe(
      separable.length
    );
  });
});

describe("the rendered page", () => {
  test("resolves every token it references and names no withdrawn face", () => {
    const root = makeFixtureRoot();
    const result = runGenerate(root);
    expect(result.status).toBe(0);
    const style =
      /<style>(?<css>[\s\S]*?)<\/style>/u.exec(result.html)?.groups?.css ?? "";
    expect(style.length).toBeGreaterThan(0);
    const resolvable = declared(style).add("--row");
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
