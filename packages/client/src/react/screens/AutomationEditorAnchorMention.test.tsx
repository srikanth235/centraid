import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { AutomationEditorBridgeProps } from "../screen-contracts.js";
import AutomationEditorScreen from "./AutomationEditorScreen.js";

function props(
  onSearchEntities: AutomationEditorBridgeProps["onSearchEntities"]
) {
  return {
    loadData: vi
      .fn<AutomationEditorBridgeProps["loadData"]>()
      .mockResolvedValue({
        automationId: null,
        consent: { grants: [], outbox: [], parked: [] },
        enabled: false,
        instructions: "",
        mode: "create",
        name: "",
        triggers: [],
        webhook: null,
      }),
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
    onSave: vi
      .fn<AutomationEditorBridgeProps["onSave"]>()
      .mockResolvedValue(true),
    onToggleEnabled: vi
      .fn<AutomationEditorBridgeProps["onToggleEnabled"]>()
      .mockResolvedValue(true),
    onSearchEntities,
  } satisfies AutomationEditorBridgeProps;
}

describe("AutomationEditorAnchorMention", () => {
  it("inserts an anchor-grade row/field/span token", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSearchEntities = vi
      .fn<AutomationEditorBridgeProps["onSearchEntities"]>()
      .mockResolvedValue([
        {
          id: "anchor-1",
          subtitle: "schedule.task · title · anchored span",
          title: "quarterly report",
          type: "core.link_anchor",
        },
      ]);
    await act(async () =>
      root.render(<AutomationEditorScreen {...props(onSearchEntities)} />)
    );
    const instructions = container.querySelector(
      "textarea"
    ) as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(
      globalThis.HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    act(() => {
      setter?.call(instructions, "Notify me about @quarterly");
      instructions.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
    });
    await act(async () => {
      (container.querySelector(".mentionOption") as HTMLButtonElement).click();
    });
    expect(instructions.value).toBe(
      "Notify me about @[core.link_anchor/anchor-1]"
    );
    expect(
      container.querySelector('[aria-label="Tagged data"]')?.textContent
    ).toContain("@anchorrow · field · span");
    act(() => root.unmount());
    container.remove();
  });
});
