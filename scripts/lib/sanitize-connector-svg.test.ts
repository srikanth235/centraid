/* oxlint-disable vitest/no-import-node-test -- (#1018) node --test lane, not a vitest suite */
/* oxlint-disable vitest/prefer-importing-vitest-globals -- (#1018) node --test lane, not a vitest suite */
/* oxlint-disable vitest/prefer-each -- (#1018) node --test lane, not a vitest suite */
import assert from "node:assert/strict";
import test from "node:test";

import { assertSafeConnectorSvg } from "./sanitize-connector-svg.ts";

test("accepts inert SVG paths and fragment-only paint references", () => {
  const svg =
    '<svg viewBox="0 0 24 24"><defs><linearGradient id="g"/></defs><path fill="url(#g)" d="M0 0h1"/></svg>';
  assert.equal(assertSafeConnectorSvg(svg, "safe"), svg);
});

const rejections: Array<[string, string]> = [
  ["script", "<svg><script>alert(1)</script></svg>"],
  ["event handler", '<svg><path onload="alert(1)"/></svg>'],
  ["external link", '<svg><use href="https://evil.example/x.svg#p"/></svg>'],
  ["foreign object", "<svg><foreignObject><p>x</p></foreignObject></svg>"],
  [
    "inline CSS",
    '<svg><path style="background:url(https://evil.example)"/></svg>',
  ],
];

for (const [name, svg] of rejections) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () => assertSafeConnectorSvg(svg, name),
      /Unsafe active SVG markup/u
    );
  });
}
