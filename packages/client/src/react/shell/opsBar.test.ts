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
      "Vault",
    ]);
    expect(isOpsPage("approvals")).toBe(true);
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
      ["", "Export CSV"],
      ["Pair a device", "Recovery"],
      ["Pair a device", "Recovery"],
    ]);
  });

  it("tones the page without ever spending an app hue on it", () => {
    expect(opsBarDef("approvals").tone).toBe("net");
    expect(opsBarDef("insights").tone).toBe("ok");
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
