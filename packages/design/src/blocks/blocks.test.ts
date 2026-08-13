// The headless block layer, pinned once (#765).
//
// These are the claims both kits used to make separately, so they are asserted
// here and nowhere else: the kit tests keep their render assertions (which node
// takes `net`, which style takes the touch floor) and stop restating the
// arithmetic.
import { describe, expect, it } from "vitest";

import {
  barStack,
  barWindow,
  boneDelay,
  boneWidths,
  docRowMenu,
  docSnipLine,
  healthSentence,
  opsGenericLine,
  opsStateCarriesAction,
  SKELETON_PULSE_HIGH,
  SKELETON_PULSE_LOW,
  SKELETON_PULSE_MS,
  SKELETON_ROWS,
  SKELETON_STAGGER_MS,
} from "./index";
import type { OpsState } from "./index";

describe(barStack, () => {
  it("stacks the two segments inside one column", () => {
    expect(barStack({ fail: 8, ok: 34 })).toStrictEqual({
      fail: 8,
      hasFail: true,
      ok: 34,
    });
  });

  it("truncates the good news rather than the failure when both cannot fit", () => {
    expect(barStack({ fail: 30, ok: 90 })).toStrictEqual({
      fail: 30,
      hasFail: true,
      ok: 70,
    });
  });

  it("reports an absent failed segment rather than a zero-height one", () => {
    expect(barStack({ fail: 0, ok: 40 })).toStrictEqual({
      fail: 0,
      hasFail: false,
      ok: 40,
    });
  });

  it("clamps values that arrived out of range rather than overflowing the plot", () => {
    expect(barStack({ fail: 140, ok: -5 })).toStrictEqual({
      fail: 100,
      hasFail: true,
      ok: 0,
    });
    expect(barStack({ fail: Number.NaN, ok: Number.NaN })).toStrictEqual({
      fail: 0,
      hasFail: false,
      ok: 0,
    });
  });
});

describe(barWindow, () => {
  it("draws the most recent columns when the series is longer than the chart", () => {
    const series = Array.from({ length: 30 }, (_unused, index) => index);
    expect(barWindow(series, 10)).toStrictEqual([
      20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
    ]);
  });

  it("never pads a short series with empty days", () => {
    expect(barWindow([1], 10)).toStrictEqual([1]);
  });
});

describe(boneWidths, () => {
  it("steps the standard six from 66% down to 36%", () => {
    expect(boneWidths(SKELETON_ROWS)).toStrictEqual([66, 60, 54, 48, 42, 36]);
  });

  it("floors the width rather than stepping into negative bones", () => {
    expect(boneWidths(12).at(-1)).toBe(24);
    expect(boneWidths(0)).toStrictEqual([]);
    expect(boneWidths(-3)).toStrictEqual([]);
  });

  it("breathes on a stagger rather than blinking as one block", () => {
    expect(boneDelay(0)).toBe(0);
    expect(boneDelay(3)).toBe(SKELETON_STAGGER_MS * 3);
    expect(SKELETON_PULSE_MS).toBe(1600);
    expect(SKELETON_PULSE_HIGH).toBeGreaterThan(SKELETON_PULSE_LOW);
  });
});

describe(docSnipLine, () => {
  it("joins the two hidden columns", () => {
    expect(docSnipLine("pdf", "12 Aug 2026")).toBe("pdf · 12 Aug 2026");
  });

  it("renders no stray separator when a half is missing", () => {
    expect(docSnipLine("", "12 Aug 2026")).toBe("12 Aug 2026");
    expect(docSnipLine("pdf", "")).toBe("pdf");
    expect(docSnipLine("", "")).toBe("");
  });
});

describe(docRowMenu, () => {
  const labels = {
    copyId: "Copy the id",
    delete: "Delete",
    edit: "Edit",
    open: "Open the record",
  };

  it("holds the destructive verb in its own group", () => {
    const menu = docRowMenu(labels);
    expect(menu.record.map((item) => item.action)).toStrictEqual([
      "open",
      "edit",
      "copyId",
    ]);
    expect(menu.danger).toStrictEqual([{ action: "delete", label: "Delete" }]);
  });

  it("omits a verb the caller cannot honour rather than listing it", () => {
    const menu = docRowMenu({ copyId: labels.copyId, open: labels.open });
    expect(menu.record.map((item) => item.action)).toStrictEqual([
      "open",
      "copyId",
    ]);
    expect(menu.danger).toStrictEqual([]);
  });
});

describe(opsGenericLine, () => {
  const lines = {
    empty: "Nothing to attend to",
    error: "This page could not load",
    loading: "Reading from the gateway",
  };

  it("speaks for the three states that read the same on every surface", () => {
    expect(opsGenericLine("loading", lines)).toBe(lines.loading);
    expect(opsGenericLine("empty", lines)).toBe(lines.empty);
    expect(opsGenericLine("error", lines)).toBe(lines.error);
  });

  it("leaves the settled states to the surface's own words", () => {
    expect(opsGenericLine("ready", lines)).toBeUndefined();
    expect(opsGenericLine("full", lines)).toBeUndefined();
  });
});

describe(opsStateCarriesAction, () => {
  it("publishes a verb in ready and full only", () => {
    expect(opsStateCarriesAction("ready")).toBe(true);
    expect(opsStateCarriesAction("full")).toBe(true);
    for (const state of ["empty", "loading", "error"] satisfies OpsState[]) {
      expect(opsStateCarriesAction(state)).toBe(false);
    }
  });
});

describe(healthSentence, () => {
  it("joins the standing fact to its qualifier", () => {
    expect(healthSentence("3 waiting on you", "Approving is the act.")).toBe(
      "3 waiting on you · Approving is the act."
    );
    expect(healthSentence("", "Only the detail.")).toBe("Only the detail.");
    expect(healthSentence("Only the label.", "")).toBe("Only the label.");
  });
});
