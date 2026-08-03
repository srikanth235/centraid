// The mobile Home band's hard ceiling (issue #708 §B.2): at most 5 pinned
// apps plus the always-present "More" tab, and no tab under a 44pt touch
// target. `./band`'s own header already states this as invariant 1; this
// file is what proves it stays true rather than trusting the comment.
//
// Pure-logic checks only, matching this directory's existing discipline (see
// band.test.ts) — no React Native render here. `HomeBand.tsx` (the one place
// that actually lays the band out) renders every tab, pinned or "More",
// through the SAME `<Tab>` component and the SAME `styles.tab` rule
// (`minHeight: metrics.row`, `flex: 1`), so proving `MAX_PINS + 1 <= 6` and
// `metrics.row >= 44` here is proving the real on-screen floor, not a
// disconnected assumption — HomeBand.tsx has no per-tab size override to
// drift out of sync with either constant.
import { describe, expect, it } from "vitest";

import { metrics } from "@centraid/design";

import { MAX_PINS } from "./band";

const MORE_TABS = 1;
const TOUCH_TARGET_FLOOR = 44;

describe("the Home band's cap", () => {
  it("holds at most 5 pinned apps", () => {
    expect(MAX_PINS).toBeLessThanOrEqual(5);
  });

  it("never shows more than 5 pins + More (6 tabs total)", () => {
    expect(MAX_PINS + MORE_TABS).toBeLessThanOrEqual(6);
  });

  it("keeps the shared row metric at least a 44pt touch target", () => {
    // HomeBand.tsx's `styles.tab` sets `minHeight: metrics.row` for every
    // tab (pinned apps AND "More" alike) — this is the actual floor on
    // screen, so sabotaging `metrics.row` in packages/design is what a
    // regression here would look like, not a locally-duplicated literal.
    expect(metrics.row).toBeGreaterThanOrEqual(TOUCH_TARGET_FLOOR);
  });
});
