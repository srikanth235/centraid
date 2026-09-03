import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
// governance: allow-repo-hygiene file-size-limit (#608) cohesive provider-routing screen suite shares one bridge and DOM harness

import type {
  HarnessesStatusDTO,
  SettingsHarnessesBridgeProps,
} from "../screen-contracts.js";
import type * as TypeImport_in5dl4 from "../shell/confirm.js";
import SettingsHarnessesScreen from "./SettingsHarnessesScreen.js";

const dialog = vi.hoisted(() => ({
  openConfirm: vi.fn<typeof TypeImport_in5dl4.openConfirm>(),
}));
vi.mock(import("../shell/confirm.js"), () => dialog);

function withSessionReady(status: HarnessesStatusDTO): HarnessesStatusDTO {
  return {
    ...status,
    cards: status.cards.map((card) =>
      card.kind === "claude-code" ? { ...card, sessionReady: true } : card
    ),
  };
}

function makeStatus(
  over: Partial<HarnessesStatusDTO> = {}
): HarnessesStatusDTO {
  return {
    selectedKind: "codex",
    anyLoading: false,
    savedModelByKind: { codex: "gpt-5" },
    subsystemModelByKind: { codex: { assistant: "gpt-5-mini" } },
    defaultConfigPinsByKind: {},
    subsystemConfigPinsByKind: {},
    diagnosticsJson: "{}",
    subsystemHarnessByKey: {},
    subsystemHarnessLadders: {},
    cards: [
      {
        kind: "codex",
        title: "Codex",
        accent: "#10b981",
        subtitle: "codex 1.2.3",
        connected: true,
        sessionReady: true,
        modelsLoading: false,
        models: [
          { id: "gpt-5", name: "GPT-5", tier: "smart", default: true },
          { id: "gpt-5-mini", name: "GPT-5 mini", tier: "fast" },
        ],
      },
      {
        kind: "claude-code",
        title: "Claude Code",
        accent: "#a855f7",
        subtitle: "claude CLI not found on PATH",
        connected: false,
        sessionReady: false,
        modelsLoading: false,
        models: [],
      },
    ],
    ...over,
  };
}

function makeStatusBothConnected(
  over: Partial<HarnessesStatusDTO> = {}
): HarnessesStatusDTO {
  const base = makeStatus();
  return {
    ...base,
    cards: base.cards.map((c) =>
      c.kind === "claude-code"
        ? {
            ...c,
            connected: true,
            subtitle: "claude 1.0",
            models: [
              {
                id: "opus-4-8",
                name: "Opus 4.8",
                tier: "smart",
                default: true,
              },
            ],
          }
        : c
    ),
    ...over,
  };
}

function makeProps(
  over: Partial<SettingsHarnessesBridgeProps> = {}
): SettingsHarnessesBridgeProps {
  return {
    loadStatus: vi
      .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
      .mockResolvedValue(makeStatus()),
    refreshModels: vi
      .fn<SettingsHarnessesBridgeProps["refreshModels"]>()
      .mockResolvedValue(makeStatus()),
    activateHarness: vi
      .fn<SettingsHarnessesBridgeProps["activateHarness"]>()
      .mockResolvedValue(null),
    setHarnessModel: vi
      .fn<SettingsHarnessesBridgeProps["setHarnessModel"]>()
      .mockResolvedValue(null),
    setHarnessConfigPin: vi
      .fn<SettingsHarnessesBridgeProps["setHarnessConfigPin"]>()
      .mockResolvedValue(null),
    setSubsystemModel: vi
      .fn<SettingsHarnessesBridgeProps["setSubsystemModel"]>()
      .mockResolvedValue(null),
    setSubsystemConfigPin: vi
      .fn<SettingsHarnessesBridgeProps["setSubsystemConfigPin"]>()
      .mockResolvedValue(null),
    setSubsystemHarness: vi
      .fn<SettingsHarnessesBridgeProps["setSubsystemHarness"]>()
      .mockResolvedValue(null),
    setSubsystemHarnessLadder: vi
      .fn<SettingsHarnessesBridgeProps["setSubsystemHarnessLadder"]>()
      .mockResolvedValue(null),
    showToast: vi.fn<SettingsHarnessesBridgeProps["showToast"]>(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
describe("SettingsHarnessesScreen suite", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });
  async function mount(
    props: SettingsHarnessesBridgeProps
  ): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(<SettingsHarnessesScreen {...props} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    return container;
  }

  async function press(el: HTMLElement, word: string): Promise<void> {
    const found = [...el.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === word
    );
    if (!found) throw new Error(`no button reading "${word}"`);
    await act(async () => {
      found.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  async function openFallback(el: HTMLElement): Promise<void> {
    await press(el, "Fallback");
  }

  function sel(el: HTMLElement, label: string): HTMLSelectElement {
    const found = el.querySelector(`select[aria-label="${label}"]`);
    if (!found) throw new Error(`no select labelled "${label}"`);
    return found as HTMLSelectElement;
  }

  async function pick(select: HTMLSelectElement, value: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(
      globalThis.HTMLSelectElement.prototype,
      "value"
    )?.set;
    await act(async () => {
      setter?.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  describe(SettingsHarnessesScreen, () => {
    it("renders the two sections: each agent's own answer, then the lanes", async () => {
      const el = await mount(makeProps());
      expect(el.textContent).toContain("Harnesses");
      expect(el.textContent).toContain("Lanes");
      expect(sel(el, "Default agent").getAttribute("aria-label")).toBe(
        "Default agent"
      );
      for (const label of ["Assistant", "In-app Ask", "Automations"]) {
        expect(
          el.querySelector(`[aria-label="Agent for ${label}"]`)
        ).not.toBeNull();
      }
      expect(el.querySelector('[aria-label="Agent for Builder"]')).toBeNull();
      expect(el.querySelectorAll(".glyphTile")).toHaveLength(2);
      expect(sel(el, "Default model for Codex").value).toBe("gpt-5");
      expect(el.querySelectorAll("optgroup").length).toBeGreaterThan(0);
    });

    it("has no exclusive active-agent switch — routing is per lane now", async () => {
      const el = await mount(makeProps());
      expect(el.querySelector(".switchSeg")).toBeNull();
      expect(el.textContent).not.toContain("Active agent");
    });

    it("changes the default agent through the default lane", async () => {
      const props = makeProps({
        loadStatus: vi
          .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
          .mockResolvedValue(makeStatusBothConnected()),
      });
      const el = await mount(props);
      await pick(sel(el, "Default agent"), "claude-code");
      expect(props.activateHarness).toHaveBeenCalledWith("claude-code");
    });

    it("routes a single subsystem to a different agent than the default", async () => {
      const props = makeProps({
        loadStatus: vi
          .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
          .mockResolvedValue(makeStatusBothConnected()),
      });
      const el = await mount(props);
      await pick(sel(el, "Agent for In-app Ask"), "claude-code");
      expect(props.setSubsystemHarness).toHaveBeenCalledWith(
        "ask",
        "claude-code"
      );
      expect(props.activateHarness).not.toHaveBeenCalled();
    });

    it("clears a lane back to inheriting the default", async () => {
      const props = makeProps({
        loadStatus: vi
          .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
          .mockResolvedValue(
            makeStatusBothConnected({
              subsystemHarnessByKey: { ask: "claude-code" },
            })
          ),
      });
      const el = await mount(props);
      expect(sel(el, "Agent for In-app Ask").value).toBe("claude-code");
      await pick(sel(el, "Agent for In-app Ask"), "");
      expect(props.setSubsystemHarness).toHaveBeenCalledWith("ask", "");
    });

    it("requires explicit confirmation before adding ordered failover membership", async () => {
      dialog.openConfirm.mockReset().mockResolvedValue(true);
      const props = makeProps({
        loadStatus: vi
          .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
          .mockResolvedValue(withSessionReady(makeStatusBothConnected())),
      });
      const el = await mount(props);
      await openFallback(el);
      await act(async () => {
        await pick(
          sel(el, "Add fallback agent for Automations"),
          "claude-code"
        );
      });
      expect(dialog.openConfirm).toHaveBeenCalledOnce();
      expect(props.setSubsystemHarnessLadder).toHaveBeenCalledWith(
        "automations",
        ["claude-code"]
      );
    });

    it("offers failover only on the unattended lane", async () => {
      const el = await mount(makeProps());
      await openFallback(el);
      expect(el.textContent).not.toContain("Next-turn failover");
      expect(el.textContent).toContain("In-fire failover");
      expect(el.querySelectorAll(".ladderRow")).toHaveLength(1);
      expect(
        el.querySelector('[aria-label="Add fallback agent for Automations"]')
      ).toBeTruthy();
      expect(
        el.querySelector('[aria-label="Add fallback agent for Assistant"]')
      ).toBeNull();
    });

    it("shows explicit feedback when fallback consent is cancelled", async () => {
      dialog.openConfirm.mockReset().mockResolvedValue(false);
      const props = makeProps({
        loadStatus: vi
          .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
          .mockResolvedValue(withSessionReady(makeStatusBothConnected())),
      });
      const el = await mount(props);
      await openFallback(el);
      await pick(sel(el, "Add fallback agent for Automations"), "claude-code");
      await act(async () => {
        await Promise.resolve();
      });
      expect(el.textContent).toContain("Claude Code was not added");
      expect(props.setSubsystemHarnessLadder).not.toHaveBeenCalled();
    });

    it("will not offer an agent that has not passed its session preflight as a fallback", async () => {
      const props = makeProps({
        loadStatus: vi
          .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
          .mockResolvedValue(makeStatusBothConnected()),
      });
      const el = await mount(props);
      await openFallback(el);
      const add = sel(el, "Add fallback agent for Automations");
      expect(
        [...add.querySelectorAll("option")].map((option) => option.value)
      ).toStrictEqual([""]);
      expect(add.disabled).toBe(true);
    });

    it("explains why an installed harness is ineligible for unattended failover", async () => {
      const status = makeStatusBothConnected();
      const props = makeProps({
        loadStatus: vi
          .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
          .mockResolvedValue({
            ...status,
            cards: status.cards.map((card) =>
              card.kind === "claude-code"
                ? {
                    ...card,
                    fallbackBlockedReason:
                      "Sign in once before unattended failover",
                  }
                : card
            ),
          }),
      });
      const el = await mount(props);
      await openFallback(el);
      expect(el.textContent).toContain(
        "Claude Code: Sign in once before unattended failover"
      );
    });

    it("surfaces a persisted non-roster primary so the owner can clear it", async () => {
      const props = makeProps({
        loadStatus: vi
          .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
          .mockResolvedValue(
            makeStatus({
              subsystemHarnessByKey: { assistant: "cursor" },
            })
          ),
      });
      const el = await mount(props);
      const assistant = sel(el, "Agent for Assistant");
      expect(assistant.value).toBe("cursor");
      expect(assistant.selectedOptions[0]?.textContent).toBe(
        "cursor · existing hidden pin"
      );
      await pick(assistant, "");
      expect(props.setSubsystemHarness).toHaveBeenCalledWith("assistant", "");
    });

    it("shows the stored ladder in full, including a member that is now the lane primary", async () => {
      const props = makeProps({
        loadStatus: vi
          .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
          .mockResolvedValue(
            withSessionReady(
              makeStatusBothConnected({
                subsystemHarnessLadders: {
                  automations: ["codex", "claude-code"],
                },
              })
            )
          ),
      });
      const el = await mount(props);
      await openFallback(el);
      expect(
        el.querySelector(
          '[aria-label="Remove Codex from Automations failover"]'
        )
      ).toBeTruthy();
      await act(async () => {
        el.querySelector<HTMLButtonElement>(
          '[aria-label="Move Claude Code earlier for Automations"]'
        )?.click();
      });
      expect(props.setSubsystemHarnessLadder).toHaveBeenCalledWith(
        "automations",
        ["claude-code", "codex"]
      );
    });

    it("states what an inheriting lane resolves to, and offers it no model of its own", async () => {
      const el = await mount(makeProps());
      const harness = sel(el, "Agent for Assistant");
      expect(harness.value).toBe("");
      expect(el.querySelector('[aria-label="Model for Assistant"]')).toBeNull();
      expect(el.textContent).toContain("inherits Codex · GPT-5");
    });

    it("states the model AND the level every inheriting lane lands on", async () => {
      const el = await mount(
        makeProps({
          loadStatus: vi
            .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
            .mockResolvedValue(
              makeStatus({
                cards: makeStatus().cards.map((card) =>
                  card.kind === "codex"
                    ? {
                        ...card,
                        configOptions: [
                          {
                            id: "thought",
                            category: "thought_level",
                            type: "select",
                            currentValue: "medium",
                            values: [
                              { value: "medium", name: "Medium" },
                              { value: "high", name: "High" },
                            ],
                          },
                        ],
                      }
                    : card
                ),
              })
            ),
        })
      );
      expect(el.textContent).toContain(
        "Every lane left inheriting lands here · GPT-5 · medium"
      );
      expect(el.textContent).toContain("inherits Codex · GPT-5 · medium");
    });

    it("offers the resolved agent's models once a lane overrides the agent", async () => {
      const props = makeProps({
        loadStatus: vi
          .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
          .mockResolvedValue(
            makeStatusBothConnected({
              subsystemHarnessByKey: { ask: "claude-code" },
            })
          ),
      });
      const el = await mount(props);
      const model = sel(el, "Model for In-app Ask");
      expect(
        [...model.querySelectorAll("option")].map((o) => o.value)
      ).toContain("opus-4-8");
      expect(
        [...model.querySelectorAll("option")].map((o) => o.value)
      ).not.toContain("gpt-5-mini");
    });

    it("saves a subsystem model against the lane's resolved agent, not the default", async () => {
      const props = makeProps({
        loadStatus: vi
          .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
          .mockResolvedValue(
            makeStatusBothConnected({
              subsystemHarnessByKey: { ask: "claude-code" },
            })
          ),
      });
      const el = await mount(props);
      await pick(sel(el, "Model for In-app Ask"), "opus-4-8");
      expect(props.setSubsystemModel).toHaveBeenCalledWith(
        "claude-code",
        "ask",
        "opus-4-8"
      );
    });

    it("reports which lanes land on each agent instead of a single Active pill", async () => {
      const props = makeProps({
        loadStatus: vi
          .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
          .mockResolvedValue(
            makeStatusBothConnected({
              subsystemHarnessByKey: { builder: "claude-code" },
            })
          ),
      });
      const el = await mount(props);
      const [codex, claude] = [
        ...el.querySelectorAll(".usedBy"),
      ] as HTMLElement[];
      const codexChips = [
        ...(codex?.querySelectorAll(".usedByChip") ?? []),
      ].map((c) => c.textContent);
      expect(codexChips).toContain("Default");
      expect(codexChips).toContain("Assistant");
      expect(codexChips).not.toContain("Builder");
      const claudeChips = [
        ...(claude?.querySelectorAll(".usedByChip") ?? []),
      ].map((c) => c.textContent);
      expect(claudeChips).toStrictEqual(["Builder"]);
    });

    it("marks an agent nothing routes to as unused", async () => {
      const el = await mount(
        makeProps({
          loadStatus: vi
            .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
            .mockResolvedValue(makeStatusBothConnected()),
        })
      );
      const claude = [...el.querySelectorAll(".usedBy")][1] as HTMLElement;
      expect(claude.querySelector(".usedByNone")?.textContent).toBe("Unused");
    });

    it("saves an agent default model from the inventory", async () => {
      const props = makeProps();
      const el = await mount(props);
      await pick(sel(el, "Default model for Codex"), "gpt-5-mini");
      expect(props.setHarnessModel).toHaveBeenCalledWith("codex", "gpt-5-mini");
    });

    it("shows and saves effort only when the capability probe offers it", async () => {
      const withEffort = makeStatus({
        cards: makeStatus().cards.map((card) =>
          card.kind === "codex"
            ? {
                ...card,
                configOptions: [
                  {
                    id: "thought",
                    category: "thought_level",
                    type: "select",
                    currentValue: "medium",
                    values: [
                      { value: "medium", name: "Medium" },
                      { value: "high", name: "High" },
                    ],
                  },
                ],
              }
            : card
        ),
      });
      const props = makeProps({
        loadStatus: vi
          .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
          .mockResolvedValue({
            ...withEffort,
            subsystemHarnessByKey: { assistant: "codex" },
          }),
      });
      const el = await mount(props);
      await pick(sel(el, "Effort for Assistant"), "high");
      expect(props.setSubsystemConfigPin).toHaveBeenCalledWith(
        "codex",
        "assistant",
        "thought_level",
        "high"
      );
      await pick(sel(el, "Default effort for Codex"), "high");
      expect(props.setHarnessConfigPin).toHaveBeenCalledWith(
        "codex",
        "thought_level",
        "high"
      );
    });

    it("states “no thinking” instead of a select for a model with no thinking budget", async () => {
      const el = await mount(makeProps());
      expect(
        el.querySelector('[aria-label="Default effort for Codex"]')
      ).toBeNull();
      expect(el.textContent).toContain("no thinking");
      expect(el.querySelectorAll(".inertPick").length).toBeGreaterThan(0);
    });

    it("clamps a stored level the newly-picked model cannot do", async () => {
      const base = makeStatus();
      const withEffort: HarnessesStatusDTO = {
        ...base,
        defaultConfigPinsByKind: { codex: { thought_level: "xhigh" } },
        cards: base.cards.map((card) =>
          card.kind === "codex"
            ? {
                ...card,
                configOptions: [
                  {
                    id: "thought",
                    category: "thought_level",
                    type: "select",
                    values: [
                      { value: "medium", name: "Medium" },
                      { value: "high", name: "High" },
                    ],
                  },
                ],
              }
            : card
        ),
      };
      const props = makeProps({
        loadStatus: vi
          .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
          .mockResolvedValue(withEffort),
      });
      const el = await mount(props);
      await pick(sel(el, "Default model for Codex"), "gpt-5-mini");
      expect(props.setHarnessConfigPin).toHaveBeenCalledWith(
        "codex",
        "thought_level",
        ""
      );
    });

    it("keeps a stored level the model still offers", async () => {
      const base = makeStatus();
      const props = makeProps({
        loadStatus: vi
          .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
          .mockResolvedValue({
            ...base,
            defaultConfigPinsByKind: { codex: { thought_level: "high" } },
            cards: base.cards.map((card) =>
              card.kind === "codex"
                ? {
                    ...card,
                    configOptions: [
                      {
                        id: "thought",
                        category: "thought_level",
                        type: "select",
                        values: [{ value: "high", name: "High" }],
                      },
                    ],
                  }
                : card
            ),
          }),
      });
      const el = await mount(props);
      await pick(sel(el, "Default model for Codex"), "gpt-5-mini");
      expect(props.setHarnessConfigPin).not.toHaveBeenCalled();
    });

    it("restores the pick and states the gateway's own words when a model write is refused", async () => {
      const props = makeProps({
        setHarnessModel: vi
          .fn<SettingsHarnessesBridgeProps["setHarnessModel"]>()
          .mockResolvedValue("prefs.write refused: model not offered"),
      });
      const el = await mount(props);
      await pick(sel(el, "Default model for Codex"), "gpt-5-mini");
      await act(async () => {
        await Promise.resolve();
      });
      expect(sel(el, "Default model for Codex").value).toBe("gpt-5");
      expect(props.showToast).toHaveBeenCalledWith(
        "Model not saved: prefs.write refused: model not offered"
      );
    });

    it("restores the lane's agent when its write is refused", async () => {
      const props = makeProps({
        loadStatus: vi
          .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
          .mockResolvedValue(makeStatusBothConnected()),
        setSubsystemHarness: vi
          .fn<SettingsHarnessesBridgeProps["setSubsystemHarness"]>()
          .mockResolvedValue("prefs unavailable"),
      });
      const el = await mount(props);
      await pick(sel(el, "Agent for In-app Ask"), "claude-code");
      await act(async () => {
        await Promise.resolve();
      });
      expect(sel(el, "Agent for In-app Ask").value).toBe("");
      expect(props.showToast).toHaveBeenCalledWith(
        "Agent not saved: prefs unavailable"
      );
    });

    it("no longer exposes a per-harness tool listing — Connections owns that", async () => {
      const el = await mount(makeProps());
      expect(el.querySelector(".toolsToggle")).toBeNull();
      expect(el.querySelector(".groups")).toBeNull();
      expect(el.textContent).not.toContain("Refresh tools");
    });

    it("fires the model refresh", async () => {
      const props = makeProps();
      const el = await mount(props);
      await press(el, "Refresh");
      expect(props.refreshModels).toHaveBeenCalledOnce();
    });

    it("renders each agent card with its identity glyph tile", async () => {
      const el = await mount(makeProps());
      const tiles = el.querySelectorAll(".glyphTile");
      expect(tiles).toHaveLength(2);
      for (const tile of tiles) {
        expect(tile.querySelector("svg")).toBeTruthy();
      }
      expect(el.querySelector('.glyphTile[data-unavail="true"]')).toBeTruthy();
    });

    it("falls back to a generic glyph for a kind this build has no artwork for", async () => {
      const base = makeStatus();
      const el = await mount(
        makeProps({
          loadStatus: vi
            .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
            .mockResolvedValue({
              ...base,
              cards: [
                {
                  kind: "some-future-harness",
                  title: "Some Future Harness",
                  accent: "#64748b",
                  subtitle: "detected",
                  connected: true,
                  sessionReady: true,
                  modelsLoading: false,
                  models: [],
                },
              ],
            }),
        })
      );
      const tile = el.querySelector(".glyphTile");
      expect(tile).toBeTruthy();
      expect(tile?.querySelector("svg")).toBeTruthy();
    });

    it("lists a harness kind this build predates, disabled until it is available", async () => {
      const base = makeStatus();
      const el = await mount(
        makeProps({
          loadStatus: vi
            .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
            .mockResolvedValue({
              ...base,
              cards: [
                ...base.cards,
                {
                  kind: "some-future-harness",
                  title: "Some Future Harness",
                  accent: "#64748b",
                  subtitle: "Install it and run it once.",
                  connected: false,
                  sessionReady: false,
                  modelsLoading: false,
                  models: [],
                },
              ],
            }),
        })
      );
      const opts = [
        ...sel(el, "Agent for In-app Ask").querySelectorAll("option"),
      ];
      const future = opts.find((o) => o.value === "some-future-harness");
      expect(future).toBeTruthy();
      expect(future?.disabled).toBe(true);
      expect(future?.textContent).toContain("unavailable");
    });
  });
});
