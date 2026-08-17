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

// Ladder membership is a consent decision, so it goes through the shell's own
// confirm dialog (not `window.confirm`) — mocked here to drive the answer.
const dialog = vi.hoisted(() => ({
  openConfirm: vi.fn<typeof TypeImport_in5dl4.openConfirm>(),
}));
vi.mock(import("../shell/confirm.js"), () => dialog);

/** `makeStatusBothConnected`, but Claude Code is also past its session preflight. */
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

/** makeStatus, but with Claude Code present so it can be routed to. */
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
    // Every writer resolves to the gateway's own text on refusal and `null`
    // when it wrote — a green mock is a write that landed.
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

  function sel(el: HTMLElement, label: string): HTMLSelectElement {
    const found = el.querySelector(`select[aria-label="${label}"]`);
    if (!found) throw new Error(`no select labelled "${label}"`);
    return found as HTMLSelectElement;
  }

  /** Drive a native <select> the way React's onChange listener expects. */
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
    it("renders a routing lane per subsystem plus the default lane, and the agent inventory", async () => {
      const el = await mount(makeProps());
      // 1 default lane + 3 routed lanes. Builder has no row — its entry
      // points are hidden by default (#434), so the control configured a
      // surface the member cannot open.
      expect(el.querySelectorAll(".routeRow")).toHaveLength(4);
      expect(el.querySelector('.routeRow[data-default="true"]')).toBeTruthy();
      expect(el.textContent).toContain("Routing");
      for (const label of ["Assistant", "In-app Ask", "Automations"]) {
        expect(el.textContent).toContain(label);
      }
      expect(el.querySelector('[aria-label="Agent for Builder"]')).toBeNull();
      // Inventory still lists every detected agent with its default model.
      expect(el.querySelectorAll(".entry")).toHaveLength(2);
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
      // The default lane is untouched — this is the whole point of the change.
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
      // Attended lanes recover at the next turn with the member watching, so
      // there is nothing to pre-authorize; only Automations fires unattended.
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
      await pick(sel(el, "Add fallback agent for Automations"), "claude-code");
      await act(async () => {
        await Promise.resolve();
      });
      expect(el.textContent).toContain("Claude Code was not added");
      expect(props.setSubsystemHarnessLadder).not.toHaveBeenCalled();
    });

    it("will not offer an agent that has not passed its session preflight as a fallback", async () => {
      // Unattended failover has nobody to answer an auth prompt, so `connected`
      // alone is not enough to join the ladder.
      const props = makeProps({
        loadStatus: vi
          .fn<SettingsHarnessesBridgeProps["loadStatus"]>()
          .mockResolvedValue(makeStatusBothConnected()),
      });
      const el = await mount(props);
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
      // D13: membership IS the consent record — filtering the resolved primary
      // out of the display made the UI disagree with what the gateway holds.
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
      expect(
        el.querySelector(
          '[aria-label="Remove Codex from Automations failover"]'
        )
      ).toBeTruthy();
      // …and an edit re-saves the same membership rather than silently pruning it.
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

    it('names what an inheriting lane resolves to rather than saying "use default"', async () => {
      const el = await mount(makeProps());
      // The visible Agent control's inherit option names the default harness…
      const harness = sel(el, "Agent for Assistant");
      expect(harness.value).toBe("");
      expect(harness.querySelector('option[value=""]')?.textContent).toBe(
        "Use default · Codex"
      );
      // …and the model inherit option names the resolved agent's default model.
      expect(
        sel(el, "Model for In-app Ask").querySelector('option[value=""]')
          ?.textContent
      ).toBe("Use default · GPT-5");
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
      // Claude Code's model, not Codex's — the lane resolved to a new agent.
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
      // Keyed by 'claude-code' (the lane's resolved agent) — not 'codex' (the
      // default). Writing it against the default would strand the override.
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
        ...el.querySelectorAll(".entry"),
      ] as HTMLElement[];
      // Codex is the default and keeps the three lanes that inherit.
      const codexChips = [
        ...(codex?.querySelectorAll(".usedByChip") ?? []),
      ].map((c) => c.textContent);
      expect(codexChips).toContain("Default");
      expect(codexChips).toContain("Assistant");
      expect(codexChips).not.toContain("Builder");
      // Claude Code holds only the lane pointed at it.
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
      const claude = [...el.querySelectorAll(".entry")][1] as HTMLElement;
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
          .mockResolvedValue(withEffort),
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
      // A pick with nothing to open is not a pick: the harness advertises no
      // `thought_level` option, so the row states the fact rather than
      // rendering a dead control that looks openable.
      const el = await mount(makeProps());
      expect(
        el.querySelector('[aria-label="Effort for Assistant"]')
      ).toBeNull();
      expect(el.textContent).toContain("no thinking");
      expect(el.querySelectorAll(".inertPick").length).toBeGreaterThan(0);
    });

    it("clamps a stored level the newly-picked model cannot do", async () => {
      // `xhigh` is pinned but the probe offers medium/high only, so changing
      // the model drops the pin back to inherit rather than displaying a level
      // the runtime would silently ignore.
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
      // Back where the gateway has it…
      expect(sel(el, "Default model for Codex").value).toBe("gpt-5");
      // …and the refusal is quoted, not swallowed.
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
      const buttons = [
        ...el.querySelectorAll(".actionsRow .btn"),
      ] as HTMLButtonElement[];
      expect(buttons).toHaveLength(2);
      await act(async () =>
        buttons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      expect(props.refreshModels).toHaveBeenCalledOnce();
    });

    it("renders each agent card with its identity glyph tile", async () => {
      const el = await mount(makeProps());
      const tiles = el.querySelectorAll(".glyphTile");
      // One tile per inventory entry, each holding a vendored glyph svg.
      expect(tiles).toHaveLength(2);
      for (const tile of tiles) {
        expect(tile.querySelector("svg")).toBeTruthy();
      }
      // The unavailable agent's tile is muted rather than dropped.
      const [, claude] = [...el.querySelectorAll(".entry")] as HTMLElement[];
      expect(
        claude?.querySelector('.glyphTile[data-unavail="true"]')
      ).toBeTruthy();
    });

    it("falls back to a generic glyph for a kind this build has no artwork for", async () => {
      const base = makeStatus();
      // A kind with no entry in HARNESS_GLYPHS must still render an svg, not throw.
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
      const tile = el.querySelector(".entry .glyphTile");
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
      // It reaches the pickers rather than being filtered out as unrecognised…
      const opts = [
        ...sel(el, "Agent for In-app Ask").querySelectorAll("option"),
      ];
      const future = opts.find((o) => o.value === "some-future-harness");
      expect(future).toBeTruthy();
      // …and an unavailable agent is offered disabled, not silently missing.
      expect(future?.disabled).toBe(true);
      expect(future?.textContent).toContain("unavailable");
    });
  });
});
