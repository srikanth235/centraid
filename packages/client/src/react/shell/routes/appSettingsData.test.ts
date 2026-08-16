import { describe, expect, it, vi } from "vitest";

import {
  knobsManifestFrom,
  manifestVaultBlock,
  pushKnobToInlineRoot,
} from "./appSettingsData.js";

// `vi.mock` is hoisted above the import by vitest, so gateway-client-core's
// load-time side-effect never runs.
vi.mock(import("../../../gateway-client.js"), () => ({}));

describe(manifestVaultBlock, () => {
  it("parses a sound vault block", () => {
    const block = manifestVaultBlock({
      vault: {
        purpose: "Read tasks",
        why: "to summarise",
        scopes: [{ table: "tasks" }],
      },
    });
    expect(block).toStrictEqual({
      purpose: "Read tasks",
      why: "to summarise",
      scopes: [{ table: "tasks" }],
    });
  });

  it("defaults why to empty string", () => {
    const block = manifestVaultBlock({ vault: { purpose: "x", scopes: [] } });
    expect(block?.why).toBe("");
  });

  it("returns null when absent or malformed", () => {
    expect(manifestVaultBlock(null)).toBeNull();
    expect(manifestVaultBlock({})).toBeNull();
    expect(manifestVaultBlock({ vault: { purpose: "x" } })).toBeNull(); // no scopes
    expect(manifestVaultBlock({ vault: { scopes: [] } })).toBeNull(); // no purpose
  });
});

describe(knobsManifestFrom, () => {
  it("reads the knobs array + manifest version", () => {
    const m = knobsManifestFrom({
      manifestVersion: 3,
      knobs: [{ key: "appFont" }],
    });
    expect(m).toStrictEqual({ version: 3, knobs: [{ key: "appFont" }] });
  });

  it("defaults version to 1 and returns null without a knobs array", () => {
    expect(knobsManifestFrom({ knobs: [] })).toStrictEqual({
      version: 1,
      knobs: [],
    });
    expect(knobsManifestFrom({})).toBeNull();
    expect(knobsManifestFrom(null)).toBeNull();
  });
});

describe(pushKnobToInlineRoot, () => {
  it("routes Color/Accent keys to CSS vars and the rest to data attributes", () => {
    const root = document.createElement("div");
    document.body.append(root);

    pushKnobToInlineRoot(root, "appAccent", "#f00");
    pushKnobToInlineRoot(root, "appDensity", "compact");

    expect(root.style.getPropertyValue("--app-identity")).toBe("#f00");
    expect(root.dataset.appDensity).toBe("compact");
    root.remove();
  });
});
