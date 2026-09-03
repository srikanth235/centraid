import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CentraidConversationSummary } from "../../../centraid-api.js";
import type { TurnStreamEvent } from "../../../gateway-client.js";
import type * as TypeImport_1gl5zx7 from "../../../gateway-client.js";
import type {
  AssistantBridgeProps,
  AssistantSnapshot,
} from "../../screen-contracts.js";
import type { ShellActions } from "../actions.js";
import type * as TypeImport_g611bp from "../prompt.js";
import type * as TypeImport_ym9bw8 from "./settingsHarnessesData.js";

const captured = vi.hoisted(() => ({
  props: null as AssistantBridgeProps | null,
  snapshot: null as AssistantSnapshot | null,
  snapshots: [] as AssistantSnapshot[],
}));
const actions = vi.hoisted(() => ({
  confirm: vi.fn<ShellActions["confirm"]>(),
  navigate: vi.fn<ShellActions["navigate"]>(),
  replace: vi.fn<NonNullable<ShellActions["replace"]>>(),
  refreshAssistantThreads:
    vi.fn<NonNullable<ShellActions["refreshAssistantThreads"]>>(),
  showToast: vi.fn<ShellActions["showToast"]>(),
}));
const api = vi.hoisted(() => ({
  ASSISTANT_APP_ID: "_assistant",
  MAX_ATTACHMENT_BYTES: 25 * 1024 * 1024,
  conversationStatus: vi.fn<typeof TypeImport_1gl5zx7.conversationStatus>(),
  createConversation: vi.fn<typeof TypeImport_1gl5zx7.createConversation>(),
  fetchAssistantAttachmentUrl:
    vi.fn<typeof TypeImport_1gl5zx7.fetchAssistantAttachmentUrl>(),
  getUserPrefs: vi.fn<typeof TypeImport_1gl5zx7.getUserPrefs>(),
  loadConversation: vi.fn<typeof TypeImport_1gl5zx7.loadConversation>(),
  renameConversation: vi.fn<typeof TypeImport_1gl5zx7.renameConversation>(),
  searchVaultEntities: vi.fn<typeof TypeImport_1gl5zx7.searchVaultEntities>(),
  setConversationFeedback:
    vi.fn<typeof TypeImport_1gl5zx7.setConversationFeedback>(),
  streamAssistantTurn: vi.fn<typeof TypeImport_1gl5zx7.streamAssistantTurn>(),
  uploadConversationAttachment:
    vi.fn<typeof TypeImport_1gl5zx7.uploadConversationAttachment>(),
}));
const providers = vi.hoisted(() => ({
  loadHarnesses: vi.fn<typeof TypeImport_ym9bw8.loadHarnesses>(),
  setSubsystemConfigPin:
    vi.fn<typeof TypeImport_ym9bw8.setSubsystemConfigPin>(),
  setSubsystemModel: vi.fn<typeof TypeImport_ym9bw8.setSubsystemModel>(),
}));

vi.mock(import("../../../gateway-client.js") as Promise<unknown>, () => api);
vi.mock(import("../actions.js") as Promise<unknown>, () => ({
  useShellActions: () => actions,
}));
vi.mock(import("../prompt.js") as Promise<unknown>, () => ({
  openPrompt: vi.fn<typeof TypeImport_g611bp.openPrompt>(),
}));
vi.mock(
  import("./settingsHarnessesData.js") as Promise<unknown>,
  async (importOriginal) => ({
    ...(await importOriginal<typeof TypeImport_ym9bw8>()),
    loadHarnesses: providers.loadHarnesses,
    setSubsystemConfigPin: providers.setSubsystemConfigPin,
    setSubsystemModel: providers.setSubsystemModel,
  })
);
vi.mock(import("../../screens/AssistantScreen.js") as Promise<unknown>, () => ({
  default: (props: AssistantBridgeProps) => {
    captured.props = props;
    props.onReady((snapshot) => {
      captured.snapshot = snapshot;
      captured.snapshots.push(snapshot);
    });
    return null;
  },
}));

const { default: AssistantRoute } = await import("./AssistantRoute.js");

type Stream = (
  input: { providerConsent?: string | string[]; idempotencyKey?: string },
  onEvent: (event: TurnStreamEvent) => void
) => Promise<{ ended: boolean }>;

type HarnessStatus = Awaited<
  ReturnType<typeof TypeImport_ym9bw8.loadHarnesses>
>;

function harnessCard(
  kind: string,
  title = kind
): HarnessStatus["cards"][number] {
  return {
    kind,
    title,
    accent: "#10b981",
    subtitle: "ready",
    connected: true,
    sessionReady: true,
    modelsLoading: false,
    models: [],
  };
}

function harnessStatus(kinds: Array<[string, string?]>): HarnessStatus {
  return {
    selectedKind: "codex",
    anyLoading: false,
    savedModelByKind: {},
    subsystemModelByKind: {},
    defaultConfigPinsByKind: {},
    subsystemConfigPinsByKind: {},
    diagnosticsJson: "{}",
    subsystemHarnessByKey: { assistant: "codex" },
    subsystemHarnessLadders: {},
    cards: kinds.map(([kind, title]) => harnessCard(kind, title)),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((_resolve) => {
    resolve = _resolve;
  });
  return { promise, resolve };
}

function streamAskingFor(...consentPerAttempt: Array<string | null>): Stream {
  let attempt = 0;
  return async (_input, onEvent) => {
    const provider = consentPerAttempt[attempt++] ?? null;
    if (provider) {
      onEvent({
        type: "consent.required",
        consentKind: "provider-egress",
        provider,
        reason: "ladder",
        message: `${provider} needs approval.`,
      });
    } else {
      onEvent({ type: "final", text: "Answered." });
    }
    return { ended: true };
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function conversation(
  overrides: Partial<CentraidConversationSummary> = {}
): CentraidConversationSummary {
  return {
    id: "conversation-1",
    originAppId: null,
    title: "Assistant",
    harnessKind: null,
    harnessSessionId: null,
    turnCount: 0,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    hydrationCount: 0,
    ...overrides,
  };
}

async function mount(conversationId?: string): Promise<AssistantBridgeProps> {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(
      <AssistantRoute
        {...(conversationId === undefined ? {} : { conversationId })}
      />
    );
  });
  if (!captured.props) throw new Error("assistant bridge was not captured");
  return captured.props;
}

function consentPerCall(): Array<string | string[] | undefined> {
  return api.streamAssistantTurn.mock.calls.map(
    (call) =>
      (call[0] as { providerConsent?: string | string[] }).providerConsent
  );
}
describe("AssistantRoute suite", () => {
  beforeEach(() => {
    captured.props = null;
    captured.snapshot = null;
    captured.snapshots = [];
    actions.confirm.mockReset().mockResolvedValue(true);
    actions.navigate.mockReset();
    actions.replace.mockReset();
    actions.refreshAssistantThreads.mockReset();
    actions.showToast.mockReset();

    api.conversationStatus
      .mockReset()
      .mockResolvedValue({ turnCount: 1, updatedAt: 1 });
    api.createConversation.mockReset().mockResolvedValue(conversation());
    api.getUserPrefs.mockReset().mockResolvedValue({});
    api.loadConversation
      .mockReset()
      .mockResolvedValue({ ...conversation({ turnCount: 1 }), messages: [] });
    api.searchVaultEntities.mockReset().mockResolvedValue([]);
    api.setConversationFeedback.mockReset().mockResolvedValue(undefined);
    api.streamAssistantTurn
      .mockReset()
      .mockImplementation(streamAskingFor(null));
    api.uploadConversationAttachment.mockReset();
    providers.loadHarnesses.mockReset().mockResolvedValue({
      ...harnessStatus([
        ["codex", "Codex"],
        ["claude-code", "Claude Code"],
        ["copilot", "Copilot"],
      ]),
      cards: [
        {
          ...harnessCard("codex", "Codex"),
          breakerStates: [{ failureClass: "quota", state: "open" }],
        },
        harnessCard("claude-code", "Claude Code"),
        harnessCard("copilot", "Copilot"),
      ],
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  describe("AssistantRoute provider consent", () => {
    it("resends after approval with the same idempotency key and no second user bubble", async () => {
      api.streamAssistantTurn.mockImplementation(
        streamAskingFor("claude-code", null)
      );
      const bridge = await mount();

      await act(async () => bridge.onSend("what changed?"));

      expect(actions.confirm).toHaveBeenCalledOnce();
      expect(api.streamAssistantTurn).toHaveBeenCalledTimes(2);
      const [first, second] = api.streamAssistantTurn.mock.calls.map(
        (call) => call[0] as { idempotencyKey: string; message: string }
      );
      expect(second!.idempotencyKey).toBe(first!.idempotencyKey);
      expect(second!.message).toBe("what changed?");
      expect(consentPerCall()).toStrictEqual([undefined, "claude-code"]);
      const userBubbles = captured.snapshots.map(
        (snapshot) =>
          snapshot.messages.filter((message) => message.kind === "user").length
      );
      expect(Math.max(...userBubbles)).toBe(1);
    });

    it("accumulates approvals so a consent-gated failover keeps the first provider", async () => {
      api.streamAssistantTurn.mockImplementation(
        streamAskingFor("claude-code", "copilot", null)
      );
      const bridge = await mount();

      await act(async () => bridge.onSend("what changed?"));

      expect(actions.confirm).toHaveBeenCalledTimes(2);
      expect(consentPerCall()).toStrictEqual([
        undefined,
        "claude-code",
        ["claude-code", "copilot"],
      ]);
    });

    it("sends nothing more when the owner declines, and says so in the transcript", async () => {
      api.streamAssistantTurn.mockImplementation(
        streamAskingFor("claude-code", null)
      );
      actions.confirm.mockResolvedValue(false);
      const bridge = await mount();

      await act(async () => bridge.onSend("what changed?"));

      expect(api.streamAssistantTurn).toHaveBeenCalledOnce();
      expect(captured.snapshot?.messages.at(-1)).toMatchObject({
        kind: "notice",
        text: "Nothing was sent to claude-code.",
      });
    });
  });

  describe("AssistantRoute picker + workspace", () => {
    it("carries breaker health in the harness hint, like the builder and automation pickers", async () => {
      const bridge = await mount();
      await expect(bridge.loadModelPicker()).resolves.toMatchObject({
        harnesses: expect.arrayContaining([
          expect.objectContaining({
            kind: "codex",
            hint: "ready · quota open",
          }),
        ]),
      });
    });

    it("puts the explicitly selected harness on the next turn", async () => {
      const bridge = await mount();
      await bridge.loadModelPicker();
      await bridge.onSetHarness("claude-code");

      await act(async () => {
        bridge.onSend("which harness handled this?");
        await Promise.resolve();
      });

      expect(api.streamAssistantTurn).toHaveBeenCalledWith(
        expect.objectContaining({ harnessKind: "claude-code" }),
        expect.any(Function),
        expect.anything()
      );
    });

    it("keeps the latest overlapping harness switch", async () => {
      const first = deferred<HarnessStatus>();
      const second = deferred<HarnessStatus>();
      providers.loadHarnesses
        .mockReset()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const bridge = await mount();

      const firstSwitch = bridge.onSetHarness("claude-code");
      const secondSwitch = bridge.onSetHarness("copilot");
      second.resolve(
        harnessStatus([
          ["codex", "Codex"],
          ["claude-code", "Claude Code"],
          ["copilot", "Copilot"],
        ])
      );
      await secondSwitch;
      first.resolve(
        harnessStatus([
          ["codex", "Codex"],
          ["claude-code", "Claude Code"],
          ["copilot", "Copilot"],
        ])
      );
      await firstSwitch;

      await act(async () => {
        bridge.onSend("which harness won the race?");
        await Promise.resolve();
      });

      expect(api.streamAssistantTurn).toHaveBeenCalledWith(
        expect.objectContaining({ harnessKind: "copilot" }),
        expect.any(Function),
        expect.anything()
      );
    });

    it("does not let the initial picker load overwrite a persisted harness", async () => {
      const transcript = deferred<
        ReturnType<typeof conversation> & { messages: [] }
      >();
      api.loadConversation
        .mockReset()
        .mockReturnValueOnce(transcript.promise)
        .mockResolvedValue({ ...conversation(), messages: [] });
      const bridge = await mount("conversation-1");

      await bridge.loadModelPicker();
      transcript.resolve({
        ...conversation({ harnessKind: "claude-code" }),
        messages: [],
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      await act(async () => {
        bridge.onSend("use the persisted harness");
        await Promise.resolve();
      });

      expect(api.streamAssistantTurn).toHaveBeenCalledWith(
        expect.objectContaining({ harnessKind: "claude-code" }),
        expect.any(Function),
        expect.anything()
      );
    });

    it("refuses a relative scoped folder and keeps the shared list unchanged", async () => {
      const { openPrompt } = await import("../prompt.js");
      vi.mocked(openPrompt).mockResolvedValue("relative/path");
      const bridge = await mount();

      await act(async () => {
        bridge.onAddWorkspace?.();
        await Promise.resolve();
      });

      expect(actions.showToast).toHaveBeenCalledWith(
        expect.stringContaining("absolute path")
      );
      expect(captured.snapshot?.additionalDirectories).toBeUndefined();
    });
  });
});
