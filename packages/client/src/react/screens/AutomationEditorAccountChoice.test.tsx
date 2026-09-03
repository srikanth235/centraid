import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AutomationEditorBridgeProps,
  AutomationEditorData,
} from "../screen-contracts.js";
import AutomationEditorScreen from "./AutomationEditorScreen.js";

function makeData(
  over: Partial<AutomationEditorData> = {}
): AutomationEditorData {
  return {
    automationId: null,
    consent: { grants: [], outbox: [], parked: [] },
    enabled: false,
    instructions: "",
    mode: "create",
    name: "",
    triggers: [],
    webhook: null,
    ...over,
  };
}

function setSelectValue(el: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    globalThis.HTMLSelectElement.prototype,
    "value"
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function makeProps(
  over: Partial<AutomationEditorBridgeProps> = {}
): AutomationEditorBridgeProps {
  return {
    loadData: vi
      .fn<AutomationEditorBridgeProps["loadData"]>()
      .mockResolvedValue(makeData()),
    onCancel: vi.fn<AutomationEditorBridgeProps["onCancel"]>(),
    onCompile: vi
      .fn<AutomationEditorBridgeProps["onCompile"]>()
      .mockResolvedValue(null),
    onCopyWebhook: vi.fn<AutomationEditorBridgeProps["onCopyWebhook"]>(),
    onDecideConsent: vi
      .fn<AutomationEditorBridgeProps["onDecideConsent"]>()
      .mockResolvedValue(true),
    onDelete: vi
      .fn<AutomationEditorBridgeProps["onDelete"]>()
      .mockResolvedValue(false),
    onOpenRun: vi.fn<AutomationEditorBridgeProps["onOpenRun"]>(),
    onOpenRuns: vi.fn<AutomationEditorBridgeProps["onOpenRuns"]>(),
    loadCompileAttempts: vi
      .fn<AutomationEditorBridgeProps["loadCompileAttempts"]>()
      .mockResolvedValue([]),
    loadTurnSteps: vi
      .fn<AutomationEditorBridgeProps["loadTurnSteps"]>()
      .mockResolvedValue([]),
    watchTurnSteps: vi
      .fn<AutomationEditorBridgeProps["watchTurnSteps"]>()
      .mockResolvedValue({ settled: true, ok: true }),
    onTestRun: vi
      .fn<AutomationEditorBridgeProps["onTestRun"]>()
      .mockResolvedValue(null),
    onReadSource: vi
      .fn<AutomationEditorBridgeProps["onReadSource"]>()
      .mockResolvedValue({ handler: null, manifest: null }),
    onRotateWebhook: vi
      .fn<AutomationEditorBridgeProps["onRotateWebhook"]>()
      .mockResolvedValue(true),
    onSearchEntities: vi
      .fn<AutomationEditorBridgeProps["onSearchEntities"]>()
      .mockResolvedValue([]),
    onSave: vi
      .fn<AutomationEditorBridgeProps["onSave"]>()
      .mockResolvedValue(true),
    onToggleEnabled: vi
      .fn<AutomationEditorBridgeProps["onToggleEnabled"]>()
      .mockResolvedValue(true),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

describe("AutomationEditorAccountChoice", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  async function mount(
    props: AutomationEditorBridgeProps
  ): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(<AutomationEditorScreen {...props} />);
    });
    return container;
  }

  function setValue(el: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
      globalThis.HTMLInputElement.prototype,
      "value"
    )?.set;
    act(() => {
      setter?.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function button(el: HTMLElement, label: string): HTMLButtonElement {
    return [...el.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label
    ) as HTMLButtonElement;
  }

  it("chooses among configured accounts inline and preserves the explicit binding on refresh", async () => {
    const account = (
      connectionId: string,
      label: string,
      principal: string
    ) => ({
      connectionId,
      health: "ok" as const,
      label,
      principal,
    });
    const base = {
      allowedHosts: ["api.github.com"],
      credKind: "api_key" as const,
      key: "github:pull.github",
      kind: "pull.github",
      name: "GitHub",
      providerId: "github",
      providerName: "GitHub",
      setup: [] as string[],
      templateId: "github-pull",
      tone: "github",
    };
    const personal = account(
      "conn-personal",
      "GitHub · personal",
      "personal@example.com"
    );
    const work = account("conn-work", "GitHub · work", "work@example.com");
    const loadConnectorCatalog = vi
      .fn<NonNullable<AutomationEditorBridgeProps["loadConnectorCatalog"]>>()
      .mockResolvedValueOnce([
        { ...base, connection: null, connections: [personal, work] },
      ])
      .mockResolvedValue([
        { ...base, connection: personal, connections: [personal] },
      ]);
    const props = makeProps({ loadConnectorCatalog });
    const el = await mount(props);
    setValue(
      el.querySelector('input[aria-label="Name"]') as HTMLInputElement,
      "Account picker"
    );

    const connectorsButton = [...el.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.includes("Connectors")
    ) as HTMLButtonElement;
    await act(async () =>
      connectorsButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    await act(async () => {
      await new Promise<void>((resolve) => {
        queueMicrotask(resolve);
      });
    });

    const picker = el.querySelector(
      '[data-testid="automation-connectors-picker"]'
    );
    expect(picker?.textContent).toContain("2 configured accounts");
    expect(picker?.textContent).toContain("personal@example.com");
    expect(picker?.textContent).toContain("work@example.com");
    const workButton = picker?.querySelector(
      '[data-connection-id="conn-work"]'
    ) as HTMLButtonElement;
    await act(async () =>
      workButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );

    await act(async () =>
      connectorsButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    await act(async () =>
      connectorsButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    await act(async () => {
      await new Promise<void>((resolve) => {
        queueMicrotask(resolve);
      });
    });

    const refreshed = el.querySelector(
      '[data-testid="automation-connectors-picker"]'
    );
    expect(
      refreshed?.querySelector('[data-testid="connector-account-dangling"]')
    ).toBeTruthy();
    expect(refreshed?.textContent).toContain("no longer configured");
    expect(refreshed?.textContent).toContain("Bound account unavailable");
    expect(refreshed?.textContent).not.toContain(
      "Connected · GitHub · personal"
    );
    expect(
      refreshed?.querySelector('[data-connection-id="conn-personal"]')
    ).toBeTruthy();
    const survivor = refreshed?.querySelector(
      '[data-connection-id="conn-personal"]'
    );
    expect((survivor as HTMLElement | null)?.dataset.chosen).toBe("false");
    const addTrigger = [...el.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "+ Add Trigger"
    ) as HTMLButtonElement;
    await act(async () =>
      addTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(
      el.querySelector('[aria-label="Trigger kinds"]')?.textContent
    ).not.toContain("Connector");

    await act(async () =>
      button(el, "Create automation").dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      )
    );
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        connections: [
          {
            connectionId: "conn-work",
            kind: "pull.github",
            label: "GitHub · work",
          },
        ],
      })
    );
  });

  it("offers an event trigger while the bound account is live, and drops it when it vanishes", async () => {
    const personal = {
      connectionId: "conn-personal",
      health: "ok" as const,
      label: "GitHub · personal",
      principal: "personal@example.com",
    };
    const base = {
      allowedHosts: ["api.github.com"],
      credKind: "api_key" as const,
      key: "github:pull.github",
      kind: "pull.github",
      name: "GitHub",
      providerId: "github",
      providerName: "GitHub",
      setup: [] as string[],
      templateId: "github-pull",
      tone: "github",
    };
    const loadConnectorCatalog = vi
      .fn<NonNullable<AutomationEditorBridgeProps["loadConnectorCatalog"]>>()
      .mockResolvedValue([
        { ...base, connection: personal, connections: [personal] },
      ]);
    const el = await mount(makeProps({ loadConnectorCatalog }));
    const connectorsButton = [...el.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.includes("Connectors")
    ) as HTMLButtonElement;
    await act(async () =>
      connectorsButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    await act(async () => {
      await new Promise<void>((resolve) => {
        queueMicrotask(resolve);
      });
    });
    const row = el.querySelector(
      '[data-kind="pull.github"] button'
    ) as HTMLButtonElement;
    await act(async () =>
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(
      el.querySelector('[data-testid="connector-binding-dangling"]')
    ).toBeNull();

    const addTrigger = [...el.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "+ Add Trigger"
    ) as HTMLButtonElement;
    await act(async () =>
      addTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(
      el.querySelector('[aria-label="Trigger kinds"]')?.textContent
    ).toContain("Connector");
  });

  it("saves a dynamic per-automation harness and model pin", async () => {
    const data = makeData({
      harnesses: [
        {
          accent: "#556677",
          connected: true,
          defaultModel: "gpt-default",
          kind: "codex",
          label: "Codex",
          models: [{ default: true, id: "gpt-default", name: "GPT Default" }],
        },
        {
          accent: "#775566",
          connected: true,
          defaultModel: "acp-default",
          kind: "acp",
          label: "Work ACP",
          models: [
            { default: true, id: "acp-default", name: "ACP Default" },
            { id: "acp-smart", name: "ACP Smart" },
          ],
        },
      ],
      defaultModel: "gpt-default",
      defaultHarnessKind: "codex",
      model: null,
      harness: null,
    });
    const props = makeProps({
      loadData: vi
        .fn<AutomationEditorBridgeProps["loadData"]>()
        .mockResolvedValue(data),
    });
    const el = await mount(props);
    setValue(
      el.querySelector('input[aria-label="Name"]') as HTMLInputElement,
      "Pinned agent"
    );

    const agentButton = [...el.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Agent")
    ) as HTMLButtonElement;
    await act(async () =>
      agentButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(el.textContent).toContain("Use default (codex)");
    expect(el.textContent).toContain("Work ACP");

    const harnessPickerSelects = el.querySelectorAll("select");
    setSelectValue(harnessPickerSelects[0] as HTMLSelectElement, "acp");
    expect(el.textContent).toContain("Use default (acp-default)");
    setSelectValue(harnessPickerSelects[1] as HTMLSelectElement, "acp-smart");

    await act(async () =>
      button(el, "Create automation").dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      )
    );
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ model: "acp-smart", harness: "acp" })
    );
  });
});
