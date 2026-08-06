import { describe, expect, test } from "vitest";

import {
  BAND_BORDER,
  BAND_INSET,
  BAND_RADIUS,
  BAND_TOP_GAP,
  bandSurfaceStyle,
  isOpaqueColor,
} from "../../kit/band-surface";
import {
  BAND_MAX_DESTINATIONS,
  PHOTOS_BAND_DESTINATIONS,
  PHOTOS_MORE_ROWS,
  TARGET_MIN,
  resolveBand,
} from "./photos-band";

describe("the claimed band (handoff §3.1, CHANGELOG §F)", () => {
  test("Photos claims exactly Library · Albums · People · Search · More", () => {
    expect(PHOTOS_BAND_DESTINATIONS.map((d) => d.label)).toStrictEqual([
      "Library",
      "Albums",
      "People",
      "Search",
      "More",
    ]);
  });

  test("the claim stays inside the frame's own cap of five", () => {
    expect(PHOTOS_BAND_DESTINATIONS.length).toBeLessThanOrEqual(
      BAND_MAX_DESTINATIONS
    );
    expect(() => resolveBand("app")).not.toThrow();
  });

  test("the More sheet carries the shelves the five cannot hold", () => {
    // Sharing and Import are handoff rows this table deliberately does NOT
    // carry (issue #711): neither has a destination on mobile today, and a
    // row with no destination is a lying label, not a missing feature. See
    // the comment on `PHOTOS_MORE_ROWS` for the full reasoning.
    expect(PHOTOS_MORE_ROWS.map((row) => row.label)).toStrictEqual([
      "Favorites",
      "Places",
      "Duplicates",
      "Trash",
      "Storage",
      // Not one of the handoff's rows: the phone is the only surface whose
      // grant belongs to an operating system, and §13's permission screen has
      // no other route on it (see the row's own comment).
      "Photo access",
    ]);
  });

  test("exactly one band exists at any moment, never two", () => {
    const claimed = resolveBand("app");
    const handedBack = resolveBand("host");

    // When the app owns it, the app's band is the only one with destinations.
    expect(claimed.owner).toBe("app");
    expect(handedBack.owner).toBe("host");

    // There is no representable state carrying both. The host branch has no
    // destinations and no capsule at all — the frame renders its own band.
    expect("destinations" in handedBack).toBe(false);
    expect("capsule" in handedBack).toBe(false);
  });
});

describe("the frame's capsule", () => {
  test("sits outside the app's tab group, on the leading edge", () => {
    const band = resolveBand("app");
    expect(band.owner).toBe("app");
    if (band.owner !== "app") return;

    expect(band.capsule.inTabGroup).toBe(false);
    expect(band.capsule.edge).toBe("leading");
    // A group boundary is the whole explanation for why it is not a sixth tab,
    // so the capsule must never appear among the destinations.
    expect(band.destinations).not.toContainEqual(
      expect.objectContaining({ label: "Home" })
    );
  });

  test("is 52px and never smaller than the 44px floor", () => {
    const band = resolveBand("app");
    if (band.owner !== "app") throw new Error("expected the app to claim");
    expect(band.capsule.size).toBe(52);
    expect(band.capsule.size).toBeGreaterThanOrEqual(TARGET_MIN);
  });

  test("is always present while the app owns the band", () => {
    const band = resolveBand("app");
    if (band.owner !== "app") throw new Error("expected the app to claim");
    expect(band.capsule.label).toBe("Home");
  });
});

describe("the band's PLATE (CHANGELOG §G)", () => {
  // Photos' own mat paper and the shared hairline, stated once.
  const PAPER = "#F0EFED";
  const LINE = "#EFEEEB";
  const style = bandSurfaceStyle(PAPER, LINE, 0.5);

  test("is opaque paper — translucency was considered and declined", () => {
    expect(isOpaqueColor(style.backgroundColor)).toBe(true);
  });

  test("carries no shadow and no elevation", () => {
    // A blurred or lifted plane hovering over content is the one thing the
    // system says a surface is not; over unpredictable photographs it also
    // makes label contrast depend on what the member photographed.
    expect(style).not.toHaveProperty("shadowOpacity");
    expect(style).not.toHaveProperty("shadowRadius");
    expect(style).not.toHaveProperty("shadowColor");
    expect(style).not.toHaveProperty("elevation");
  });

  test("floats: inset 12 from the stage edges, 12 radius, rule border", () => {
    expect(style.marginHorizontal).toBe(BAND_INSET);
    expect(style.marginBottom).toBe(BAND_INSET);
    expect(style.borderRadius).toBe(BAND_RADIUS);
    // The FOURTH side. The handoff's frame band is `margin:8px 12px 12px`
    // (:5961) and a claimed band's row is `padding:8px 12px 12px` (:4955) —
    // the top gap is 8 on both. It used to be 0, so the plate sat flush against
    // whatever content ended above it.
    expect(style.marginTop).toBe(BAND_TOP_GAP);
    expect(BAND_TOP_GAP).toBe(8);
    // The width is the caller's, so the band and any other plate can be drawn
    // from one function — but the width the band's own callers pass is the
    // system rule, and the system rule is a FULL point.
    expect(style.borderWidth).toBe(0.5);
    expect(BAND_BORDER).toBe(1);
  });

  test("the frame's band and a claimed band draw the SAME plate", () => {
    // Invariant 1: one band. Home's band and Photos' claimed band are the same
    // object wearing different destinations, so they may differ in what they
    // carry and never in the shape they carry it on. Home's used to be a flush
    // edge-to-edge bar with a top rule while this one floated — two visibly
    // different objects. Both now read this one function, and the only input
    // that legitimately differs is the page colour each sits on.
    //
    // What DOES differ is how many plates each band composes: the frame's band
    // is one (`mobileBandStyle` :5961), a claimed band is two inside a
    // transparent row (`appBandStyle` :4955 — the capsule and the tab group).
    // That is a composition difference, not a shape one, which is why it lives
    // in `PhotosBand.tsx` and not in this function.
    const framePaper = "#FFFFFF";
    const frame = bandSurfaceStyle(framePaper, LINE, 0.5);
    expect(frame.marginHorizontal).toBe(style.marginHorizontal);
    expect(frame.marginBottom).toBe(style.marginBottom);
    expect(frame.marginTop).toBe(style.marginTop);
    expect(frame.borderRadius).toBe(style.borderRadius);
    expect(frame.borderWidth).toBe(style.borderWidth);
    expect(isOpaqueColor(frame.backgroundColor)).toBe(true);
  });

  test("a translucent ground is visible as one", () => {
    expect(isOpaqueColor("rgba(251, 248, 241, 0.5)")).toBe(false);
    expect(isOpaqueColor("transparent")).toBe(false);
    expect(isOpaqueColor(`${PAPER}80`)).toBe(false);
    expect(isOpaqueColor(PAPER)).toBe(true);
    expect(isOpaqueColor(`${PAPER}FF`)).toBe(true);
  });
});
