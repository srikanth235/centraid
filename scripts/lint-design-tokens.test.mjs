import assert from "node:assert/strict";
import test from "node:test";

import { analyzeCss, compareBudget } from "./lint-design-tokens.mjs";

test("analyzeCss ignores comments and accepts token-owned font stacks", () => {
  assert.deepEqual(
    analyzeCss(`
      /* issue #505 and color: #fff are prose */
      .ok { color: var(--ink); font-family: var(--font-sans); }
    `),
    { rawHex: 0, literalFontFamily: 0 }
  );
});

test("analyzeCss finds raw colors and literal font stacks", () => {
  assert.deepEqual(
    analyzeCss(`.bad { color: #fff; font-family: ui-monospace, monospace; }`),
    { rawHex: 1, literalFontFamily: 1 }
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
