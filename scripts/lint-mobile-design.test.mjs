import assert from "node:assert/strict";
import test from "node:test";

import { scanMobileDesign } from "./lint-mobile-design.mjs";

test("mobile product grammar has no retired CSS or icon escape hatches", () => {
  assert.deepEqual(scanMobileDesign(), []);
});
