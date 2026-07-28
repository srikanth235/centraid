// governance: allow-repo-hygiene file-size-limit (#567) one Automation Q&A route suite shares the mocked bridge and persistence fixture across runner, model, effort, provider-consent, and reload cases
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AutomationThreadScreenProps } from "../../screens/AutomationThreadScreen.js";
import type { ShellActions } from "../actions.js";

const captured = vi.hoisted(() => ({
  props: null as AutomationThreadScreenProps | null,
}));
const actions = vi.hoisted(() => ({
  confirm: vi.fn<ShellActions["confirm"]>(),
  navigate: vi.fn<ShellActions["navigate"]>(),
  showToast: vi.fn<ShellActions["showToast"]>(),
}));
const api = vi.hoisted(() => ({
  auth: vi.fn<typeof import("../../../gateway-client.js").auth>(),
  compileAutomation:
    vi.fn<typeof import("../../../gateway-client.js").compileAutomation>(),
  deleteAutomation:
    vi.fn<typeof import("../../../gateway-client.js").deleteAutomation>(),
  listAutomationTurns:
    vi.fn<typeof import("../../../gateway-client.js").listAutomationTurns>(),
  readAutomationTurnExpanded:
    vi.fn<
      typeof import("../../../gateway-client.js").readAutomationTurnExpanded
    >(),
  readGatewayCapabilities:
    vi.fn<
      typeof import("../../../gateway-client.js").readGatewayCapabilities
    >(),
  rotateAutomationWebhookSecret:
    vi.fn<
      typeof import("../../../gateway-client.js").rotateAutomationWebhookSecret
    >(),
  runAutomationNow:
    vi.fn<typeof import("../../../gateway-client.js").runAutomationNow>(),
  setAutomationEnabled:
    vi.fn<typeof import("../../../gateway-client.js").setAutomationEnabled>(),
  streamAutomationConversationTurn:
    vi.fn<
      typeof import("../../../gateway-client.js").streamAutomationConversationTurn
    >(),
  streamAutomationTurn:
    vi.fn<typeof import("../../../gateway-client.js").streamAutomationTurn>(),
}));
const helpers = vi.hoisted(() => ({
  automationLiveMessages:
    vi.fn<
      typeof import("./automationLiveMessages.js").automationLiveMessages
    >(),
  automationTurnMessages:
    vi.fn<
      typeof import("./automationTurnMessages.js").automationTurnMessages
    >(),
  createLiveTrace:
    vi.fn<
      typeof import("./automationLiveMessages.js").createAutomationLiveTrace
    >(),
  createLiveTraceFromItems:
    vi.fn<
      typeof import("./automationLiveMessages.js").createAutomationLiveTraceFromItems
    >(),
  decideConsent:
    vi.fn<typeof import("./automationThreadData.js").decideConsentItem>(),
  deriveHero:
    vi.fn<typeof import("./automationsData.js").deriveAutomationHero>(),
  finishLiveItem:
    vi.fn<
      typeof import("./automationLiveMessages.js").finishAutomationLiveItem
    >(),
  finishLiveTrace:
    vi.fn<
      typeof import("./automationLiveMessages.js").finishAutomationLiveTrace
    >(),
  loadThread:
    vi.fn<
      typeof import("./automationThreadData.js").loadAutomationThreadData
    >(),
  loadProviders:
    vi.fn<typeof import("./settingsProvidersData.js").loadProviders>(),
  openWebhookReveal:
    vi.fn<typeof import("../webhookReveal.js").openWebhookReveal>(),
  reduceItem:
    vi.fn<
      typeof import("./automationLiveMessages.js").reduceAutomationItemEvent
    >(),
  reduceTurn:
    vi.fn<
      typeof import("./automationLiveMessages.js").reduceAutomationTurnEvent
    >(),
  startLiveItem:
    vi.fn<
      typeof import("./automationLiveMessages.js").startAutomationLiveItem
    >(),
}));

vi.mock(import("../../../gateway-client.js") as Promise<unknown>, () => api);
vi.mock(import("../actions.js") as Promise<unknown>, () => ({
  useShellActions: () => actions,
}));
vi.mock(import("../PageScroll.js") as Promise<unknown>, () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock(
  import("../../screens/AutomationThreadScreen.js") as Promise<unknown>,
  () => ({
    default: (props: AutomationThreadScreenProps) => {
      captured.props = props;
      return null;
    },
  })
);
vi.mock(import("./automationThreadData.js") as Promise<unknown>, () => ({
  decideConsentItem: helpers.decideConsent,
  loadAutomationThreadData: helpers.loadThread,
}));
vi.mock(import("./automationsData.js") as Promise<unknown>, () => ({
  deriveAutomationHero: helpers.deriveHero,
}));
// Partial: only the projection is stubbed. `automationTurnInboundText` is the
// shared cold/live agreement on a compile turn's inbound bubble (#541) — the
// route must exercise the real one.
vi.mock(
  import("./automationTurnMessages.js") as Promise<unknown>,
  async (importOriginal) => ({
    ...(await importOriginal<typeof import("./automationTurnMessages.js")>()),
    automationTurnMessages: helpers.automationTurnMessages,
  })
);
vi.mock(import("./automationLiveMessages.js") as Promise<unknown>, () => ({
  automationLiveMessages: helpers.automationLiveMessages,
  createAutomationLiveTrace: helpers.createLiveTrace,
  createAutomationLiveTraceFromItems: helpers.createLiveTraceFromItems,
  finishAutomationLiveItem: helpers.finishLiveItem,
  finishAutomationLiveTrace: helpers.finishLiveTrace,
  reduceAutomationItemEvent: helpers.reduceItem,
  reduceAutomationTurnEvent: helpers.reduceTurn,
  startAutomationLiveItem: helpers.startLiveItem,
}));
vi.mock(import("../webhookReveal.js") as Promise<unknown>, () => ({
  openWebhookReveal: helpers.openWebhookReveal,
}));
vi.mock(
  import("./settingsProvidersData.js") as Promise<unknown>,
  async (importOriginal) => ({
    ...(await importOriginal<typeof import("./settingsProvidersData.js")>()),
    loadProviders: helpers.loadProviders,
  })
);

const {
  automationPicker,
  latestAdapterKind,
  default: AutomationViewRoute,
} = await import("./AutomationViewRoute.js");

function automationRow(): CentraidAutomationRow {
  const triggers: CentraidAutomationManifest["triggers"] = [
    { kind: "cron", expr: "0 9 * * *" },
  ];
  return {
    id: "daily",
    dir: "/apps/daily",
    name: "Daily",
    triggers,
    enabled: false,
    ownerApp: "daily",
    ref: "daily/daily",
    manifest: {
      name: "Daily",
      version: "0.1.0",
      enabled: false,
      prompt: "Run daily.",
      triggers,
      requires: {},
      history: { keep: { count: 10 } },
      generated: { by: "agent", at: "2026-07-25T00:00:00.000Z" },
    },
  };
}

const turn = {
  turnId: "turn-1",
  conversationId: "conversation-1",
  automationId: "daily/daily",
  triggerKind: "manual",
  seq: 1,
  startedAt: 100,
  endedAt: 120,
  ok: true,
  pinned: false,
} satisfies CentraidAutomationTurnRecord;

const item = {
  itemId: "item-1",
  turnId: "turn-1",
  ordinal: 0,
  kind: "message_in",
  text: "Run now",
  ok: true,
  startedAt: 100,
  endedAt: 101,
  durationMs: 1,
} satisfies CentraidAutomationItem;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(): Promise<AutomationThreadScreenProps> {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<AutomationViewRoute automationId="daily/daily" />);
  });
  if (!captured.props) throw new Error("thread bridge was not captured");
  return captured.props;
}
describe("AutomationViewRoute suite", () => {
  beforeEach(() => {
    captured.props = null;
    actions.confirm.mockReset().mockResolvedValue(true);
    actions.navigate.mockReset();
    actions.showToast.mockReset();

    api.auth.mockReset().mockResolvedValue({ baseUrl: "https://gateway.test" });
    api.compileAutomation
      .mockReset()
      .mockResolvedValue({ compileTurnId: "compile-1" });
    api.deleteAutomation.mockReset().mockResolvedValue({ ok: true });
    api.listAutomationTurns.mockReset().mockResolvedValue([
      { ...turn, totalInputTokens: 12, totalOutputTokens: 8 },
      {
        ...turn,
        turnId: "turn-zero",
        totalInputTokens: 0,
        totalOutputTokens: 0,
      },
    ]);
    api.readAutomationTurnExpanded.mockReset().mockResolvedValue({
      turn,
      items: [item],
    });
    api.readGatewayCapabilities.mockReset().mockResolvedValue({
      webSessions: true,
      devicePairing: true,
      tunnel: true,
      backupWal: true,
      automationTurns: true,
    });
    api.rotateAutomationWebhookSecret.mockReset().mockResolvedValue({
      webhook: {
        id: "hook-1",
        secret: "secret-2",
        url: "https://gateway.test/hook-1",
      },
    });
    api.runAutomationNow.mockReset().mockResolvedValue({ turnId: "turn-2" });
    api.setAutomationEnabled.mockReset().mockResolvedValue({ ok: true });
    api.streamAutomationConversationTurn
      .mockReset()
      .mockImplementation(async (_automationId, _text, onEvent, _signal) => {
        onEvent({ type: "assistant.delta", delta: "Done" });
        return { turnId: "turn-3", ended: true };
      });
    api.streamAutomationTurn
      .mockReset()
      .mockImplementation(async (_turnId, onEvent, _signal) => {
        onEvent({
          type: "item.start",
          itemId: "tool-1",
          ordinal: 1,
          kind: "tool",
          name: "vault.query",
          callId: "call-1",
        });
        onEvent({
          type: "item.delta",
          itemId: "tool-1",
          ordinal: 1,
          event: { type: "tool.delta", delta: "working" },
        });
        onEvent({
          type: "item.end",
          itemId: "tool-1",
          ordinal: 1,
          callId: "call-1",
          ok: true,
          durationMs: 5,
        });
        onEvent({ type: "turn.end", turnId: "turn-1", ok: true });
      });

    helpers.automationLiveMessages
      .mockReset()
      .mockReturnValue([{ kind: "ai", streaming: true, text: "live" }]);
    helpers.automationTurnMessages
      .mockReset()
      .mockReturnValue([{ kind: "ai", streaming: true, text: "cold" }]);
    helpers.createLiveTrace
      .mockReset()
      .mockReturnValue({ message: "new", items: new Map() });
    helpers.createLiveTraceFromItems
      .mockReset()
      .mockReturnValue({ message: "items", items: new Map() });
    helpers.decideConsent.mockReset().mockResolvedValue(true);
    helpers.deriveHero.mockReset().mockReturnValue({
      conditionDetail: null,
      cronExprs: ["0 9 * * *"],
      dataDetail: null,
      nextRuns: [],
      webhook: null,
      kindEyebrow: "Scheduled",
      heroIcon: "clock",
      when: "Every day",
    });
    helpers.finishLiveItem
      .mockReset()
      .mockReturnValue({ message: "finished-item", items: new Map() });
    helpers.finishLiveTrace
      .mockReset()
      .mockReturnValue({ message: "finished", items: new Map() });
    helpers.loadThread.mockReset().mockResolvedValue({
      row: automationRow(),
      data: {
        consent: { grants: [], outbox: [], parked: [] },
        header: {
          id: "daily",
          ref: "daily/daily",
          enabled: false,
          name: "Daily",
          glyphIcon: "clock",
          hue: "blue",
          statusKind: "paused",
          statusLabel: "Paused",
          description: null,
          kindEyebrow: "Scheduled",
          heroIcon: "clock",
          nextRuns: [],
          triggerSummary: "Every day",
          webhook: null,
          entityTags: [],
        },
        runs: [],
        plan: { state: "ready", label: "Plan ready", detail: null },
      },
    });
    helpers.loadProviders.mockReset().mockResolvedValue({
      selectedKind: "codex",
      anyLoading: false,
      savedModelByKind: {},
      subsystemModelByKind: {},
      defaultConfigPinsByKind: {},
      subsystemConfigPinsByKind: {},
      diagnosticsJson: "{}",
      subsystemRunnerByKey: { automations: "codex" },
      subsystemRunnerLadders: {},
      cards: [
        {
          kind: "codex",
          title: "Codex",
          accent: "#10b981",
          subtitle: "ready",
          connected: true,
          sessionReady: true,
          modelsLoading: false,
          models: [],
        },
        {
          kind: "copilot",
          title: "Copilot",
          accent: "#111827",
          subtitle: "ready",
          connected: true,
          sessionReady: true,
          modelsLoading: false,
          models: [],
        },
      ],
    });
    helpers.openWebhookReveal.mockReset().mockResolvedValue(undefined);
    helpers.reduceItem
      .mockReset()
      .mockReturnValue({ message: "delta", items: new Map() });
    helpers.reduceTurn
      .mockReset()
      .mockReturnValue({ message: "conversation", items: new Map() });
    helpers.startLiveItem
      .mockReset()
      .mockReturnValue({ message: "started", items: new Map() });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  describe("AutomationViewRoute", () => {
    it("drops provider-specific manifest pins after an attended cross-provider switch", () => {
      const status = {
        selectedKind: "codex",
        anyLoading: false,
        savedModelByKind: {},
        subsystemModelByKind: { copilot: { automations: "copilot-default" } },
        defaultConfigPinsByKind: {},
        subsystemConfigPinsByKind: {
          copilot: { automations: { thought_level: "medium" } },
        },
        diagnosticsJson: "{}",
        subsystemRunnerByKey: { automations: "codex" },
        subsystemRunnerLadders: {},
        cards: [
          {
            kind: "codex",
            title: "Codex",
            accent: "#10b981",
            subtitle: "ready",
            connected: true,
            sessionReady: true,
            modelConfigurable: true,
            modelsLoading: false,
            models: [{ id: "gpt-a" }],
            configOptions: [
              {
                id: "thought",
                category: "thought_level",
                type: "select",
                values: [{ value: "high" }],
              },
            ],
          },
          {
            kind: "copilot",
            title: "Copilot",
            accent: "#111827",
            subtitle: "ready",
            connected: true,
            sessionReady: true,
            modelConfigurable: true,
            modelsLoading: false,
            models: [{ id: "copilot-default" }],
            configOptions: [
              {
                id: "thought",
                category: "thought_level",
                type: "select",
                values: [{ value: "medium" }],
              },
            ],
          },
        ],
      } satisfies import("../../screen-contracts.js").AgentsStatusDTO;
      expect(
        automationPicker(status, "codex", {
          runner: "codex",
          model: "gpt-a",
          thoughtLevel: "high",
        })
      ).toMatchObject({
        selectedModelId: "gpt-a",
        selectedEffortId: "high",
        modelLocked: true,
        effortLocked: true,
      });
      expect(
        automationPicker(status, "copilot", {
          runner: "codex",
          model: "gpt-a",
          thoughtLevel: "high",
        })
      ).toMatchObject({
        selectedRunnerKind: "copilot",
        selectedModelId: "copilot-default",
        selectedEffortId: "medium",
      });
      expect(
        automationPicker(status, "copilot", {
          runner: "codex",
          model: "gpt-a",
          thoughtLevel: "high",
        })
      ).not.toMatchObject({ modelLocked: true, effortLocked: true });
    });

    it("resolves an unregistered manifest runner to a reported fallback and keeps its pins", () => {
      const status = {
        selectedKind: "codex",
        anyLoading: false,
        savedModelByKind: {},
        subsystemModelByKind: {},
        defaultConfigPinsByKind: {},
        subsystemConfigPinsByKind: {},
        diagnosticsJson: "{}",
        subsystemRunnerByKey: { automations: "codex" },
        subsystemRunnerLadders: {},
        cards: [
          {
            kind: "codex",
            title: "Codex",
            accent: "#10b981",
            subtitle: "ready",
            connected: true,
            sessionReady: true,
            modelConfigurable: true,
            modelsLoading: false,
            models: [{ id: "gpt-a" }],
            configOptions: [
              {
                id: "thought",
                category: "thought_level",
                type: "select",
                values: [{ value: "high" }],
              },
            ],
          },
        ],
      } satisfies import("../../screen-contracts.js").AgentsStatusDTO;
      expect(
        automationPicker(status, "future-runner", {
          runner: "future-runner",
          model: "gpt-a",
          thoughtLevel: "high",
        })
      ).toMatchObject({
        selectedRunnerKind: "codex",
        selectedModelId: "gpt-a",
        selectedEffortId: "high",
        modelLocked: true,
        effortLocked: true,
      });
    });

    it("loads the thread and drives lifecycle, cold/live trace, and steering actions", async () => {
      const bridge = await mount();
      await expect(bridge.loadData()).resolves.toMatchObject({
        automationTurns: true,
        runTokens: { "turn-1": 20 },
        triggerDetail: { cronExprs: ["0 9 * * *"] },
      });

      bridge.onBack();
      bridge.onOpenCompiler();
      bridge.onOpenRun("turn-1");
      await expect(bridge.loadTurnTrace("turn-1")).resolves.toStrictEqual([
        { kind: "ai", streaming: true, text: "cold" },
      ]);

      const watched: unknown[] = [];
      await bridge.watchTurn(
        "turn-1",
        (messages) => watched.push(messages),
        new AbortController().signal
      );
      expect(api.streamAutomationTurn).toHaveBeenCalledWith(
        "turn-1",
        expect.any(Function),
        expect.any(AbortSignal)
      );
      expect(helpers.startLiveItem).toHaveBeenCalledOnce();
      expect(helpers.reduceItem).toHaveBeenCalledOnce();
      expect(helpers.finishLiveItem).toHaveBeenCalledOnce();
      expect(watched.length).toBeGreaterThan(0);

      bridge.onCopyWebhook("https://gateway.test/hook-1");
      await vi.waitFor(() =>
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
          "https://gateway.test/hook-1"
        )
      );
      await expect(bridge.onRunNow()).resolves.toBe("turn-2");
      await expect(bridge.onToggleEnabled(true)).resolves.toBe(true);
      await expect(
        bridge.onDecideConsent("outbox", "item-1", "approve", true)
      ).resolves.toBe(true);

      const conversationalMessages: unknown[] = [];
      await expect(
        bridge.onAskAboutRuns(
          "What happened?",
          {},
          (messages: unknown) => conversationalMessages.push(messages),
          new AbortController().signal
        )
      ).resolves.toBe("turn-3");
      expect(api.streamAutomationConversationTurn).toHaveBeenCalledWith(
        "daily/daily",
        "What happened?",
        expect.any(Function),
        expect.any(AbortSignal),
        undefined,
        {}
      );
      expect(conversationalMessages.length).toBeGreaterThan(1);

      // The run screen cannot revise or compile: those endpoints are not reachable
      // from this route at all any more (they live on the editor route).
      expect(api.compileAutomation).not.toHaveBeenCalled();

      await expect(bridge.onRotateWebhook()).resolves.toBe(true);
      await expect(bridge.onDelete()).resolves.toBe(true);
      expect(actions.navigate).toHaveBeenCalledWith({ kind: "automations" });
    });

    it("restores the persisted conversation runner ahead of subsystem defaults", async () => {
      api.listAutomationTurns.mockResolvedValueOnce([
        { ...turn, adapterKind: "copilot" },
      ]);
      const bridge = await mount();
      await expect(bridge.loadData()).resolves.toMatchObject({
        runnerConfig: { selectedRunnerKind: "copilot" },
      });
    });

    it("binds the runner to the latest run that recorded an adapter, not list order", () => {
      const runs = [
        {
          ...turn,
          turnId: "newest",
          seq: 3,
          startedAt: 300,
          adapterKind: "copilot",
        },
        {
          ...turn,
          turnId: "older",
          seq: 2,
          startedAt: 200,
          adapterKind: "codex",
        },
        { ...turn, turnId: "no-adapter", seq: 4, startedAt: 400 },
      ];
      expect(latestAdapterKind(runs)).toBe("copilot");
      // Same answer whichever order the feed arrives in.
      expect(latestAdapterKind(runs.toReversed())).toBe("copilot");
      expect(latestAdapterKind([{ ...turn }])).toBeUndefined();
    });

    it("resends an ask with every provider approved so far, and stops on a decline", async () => {
      const consentPerAttempt = ["claude-code", "copilot", null];
      let attempt = 0;
      api.streamAutomationConversationTurn.mockImplementation(
        async (_automationId, _text, onEvent, _signal) => {
          const provider = consentPerAttempt[attempt++] ?? null;
          if (provider) {
            onEvent({
              type: "consent.required",
              consentKind: "provider-egress",
              provider,
              reason: "ladder",
              message: `${provider} needs approval.`,
            });
            return { ended: true };
          }
          onEvent({ type: "assistant.delta", delta: "Done" });
          return { turnId: "turn-3", ended: true };
        }
      );
      const bridge = await mount();
      await bridge.loadData();

      await expect(
        bridge.onAskAboutRuns(
          "What happened?",
          {},
          vi.fn<Parameters<AutomationThreadScreenProps["onAskAboutRuns"]>[2]>(),
          new AbortController().signal
        )
      ).resolves.toBe("turn-3");
      expect(actions.confirm).toHaveBeenCalledTimes(2);
      expect(
        api.streamAutomationConversationTurn.mock.calls.map(
          (call: unknown[]) => call[4]
        )
      ).toStrictEqual([undefined, "claude-code", ["claude-code", "copilot"]]);

      // A decline sends nothing further and yields no turn.
      api.streamAutomationConversationTurn.mockClear();
      attempt = 0;
      actions.confirm.mockResolvedValue(false);
      await expect(
        bridge.onAskAboutRuns(
          "And then?",
          {},
          vi.fn<Parameters<AutomationThreadScreenProps["onAskAboutRuns"]>[2]>(),
          new AbortController().signal
        )
      ).resolves.toBeNull();
      expect(api.streamAutomationConversationTurn).toHaveBeenCalledOnce();
    });

    it("returns null when the automation disappears and guards actions before load", async () => {
      helpers.loadThread.mockResolvedValueOnce(null);
      const bridge = await mount();
      await expect(bridge.loadData()).resolves.toBeNull();
      await expect(bridge.onRunNow()).resolves.toBeNull();
      await expect(bridge.onToggleEnabled(true)).resolves.toBe(false);
      await expect(bridge.onDelete()).resolves.toBe(false);
      await expect(
        bridge.onAskAboutRuns(
          "hello",
          {},
          vi.fn<Parameters<AutomationThreadScreenProps["onAskAboutRuns"]>[2]>(),
          new AbortController().signal
        )
      ).resolves.toBeNull();
    });
  });
});
