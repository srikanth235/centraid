import assert from "node:assert/strict";
import test from "node:test";

import { ParseError, renderToString } from "katex";
import { micromark } from "micromark";
import { math, mathHtml } from "micromark-extension-math";

// The Markdown dependency still declares KaTeX ^0.16; the security override
// must preserve its rendering interface (#1110).
const render = (source) => micromark(source, {
  extensions: [math()],
  htmlExtensions: [mathHtml()],
});

test("the patched KaTeX renders through the Markdown math extension", () => {
  for (const source of ["$x^2$", "$$\n\\frac{1}{\\sqrt{2}}\n$$", "$\\begin{matrix}a&b\\end{matrix}$"]) {
    assert.match(render(source), /class="katex/u);
  }
  assert.match(renderToString("\\R", { macros: { "\\R": "\\mathbb{R}" } }), /class="katex/u);
});

test("KaTeX preserves error handling and rejects untrusted link protocols", () => {
  assert.throws(() => renderToString("\\notARealCommand"), ParseError);
  assert.doesNotThrow(() => renderToString("\\notARealCommand", { throwOnError: false }));
  assert.doesNotMatch(render("$\\href{javascript:alert(1)}{x}$"), /href="javascript:/u);
});
