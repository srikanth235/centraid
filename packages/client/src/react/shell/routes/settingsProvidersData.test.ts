/*
 * The providers console maps the gateway's LIST-shaped agents snapshot into
 * cards. The behaviour that matters: it renders whatever the gateway lists —
 * including harness kinds this build predates — rather than intersecting it
 * with a local table of kinds it knows (docs/protocol.md C1a, parse-always).
 */

import { describe, beforeEach, expect, it, vi } from "vitest";

import type * as TypeImport_1gl5zx7 from "../../../gateway-client.js";
import {
  loadProviders,
  resolveReportedHarnessKind,
  setSubsystemHarnessLadder,
} from "./settingsProvidersData.js";

const { getAgentsStatus, getUserPrefs, saveUserPrefs } = vi.hoisted(() => ({
  getAgentsStatus: vi.fn<typeof TypeImport_1gl5zx7.getAgentsStatus>(),
  getUserPrefs: vi.fn<typeof TypeImport_1gl5zx7.getUserPrefs>(),
  saveUserPrefs: vi.fn<typeof TypeImport_1gl5zx7.saveUserPrefs>(),
}));
type AgentStatusEntry = Awaited<
  ReturnType<typeof TypeImport_1gl5zx7.getAgentsStatus>
>["agents"][number];

// `vi.mock` is hoisted above the imports, so the gateway stub lands before
// settingsProvidersData.js pulls gateway-client-core's load-time side-effect.
vi.mock(import("../../../gateway-client.js") as Promise<unknown>, () => ({
  getAgentsStatus,
  getUserPrefs,
  saveUserPrefs,
}));

type AgentCapabilities = NonNullable<AgentStatusEntry["capabilities"]>;

/** A fully-probed capability set; overrides pick out the axis under test. */
function caps(over: Partial<AgentCapabilities> = {}): AgentCapabilities {
  return {
    reachable: true,
    loadSession: true,
    resume: true,
    close: true,
    additionalDirectories: true,
    mcpHttp: true,
    mcpSse: false,
    modelConfigurable: false,
    usageUpdateObserved: false,
    configOptionUpdateObserved: false,
    locationsObserved: false,
    authRequired: false,
    promptImage: true,
    promptAudio: false,
    promptEmbeddedContext: true,
    ...over,
  };
}

function entry(over: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    kind: "codex",
    label: "Codex",
    available: true,
    version: "codex 1.2.3",
    minVersion: "0.128.0",
    models: [{ id: "gpt-5", name: "GPT-5", default: true }],
    modelsStatus: "ready",
    defaultModel: "gpt-5",
    ...over,
  };
}
describe("settingsProvidersData suite", () => {
  beforeEach(() => {
    getAgentsStatus.mockReset();
    getUserPrefs.mockReset();
    saveUserPrefs.mockClear();
    getUserPrefs.mockResolvedValue({});
  });

  // The gateway omits `capabilities` entirely until the probe succeeds — and
  // also when it throws. Reading that silence as "not ready" made a cold
  // gateway label every installed harness "setup or sign-in needed", including
  // ones that were signed in and working.
  it("separates an unprobed harness from one that actually needs sign-in", async () => {
    getAgentsStatus.mockResolvedValue({
      agents: [
        entry({ kind: "codex" }),
        entry({
          kind: "claude-code",
          capabilities: caps({ authRequired: true }),
        }),
        entry({
          kind: "grok",
          capabilities: caps(),
        }),
      ],
    } as never);
    const dto = await loadProviders();
    const byKind = Object.fromEntries(dto.cards.map((c) => [c.kind, c]));
    expect(byKind["codex"]).toMatchObject({
      sessionReady: false,
      sessionProbePending: true,
    });
    expect(byKind["codex"]?.fallbackBlockedReason).toBe(
      "capability probe has not reported yet"
    );
    expect(byKind["claude-code"]).toMatchObject({ sessionReady: false });
    expect(byKind["claude-code"]?.sessionProbePending).toBeUndefined();
    expect(byKind["claude-code"]?.fallbackBlockedReason).toBe(
      "sign-in required"
    );
    expect(byKind["grok"]).toMatchObject({ sessionReady: true });
    expect(byKind["grok"]?.sessionProbePending).toBeUndefined();
  });

  it("renders one card per agent the gateway lists, in the gateway’s order", async () => {
    getAgentsStatus.mockResolvedValue({
      agents: [
        entry(),
        entry({
          kind: "gemini",
          label: "Gemini CLI",
          version: "gemini 0.60.0",
        }),
        entry({ kind: "qwen", label: "Qwen Code", version: "qwen 0.21.0" }),
      ],
    });
    const dto = await loadProviders();
    expect(dto.cards.map((c) => c.kind)).toStrictEqual([
      "codex",
      "gemini",
      "qwen",
    ]);
    expect(dto.cards.map((c) => c.title)).toStrictEqual([
      "Codex",
      "Gemini CLI",
      "Qwen Code",
    ]);
  });

  it("renders a harness kind this build has never heard of", async () => {
    getAgentsStatus.mockResolvedValue({
      agents: [
        entry({ kind: "some-future-agent", label: "Some Future Agent" }),
      ],
    });
    const dto = await loadProviders();
    // The card is complete — the gateway supplied every string it needs — and
    // only the accent falls back to the neutral default.
    const [card] = dto.cards;
    expect(card?.kind).toBe("some-future-agent");
    expect(card?.title).toBe("Some Future Agent");
    expect(card?.connected).toBe(true);
    expect(card?.subtitle).toBe("codex 1.2.3");
    expect(card?.accent).toBeTruthy();
  });

  it("falls stale picker preferences back to a harness reported by the gateway", async () => {
    getAgentsStatus.mockResolvedValue({ agents: [entry()] });
    getUserPrefs.mockResolvedValue({
      "agent.harness.kind": "future-harness",
      "harness.assistant": "removed-harness",
    });
    const dto = await loadProviders();
    expect(
      resolveReportedHarnessKind(dto, "removed-harness", "assistant")
    ).toBe("codex");
  });

  it("reads saved models for every listed kind, including unknown ones", async () => {
    getAgentsStatus.mockResolvedValue({
      agents: [
        entry(),
        entry({ kind: "some-future-agent", label: "Some Future Agent" }),
      ],
    });
    getUserPrefs.mockResolvedValue({
      "model.codex.default": "gpt-5",
      "model.some-future-agent.default": "future-1",
      "model.some-future-agent.builder": "future-2",
    });
    const dto = await loadProviders();
    // A local kinds table would have stranded the new harness's saved picks.
    expect(dto.savedModelByKind["some-future-agent"]).toBe("future-1");
    expect(dto.subsystemModelByKind["some-future-agent"]?.builder).toBe(
      "future-2"
    );
  });

  it("reads semantic default and subsystem config pins from probed categories", async () => {
    getAgentsStatus.mockResolvedValue({
      agents: [
        entry({
          capabilities: {
            reachable: true,
            loadSession: true,
            resume: true,
            close: true,
            additionalDirectories: true,
            mcpHttp: true,
            mcpSse: false,
            modelConfigurable: true,
            authRequired: false,
            promptImage: true,
            configOptions: [
              {
                id: "thought",
                category: "thought_level",
                type: "select",
                currentValue: "medium",
                values: [{ value: "high", name: "High" }],
              },
            ],
          },
        }),
      ],
    });
    getUserPrefs.mockResolvedValue({
      "config.codex.default.thought_level": "medium",
      "config.codex.builder.thought_level": "high",
    });
    const dto = await loadProviders();
    expect(dto.defaultConfigPinsByKind.codex?.thought_level).toBe("medium");
    expect(dto.subsystemConfigPinsByKind.codex?.builder?.thought_level).toBe(
      "high"
    );
    expect(dto.cards[0]?.capabilityChips).toContain("effort");
    expect(dto.diagnosticsJson).toContain('"thought_level"');
  });

  it("keeps a subsystem pin naming a kind this build does not know", async () => {
    getAgentsStatus.mockResolvedValue({ agents: [entry()] });
    getUserPrefs.mockResolvedValue({ "harness.builder": "some-future-agent" });
    const dto = await loadProviders();
    expect(dto.subsystemHarnessByKey.builder).toBe("some-future-agent");
  });

  it("reads and writes ordered subsystem failover membership", async () => {
    getAgentsStatus.mockResolvedValue({ agents: [entry()] });
    getUserPrefs.mockResolvedValue({
      "harness.ladder.builder": ["claude-code", "gemini", "claude-code"],
    });
    const dto = await loadProviders();
    expect(dto.subsystemHarnessLadders.builder).toStrictEqual([
      "claude-code",
      "gemini",
    ]);

    setSubsystemHarnessLadder("builder", ["gemini", "claude-code"]);
    expect(saveUserPrefs).toHaveBeenCalledWith({
      "harness.ladder.builder": ["gemini", "claude-code"],
    });
  });

  it("shows the gateway’s install hint as the subtitle of an unavailable agent", async () => {
    getAgentsStatus.mockResolvedValue({
      agents: [
        entry({
          kind: "acp",
          label: "Custom ACP agent",
          available: false,
          version: undefined,
          hint: "Set the ACP CLI’s binary path.",
          models: [],
          modelsStatus: "empty",
          defaultModel: undefined,
        }),
      ],
    });
    const dto = await loadProviders();
    expect(dto.cards[0]?.connected).toBe(false);
    expect(dto.cards[0]?.subtitle).toBe("Set the ACP CLI’s binary path.");
  });

  it("flags loading only while a surface is genuinely still filling", async () => {
    getAgentsStatus.mockResolvedValue({
      agents: [
        entry({ models: [], modelsStatus: "loading", defaultModel: undefined }),
      ],
    });
    const loading = await loadProviders();
    expect(loading.anyLoading).toBe(true);
    expect(loading.cards[0]?.modelsLoading).toBe(true);

    // A refresh over an existing list keeps showing it rather than blanking.
    getAgentsStatus.mockResolvedValue({
      agents: [entry({ modelsStatus: "loading" })],
    });
    const refreshing = await loadProviders();
    expect(refreshing.cards[0]?.modelsLoading).toBe(false);
  });

  it("falls back to an empty console when the gateway is unreachable", async () => {
    getAgentsStatus.mockRejectedValue(new Error("offline"));
    const dto = await loadProviders();
    expect(dto.cards).toStrictEqual([]);
    expect(dto.anyLoading).toBe(false);
    expect(dto.selectedKind).toBe("codex");
  });
});
