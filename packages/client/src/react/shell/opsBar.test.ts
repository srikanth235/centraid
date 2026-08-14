import { describe, expect, it } from "vitest";

import { isOpsPage, opsBarDef, opsBarVerbs, OPS_PAGES } from "./opsBar.js";
import type { OpsPage } from "./opsBar.js";

describe("the operational routes' app bar", () => {
  it("names all six places, and nothing else", () => {
    expect(OPS_PAGES.map((p) => opsBarDef(p).title)).toStrictEqual([
      "Notifications",
      "Automations",
      "Connectors",
      "Activity",
      "Vault",
      "Copies",
    ]);
    expect(isOpsPage("approvals")).toBe(true);
    // Places in the frame that are NOT operational routes: they keep the bare
    // titlebar and draw their own body.
    expect(isOpsPage("home")).toBe(false);
    expect(isOpsPage("gateway")).toBe(false);
    expect(isOpsPage(undefined)).toBe(false);
  });

  it("gives each page the same two verbs in the same two places", () => {
    const verbs = OPS_PAGES.map((p) => {
      const def = opsBarDef(p);
      return [def.commit?.label ?? "", def.secondary?.label ?? ""];
    });
    expect(verbs).toStrictEqual([
      ["Review all", "History"],
      ["New automation", "Templates"],
      ["Add a connection", "Catalog"],
      // Activity and Vault are READ surfaces: they count and they copy out,
      // and neither is a write, so neither declares a filled commit at all.
      ["", "Export CSV"],
      ["", "Export a kind"],
      ["Pair a device", "Recovery"],
    ]);
  });

  it("tones the page without ever spending an app hue on it", () => {
    expect(opsBarDef("approvals").tone).toBe("net");
    expect(opsBarDef("insights").tone).toBe("ok");
    // The one seam page: a pending pairing is neither an alarm nor nothing.
    expect(opsBarDef("household").tone).toBe("seam");
  });

  describe("verb visibility", () => {
    const labels = (page: OpsPage, state?: Parameters<typeof opsBarVerbs>[1]) =>
      [
        opsBarVerbs(page, state).commit?.label,
        opsBarVerbs(page, state).secondary?.label,
      ] as const;

    it("shows both before anything has been read, so the bar never flickers", () => {
      expect(labels("automations")).toStrictEqual([
        "New automation",
        "Templates",
      ]);
    });

    it("withdraws both while reading — nothing to act on yet", () => {
      expect(labels("automations", "loading")).toStrictEqual([
        undefined,
        undefined,
      ]);
    });

    it("keeps the quiet verb on error and withdraws only the commit", () => {
      // "What failed, what is still safe": Templates still works when this
      // page's own query did not.
      expect(labels("automations", "error")).toStrictEqual([
        undefined,
        "Templates",
      ]);
    });

    it("offers both in ready, full and empty", () => {
      for (const state of ["ready", "full", "empty"] as const)
        expect(labels("connectors", state)).toStrictEqual([
          "Add a connection",
          "Catalog",
        ]);
    });

    it("never invents a commit for a read surface, in any state", () => {
      for (const state of [
        "ready",
        "full",
        "empty",
        "loading",
        "error",
      ] as const)
        expect(opsBarVerbs("insights", state).commit).toBeUndefined();
    });
  });
});
