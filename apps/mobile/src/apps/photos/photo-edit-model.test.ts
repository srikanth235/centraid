// The editor's arithmetic, and the promises made out of it (v4 handoff §7.4).
//
// These are not styling assertions. The editor's entire argument is that it is
// non-destructive and says so; the sentence that says so is generated here, the
// geometry that decides what "Save" would write is computed here, and the copy
// is pinned against the web editor's own words. If any of the three drifts, a
// member is being promised something the code does not do.

import { describe, expect, test } from "vitest";

import {
  centredCrop,
  clampCrop,
  cropPixels,
  EDITOR_RATIOS,
  editedFilename,
  editorMeta,
  editorStatus,
  FULL_CROP,
  isEdited,
  MIN_CROP,
  moveCrop,
  nextStraighten,
  ratioValue,
  rotatedFrameRatio,
  SAVE_AS_NEW,
  SAVE_AS_NEW_EXPLANATION,
  scaleCrop,
  signedDegrees,
  STRAIGHTEN_LIMIT,
  straightenLabel,
  totalRotation,
} from "./photo-edit-model";

describe("the tool row", () => {
  test("carries the proto's ratios, with the mono spacing", () => {
    expect(EDITOR_RATIOS).toStrictEqual(["Original", "Square", "3 : 2"]);
    expect(ratioValue("3 : 2")).toBeCloseTo(1.5);
    expect(ratioValue("Square")).toBe(1);
    expect(ratioValue("Original")).toBeNull();
  });

  test("one straighten button carries the live angle", () => {
    expect(straightenLabel(-2)).toBe("Straighten −2°");
    expect(straightenLabel(0)).toBe("Straighten 0°");
  });

  test("the angle reads in the numeric register, with a real minus sign", () => {
    expect(signedDegrees(-2)).toBe("−2°");
    expect(signedDegrees(-2)).not.toContain("-");
    expect(signedDegrees(3)).toBe("+3°");
  });

  test("straighten steps anticlockwise and returns to level at the limit", () => {
    expect(nextStraighten(0)).toBe(-1);
    expect(nextStraighten(-STRAIGHTEN_LIMIT)).toBe(0);
  });

  test("rotation is the quarter turns plus the levelling", () => {
    expect(totalRotation(0, 0)).toBe(0);
    expect(totalRotation(1, -2)).toBe(88);
    expect(totalRotation(4, 0)).toBe(0);
  });
});

describe("the frame", () => {
  test("a quarter turn swaps the frame's sides", () => {
    expect(rotatedFrameRatio(1.5, 90)).toBeCloseTo(1 / 1.5);
  });

  test("levelling grows the box rather than swapping it", () => {
    // 3:2 turned 2° is still landscape, but no longer exactly 1.5.
    const ratio = rotatedFrameRatio(1.5, -2);
    expect(ratio).toBeLessThan(1.5);
    expect(ratio).toBeGreaterThan(1.3);
  });
});

describe("the crop box", () => {
  test("a centred 3 : 2 crop of a square frame is the widest that fits", () => {
    expect(centredCrop(1, 1.5)).toStrictEqual({
      h: 1 / 1.5,
      w: 1,
      x: 0,
      y: (1 - 1 / 1.5) / 2,
    });
  });

  test("a drag moves the box and never resizes it", () => {
    const start = { h: 0.5, w: 0.5, x: 0.25, y: 0.25 };
    const moved = moveCrop(start, 0.1, -0.1);
    expect(moved.w).toBe(start.w);
    expect(moved.h).toBe(start.h);
    expect(moved.x).toBeCloseTo(0.35);
    expect(moved.y).toBeCloseTo(0.15);
  });

  test("a drag cannot push the box off the frame", () => {
    const moved = moveCrop({ h: 0.5, w: 0.5, x: 0.25, y: 0.25 }, 5, 5);
    expect(moved).toStrictEqual({ h: 0.5, w: 0.5, x: 0.5, y: 0.5 });
  });

  test("a pinch scales about the centre and stops at the frame", () => {
    const grown = scaleCrop({ h: 0.5, w: 0.5, x: 0.25, y: 0.25 }, 4);
    expect(grown).toStrictEqual(FULL_CROP);
    const shrunk = scaleCrop({ h: 0.5, w: 0.5, x: 0.25, y: 0.25 }, 0.001);
    expect(shrunk.w).toBe(MIN_CROP);
    expect(shrunk.x).toBeCloseTo(0.45);
  });

  test("clamping keeps the box inside the frame and visible", () => {
    expect(clampCrop({ h: 9, w: 0, x: -1, y: 0.9 })).toStrictEqual({
      h: 1,
      w: MIN_CROP,
      x: 0,
      y: 0,
    });
  });

  test("pixels for the manipulator never run off the bitmap", () => {
    expect(
      cropPixels(
        { h: 0.5, w: 0.5, x: 0.5, y: 0.5 },
        { height: 200, width: 400 }
      )
    ).toStrictEqual({ height: 100, originX: 200, originY: 100, width: 200 });
    // A rounding error at the far edge is absorbed, not passed to native.
    const edge = cropPixels(
      { h: 1, w: 1, x: 0.999, y: 0.999 },
      { height: 3, width: 3 }
    );
    expect(edge.originX + edge.width).toBeLessThanOrEqual(3);
    expect(edge.originY + edge.height).toBeLessThanOrEqual(3);
  });
});

describe("what the editor promises", () => {
  test("the status line ends on `nothing written yet`", () => {
    expect(editorStatus({ quarters: 0, ratio: "3 : 2", straighten: -2 })).toBe(
      "Crop 3 : 2 · rotation −2° · nothing written yet"
    );
  });

  test("every state of the editor still says nothing has been written", () => {
    for (const ratio of EDITOR_RATIOS)
      for (const quarters of [0, 1, 2, 3])
        for (const straighten of [0, -1, -STRAIGHTEN_LIMIT])
          expect(editorStatus({ quarters, ratio, straighten })).toContain(
            "nothing written yet"
          );
  });

  // Pinned character for character against the web editor's own strings
  // (`packages/blueprints/apps/photos/viewer.ts`). They cannot be imported from
  // this app — see the note beside the constants — so this assertion is what
  // stands between the two surfaces and a promise that drifts.
  test("the commit and its explanation are the web editor's own words", () => {
    expect(SAVE_AS_NEW).toBe("Save as a new photograph");
    expect(SAVE_AS_NEW_EXPLANATION).toBe(
      "Saving writes a new photograph dated today, with this one recorded as its source. The original is not touched, and nothing is overwritten."
    );
  });

  test("the meta line names the SOURCE photograph, not the new one", () => {
    expect(editorMeta("2026-07-30T17:42:00Z")).toMatch(
      /^from a photograph taken /u
    );
    expect(editorMeta(undefined)).toBe("from a photograph");
  });

  test("an untouched editor has nothing to save", () => {
    expect(
      isEdited({
        crop: FULL_CROP,
        quarters: 0,
        ratio: "Original",
        straighten: 0,
      })
    ).toBe(false);
    expect(
      isEdited({
        crop: { h: 0.9, w: 1, x: 0, y: 0 },
        quarters: 0,
        ratio: "Original",
        straighten: 0,
      })
    ).toBe(true);
  });

  test("the new photograph is findable by name", () => {
    expect(editedFilename("IMG_4913.HEIC")).toBe("IMG_4913-edited.jpg");
    expect(editedFilename(undefined)).toBe("photograph-edited.jpg");
  });
});
