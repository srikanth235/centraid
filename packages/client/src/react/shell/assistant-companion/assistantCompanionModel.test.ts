import { describe, expect, it } from "vitest";

import {
  assistantConsequence,
  assistantWorkingLine,
  initialAssistantSelection,
  resolveAssistantSelection,
  selectionForHarness,
  selectionForModel,
} from "./assistantCompanionModel.js";
import type { AssistantHarnessOption } from "./assistantCompanionModel.js";

const catalog = [
  {
    id: "installed",
    installed: true,
    label: "Workbench",
    models: [
      {
        efforts: [
          { id: "brief", label: "brief", note: "Short." },
          { id: "deep", label: "deep", note: "Long." },
        ],
        id: "capable",
        label: "Capable",
      },
      {
        efforts: [],
        id: "direct",
        label: "Direct",
        noEffortReason: "Direct answers.",
      },
    ],
    statusLabel: "ready",
    vendorLabel: "Provider",
  },
  {
    id: "missing",
    installed: false,
    label: "Optional tool",
    models: [{ efforts: [], id: "only", label: "Only" }],
    statusLabel: "not installed",
    vendorLabel: "Vendor",
  },
] as const satisfies readonly AssistantHarnessOption[];

describe("assistant companion selection model", () => {
  it("defaults to the first model and its highest effort", () => {
    expect(initialAssistantSelection(catalog)).toStrictEqual({
      effortId: "deep",
      harnessId: "installed",
      modelId: "capable",
    });
    expect(selectionForHarness(catalog[1])).toStrictEqual({
      harnessId: "missing",
      modelId: "only",
    });
  });

  it("resets effort when the model changes", () => {
    const initial = selectionForHarness(catalog[0]);
    expect(selectionForModel(initial, catalog[0].models[1])).toStrictEqual({
      harnessId: "installed",
      modelId: "direct",
    });
  });

  it("resolves copy without leaking runtime identifiers", () => {
    const resolved = resolveAssistantSelection(
      catalog,
      selectionForHarness(catalog[0])
    );
    expect(assistantWorkingLine(resolved)).toBe(
      "Workbench · Capable · deep effort · working"
    );
    expect(assistantConsequence(resolved, 2)).toBe(
      "Workbench sends what you ask, and the 2 things attached, to Provider."
    );
    const missing = resolveAssistantSelection(
      catalog,
      selectionForHarness(catalog[1])
    );
    expect(assistantConsequence(missing, 0)).toContain("is not installed");
  });
});
