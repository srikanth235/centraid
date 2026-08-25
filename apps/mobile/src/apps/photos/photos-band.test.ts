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
  test("Photos claims exactly Library · Collections · Search · More", () => {
    // Library leads (#712). Collections ≠ Albums. People is off the band.
    expect(PHOTOS_BAND_DESTINATIONS.map((d) => d.label)).toStrictEqual([
      "Library",
      "Collections",
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

  test("the More sheet carries only what Collections does not", () => {
    // One More row (#726). Backup is Backup health, not a Collections shelf (#712).
    expect(PHOTOS_MORE_ROWS.map((row) => row.label)).toStrictEqual(["Backup"]);
    expect(PHOTOS_MORE_ROWS.map((row) => row.label)).not.toContain("Storage");
    expect(PHOTOS_MORE_ROWS.map((row) => row.label)).not.toContain(
      "Photo access"
    );
  });

  test("exactly one band exists at any moment, never two", () => {
    const claimed = resolveBand("app");
    const handedBack = resolveBand("host");

    expect(claimed.owner).toBe("app");
    expect(handedBack.owner).toBe("host");

    // Host branch has no destinations/capsule — no dual-band state.
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
  const PAPER = "#F0EFED";
  const LINE = "#EFEEEB";
  const style = bandSurfaceStyle(PAPER, LINE, 0.5);

  test("is opaque paper — translucency was considered and declined", () => {
    expect(isOpaqueColor(style.backgroundColor)).toBe(true);
  });

  test("carries no shadow and no elevation", () => {
    // No hover plane — contrast would depend on the photo.
    expect(style).not.toHaveProperty("shadowOpacity");
    expect(style).not.toHaveProperty("shadowRadius");
    expect(style).not.toHaveProperty("shadowColor");
    expect(style).not.toHaveProperty("elevation");
  });

  test("floats: inset 12 from the stage edges, 12 radius, rule border", () => {
    expect(style.marginHorizontal).toBe(BAND_INSET);
    expect(style.marginBottom).toBe(BAND_INSET);
    expect(style.borderRadius).toBe(BAND_RADIUS);
    // Top gap 8 on both bands; 0 sits flush.
    expect(style.marginTop).toBe(BAND_TOP_GAP);
    expect(BAND_TOP_GAP).toBe(8);
    expect(style.borderWidth).toBe(0.5);
    expect(BAND_BORDER).toBe(1);
  });

  test("the frame's band and a claimed band draw the SAME plate", () => {
    // Same plate geometry; composition lives in PhotosBand.tsx.
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
