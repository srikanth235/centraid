import { describe, expect, it } from "vitest";

import { isOpsPage, opsBarDef, opsBarVerbs, OPS_PAGES } from "./opsBar.js";
import type { OpsPage } from "./opsBar.js";

describe("the operational routes' app bar", () => {
  it("names all six places, and nothing else", () => {
    // Two of the six keys name ONE surface: Data and Copies merged into Vault
    // (v11), and both route kinds resolve to it so old pins and old deep links
    // land. They share one definition rather than two that happen to agree.
    expect(OPS_PAGES.map((p) => opsBarDef(p).title)).toStrictEqual([
      "Notifications",
      "Automations",
      "Connectors",
      "Activity",
      "Vault",
      "Vault",
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
      // Activity is a READ surface: it counts what already happened and it
      // copies out, and neither is a write, so it declares no filled commit.
      ["", "Export CSV"],
      // Vault's verbs are the SURFACE's, under both its keys. "Export a kind"
      // is a verb about the census and is a row beside it, where it keeps the
      // subject that makes it mean anything.
      ["Pair a device", "Recovery"],
      ["Pair a device", "Recovery"],
    ]);
  });

  it("tones the page without ever spending an app hue on it", () => {
    expect(opsBarDef("approvals").tone).toBe("net");
    expect(opsBarDef("insights").tone).toBe("ok");
    // The seam page, under both its keys: a pending pairing is neither an
    // alarm nor nothing.
    expect(opsBarDef("household").tone).toBe("seam");
    expect(opsBarDef("atlas").tone).toBe("seam");
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
