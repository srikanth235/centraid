import assert from "node:assert/strict";
import test from "node:test";

import { analyzeCss, compareBudget } from "./lint-design-tokens.mjs";

const clean = {
  rawHex: 0,
  literalFontFamily: 0,
  rawFontSize: 0,
  rawFontWeight: 0,
  rawRadius: 0,
};

test("analyzeCss ignores comments and accepts token-owned font stacks", () => {
  assert.deepEqual(
    analyzeCss(`
      /* issue #505 and color: #fff and font-size: 13px are prose */
      .ok { color: var(--text); font-family: var(--font-sans); }
    `),
    clean
  );
});

test("analyzeCss finds raw colors and literal font stacks", () => {
  assert.deepEqual(
    analyzeCss(`.bad { color: #fff; font-family: ui-monospace, monospace; }`),
    { ...clean, rawHex: 1, literalFontFamily: 1 }
  );
});

test("analyzeCss accepts the `font:` shorthand as the tokened type form", () => {
  assert.deepEqual(
    analyzeCss(`.ok { font: var(--t-body); border-radius: var(--r-md); }`),
    clean
  );
});

test("analyzeCss counts raw font-size but not inherit or a var knob", () => {
  assert.deepEqual(
    analyzeCss(`
      .a { font-size: 12.5px; }
      .b { font-size: 0.9em; }
      .c { font-size: inherit; }
      .d { font-size: var(--outage-size); }
    `),
    { ...clean, rawFontSize: 2 }
  );
});

test("analyzeCss counts only off-scale font-weights", () => {
  assert.deepEqual(
    analyzeCss(`
      .a { font-weight: 400; }
      .b { font-weight: 500; }
      .c { font-weight: 600; }
      .d { font-weight: normal; }
      .e { font-weight: 550; }
      .f { font-weight: 700; }
      .g { font-weight: bold; }
    `),
    { ...clean, rawFontWeight: 3 }
  );
});

test("analyzeCss counts off-scale radii and honours the documented carve-outs", () => {
  assert.deepEqual(
    analyzeCss(`
      .zero { border-radius: 0; }
      .circle { border-radius: 50%; }
      .pill { border-radius: 999px; }
      .hairline { border-radius: 1px; }
      .tokened { border-radius: calc(var(--r-md) - 3px); }
      .scaled { border-radius: 8px; }
      .corners { border-radius: 0 0 13px 13px; }
      .shouty { border-radius: 12px !important; }
    `),
    { ...clean, rawRadius: 3 }
  );
});

test("compareBudget rejects increases, stale debt, and untightened decreases", () => {
  assert.deepEqual(
    compareBudget(
      {
        "new.css": { rawHex: 1, literalFontFamily: 0 },
        "lower.css": { rawHex: 1, literalFontFamily: 0 },
      },
      {
        "lower.css": { rawHex: 2 },
        "gone.css": { rawHex: 1 },
      }
    ),
    [
      "new.css: rawHex increased 0 → 1",
      "lower.css: rawHex fell 2 → 1; tighten tests/design-token-css-budget.json",
      "gone.css: stale budget entry (file removed or moved)",
    ]
  );
});
