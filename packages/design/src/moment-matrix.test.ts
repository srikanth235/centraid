import { describe, expect, test } from "vitest";

import matrix from "../../../tests/design-grammar-matrix.json";

const MOMENTS = Array.from({ length: 20 }, (_, index) => `M${index + 1}`);

describe("product grammar moment matrix", () => {
  test("enumerates every normative moment with property classifications", () => {
    expect(Object.keys(matrix.moments)).toStrictEqual(MOMENTS);
    for (const id of MOMENTS) {
      const moment = matrix.moments[id as keyof typeof matrix.moments];
      expect(moment.name).toBeTruthy();
      expect(moment.shared.length).toBeGreaterThan(0);
      expect(moment.adapted.length).toBeGreaterThan(0);
      expect(moment.local.length).toBeGreaterThan(0);
      expect(moment.referenceStates.length).toBeGreaterThan(0);
    }
  });

  test("enumerates the reference states consumed by visual lanes", () => {
    expect(matrix.referenceStates.length).toBeGreaterThanOrEqual(43);
    const ids = new Set(matrix.referenceStates.map((state) => state.id));
    expect(ids.size).toBe(matrix.referenceStates.length);
    for (const state of matrix.referenceStates) {
      expect(MOMENTS).toContain(state.moment);
      expect(Object.keys(matrix.surfaces)).toContain(state.surface);
      expect(["light", "dark"]).toContain(state.scheme);
      expect(state.viewport).toMatch(/^\d+x\d+$/u);
    }
  });

  test("declares one lowering profile for every contracted surface", () => {
    // Four surfaces, not five: there is no served blueprint plane (#799), so
    // the BS surface (`kit-served` into an `iframe-webview`) has no renderer
    // and no capture lane; its reference states live on BI, where a blueprint
    // app paints — inline, in the shell's own document. With one blueprint
    // lowering, its renderer is named for what it is: React in the shell's
    // document.
    expect(matrix.surfaces).toStrictEqual({
      BI: { profile: "blueprint", renderer: "react-inline", host: "shell" },
      MO: { profile: "native", renderer: "react-native", host: "ios-android" },
      SH: { profile: "shell", renderer: "client", host: "desktop-pwa" },
      "SH-c": { profile: "shell", renderer: "client", host: "compact-720" },
    });
  });
});
