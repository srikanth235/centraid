import assert from "node:assert/strict";
import test from "node:test";

import { analyzeCss, compareBudget } from "./lint-design-tokens.mjs";

const clean = {
  rawHex: 0,
  literalFontFamily: 0,
  rawFontSize: 0,
  rawFontWeight: 0,
  rawRadius: 0,
  paletteHueAsText: 0,
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

test("analyzeCss clears the composable size rungs but not the shorthands", () => {
  assert.deepEqual(
    analyzeCss(`
      .a { font-size: var(--t-body-size); }
      .b { font-size: var(--t-display-1-size); }
      .c { font-size: var(--t-mono-size) !important; }
    `),
    clean
  );
  // `--t-<key>` is a `font` shorthand; as a `font-size` value the declaration
  // is invalid and dropped whole, so it stays debt even though it is a var().
  assert.deepEqual(
    analyzeCss(`
      .a { font-size: var(--t-body); }
      .b { font-size: var(--t-small, 13px); }
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

test("analyzeCss counts a bare palette hue as ink, never as a fill", () => {
  assert.deepEqual(
    analyzeCss(`
      /* Ink — off-contract, the fills are 2.04–5.03:1 on light. */
      .a { color: var(--c-amber); }
      .b { color: color-mix(in srgb, var(--c-amber) 65%, var(--text)); }
      .c { -webkit-text-fill-color: var(--c-rose); }
      /* Fills — every one of these stays on the raw hue. */
      .d { background: var(--c-teal); }
      .e { background-color: var(--c-teal); }
      .f { border-color: var(--c-teal); }
      .g { border-top-color: var(--c-teal); }
      .h { box-shadow: 0 0 0 4px var(--c-teal); }
      .i { --notice-hue: var(--c-teal); }
      /* Ink on the solved rung — the whole point of the metric. */
      .j { color: var(--c-amber-text); }
      /* Not a palette hue at all. */
      .k { color: var(--ccc-amber); }
    `),
    { ...clean, paletteHueAsText: 3 }
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
