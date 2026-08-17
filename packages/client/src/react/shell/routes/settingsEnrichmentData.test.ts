/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
/*
 * Settings → Enrichment data layer (issue #807).
 *
 * The law under test is ONE WRITER PER PATH: tiers and rules go to the vault's
 * own routes, and an engine profile goes to the prefs key `enrich.profile.<id>`
 * as the stored shape the gateway validates — with no `egress`, which is
 * computed there and is a refusal rather than a preference.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as TypeImport_1e7rich from "../../../gateway-client.js";

const {
  deleteEnrichRule,
  getEnrichPolicy,
  getEnrichRules,
  getEffectiveEnrichPolicy,
  getHarnessesStatus,
  getUserPrefs,
  listEnrichEgressConsent,
  listEnrichProfiles,
  saveUserPrefs,
  setEnrichPolicy,
  setEnrichRule,
} = vi.hoisted(() => ({
  deleteEnrichRule: vi.fn<typeof TypeImport_1e7rich.deleteEnrichRule>(),
  getEffectiveEnrichPolicy:
    vi.fn<typeof TypeImport_1e7rich.getEffectiveEnrichPolicy>(),
  getEnrichPolicy: vi.fn<typeof TypeImport_1e7rich.getEnrichPolicy>(),
  getEnrichRules: vi.fn<typeof TypeImport_1e7rich.getEnrichRules>(),
  getHarnessesStatus: vi.fn<typeof TypeImport_1e7rich.getHarnessesStatus>(),
  getUserPrefs: vi.fn<typeof TypeImport_1e7rich.getUserPrefs>(),
  listEnrichEgressConsent:
    vi.fn<typeof TypeImport_1e7rich.listEnrichEgressConsent>(),
  listEnrichProfiles: vi.fn<typeof TypeImport_1e7rich.listEnrichProfiles>(),
  saveUserPrefs: vi.fn<typeof TypeImport_1e7rich.saveUserPrefs>(),
  setEnrichPolicy: vi.fn<typeof TypeImport_1e7rich.setEnrichPolicy>(),
  setEnrichRule: vi.fn<typeof TypeImport_1e7rich.setEnrichRule>(),
}));

// Hoisted above the imports so the gateway stub lands before the data module
// pulls gateway-client-core's load-time side-effect.
vi.mock(import("../../../gateway-client.js") as Promise<unknown>, () => ({
  deleteEnrichRule,
  getEffectiveEnrichPolicy,
  getEnrichPolicy,
  getEnrichRules,
  getHarnessesStatus,
  getUserPrefs,
  listEnrichEgressConsent,
  listEnrichProfiles,
  saveUserPrefs,
  setEnrichPolicy,
  setEnrichRule,
}));

import {
  dropEnrichRule,
  loadEnrichmentSettings,
  saveEngineProfile,
  writeEnrichRule,
} from "./settingsEnrichmentData.js";

describe("settingsEnrichmentData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnrichRules.mockResolvedValue([]);
    listEnrichProfiles.mockResolvedValue([]);
    listEnrichEgressConsent.mockResolvedValue([]);
    getHarnessesStatus.mockResolvedValue({
      harnesses: [
        {
          kind: "codex",
          label: "Codex",
          available: true,
          modelsStatus: "ready",
          models: [{ id: "gpt-5", name: "GPT-5", default: true }],
        },
      ],
    } as Awaited<ReturnType<typeof TypeImport_1e7rich.getHarnessesStatus>>);
    getUserPrefs.mockResolvedValue({});
    saveUserPrefs.mockResolvedValue({});
    getEffectiveEnrichPolicy.mockResolvedValue({
      tier: "device",
      rules: [],
      effective: {
        capability: "ocr",
        enabled: true,
        profileId: "built-in",
        trigger: "on-ingest",
        egressCeiling: "on-device",
      },
    });
  });

  it("reads the whole page in one pass, agent cards included", async () => {
    const data = await loadEnrichmentSettings();
    expect(data.cards.map((card) => card.kind)).toStrictEqual(["codex"]);
  });

  it("never reads the per-domain ceiling — it is no longer a control here", async () => {
    // v11 removed the ceiling control (enrichment runs on the gateway), so the
    // page stops reading the tier store and reads the gateway's own resolver,
    // which is what still reports a ceiling that refuses a row.
    listEnrichProfiles.mockResolvedValue([
      {
        id: "built-in",
        label: "Built-in (ocr)",
        capability: "ocr",
        engine: { kind: "built-in" },
        egress: "gateway",
        builtIn: true,
        delegateCapable: true,
      },
    ]);
    await loadEnrichmentSettings();
    expect(getEnrichPolicy).not.toHaveBeenCalled();
    expect(getEffectiveEnrichPolicy).toHaveBeenCalledWith({
      capability: "ocr",
      domain: "photos",
    });
  });

  it("carries the Agents page's own model and level pins rather than a second copy", async () => {
    getUserPrefs.mockResolvedValue({
      "model.codex.default": "gpt-5",
      "config.codex.default.thought_level": "high",
    });
    getHarnessesStatus.mockResolvedValue({
      harnesses: [
        {
          kind: "codex",
          label: "Codex",
          available: true,
          modelsStatus: "ready",
          models: [{ id: "gpt-5", name: "GPT-5", default: true }],
          capabilities: {
            reachable: true,
            configOptions: [
              {
                id: "thought",
                category: "thought_level",
                type: "select",
                values: [{ value: "high", name: "High" }],
              },
            ],
          },
        },
      ],
    } as Awaited<ReturnType<typeof TypeImport_1e7rich.getHarnessesStatus>>);
    const data = await loadEnrichmentSettings();
    expect(data.modelByHarness["codex"]).toBe("gpt-5");
    expect(data.effortByHarness["codex"]).toBe("high");
  });

  it("stores an engine profile as its prefs key, with no egress claim", async () => {
    await saveEngineProfile({
      id: "fast-ocr",
      label: "Fast OCR",
      capability: "ocr",
      harness: "codex",
      model: "gpt-5",
      configPins: { thought_level: "high" },
    });
    const patch = saveUserPrefs.mock.lastCall?.[0] ?? {};
    expect(Object.keys(patch)).toStrictEqual(["enrich.profile.fast-ocr"]);
    expect(JSON.parse(String(patch["enrich.profile.fast-ocr"]))).toStrictEqual({
      capability: "ocr",
      label: "Fast OCR",
      harness: "codex",
      model: "gpt-5",
      configPins: { thought_level: "high" },
    });
  });

  it("asks the gateway's resolver per capability instead of folding here", async () => {
    listEnrichProfiles.mockResolvedValue([
      {
        id: "built-in",
        label: "Built-in (ocr)",
        capability: "ocr",
        engine: { kind: "built-in" },
        egress: "gateway",
        builtIn: true,
        delegateCapable: true,
      },
      {
        id: "ocr-codex",
        label: "Codex",
        capability: "ocr",
        engine: { kind: "delegate", harness: "codex" },
        egress: "provider",
        builtIn: false,
        delegateCapable: true,
      },
    ]);
    const data = await loadEnrichmentSettings();
    // Once, for the BUILT-IN of each capability — a member profile is another
    // engine for the same capability, not a second thing to resolve.
    expect(getEffectiveEnrichPolicy.mock.calls).toStrictEqual([
      [{ capability: "ocr", domain: "photos" }],
    ]);
    expect(data.effective["ocr"]?.enabled).toBe(true);
  });

  it("leaves out a capability whose domain this build has no word for", async () => {
    listEnrichProfiles.mockResolvedValue([
      {
        id: "built-in",
        label: "Built-in (sentiment)",
        capability: "sentiment",
        engine: { kind: "built-in" },
        egress: "gateway",
        builtIn: true,
        delegateCapable: false,
      },
    ]);
    const data = await loadEnrichmentSettings();
    expect(getEffectiveEnrichPolicy).not.toHaveBeenCalled();
    expect(data.effective).toStrictEqual({});
  });

  it("writes and drops one scope's rule through the vault's rules route", async () => {
    setEnrichRule.mockResolvedValue(null);
    await writeEnrichRule({
      scope: "collection",
      ref: "album:trips",
      capability: "ocr",
      enabled: true,
      profile: null,
      trigger: "on-demand",
    });
    expect(setEnrichRule.mock.lastCall?.[0]).toStrictEqual({
      scope: "collection",
      ref: "album:trips",
      capability: "ocr",
      enabled: true,
      profile: null,
      trigger: "on-demand",
    });
    await dropEnrichRule("collection", "album:trips", "ocr");
    expect(deleteEnrichRule.mock.lastCall).toStrictEqual([
      "collection",
      "album:trips",
      "ocr",
    ]);
  });
});
