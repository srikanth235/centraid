import { readFileSync } from "node:fs";
import path from "node:path";

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import AssistantCompanion from "./AssistantCompanion.js";
import type { AssistantHarnessOption } from "./assistantCompanionModel.js";

const catalog = [
  {
    id: "ready-tool",
    installed: true,
    label: "Ready tool",
    models: [
      {
        efforts: [
          { id: "low", label: "low", note: "A quick pass." },
          { id: "high", label: "high", note: "The longest pass." },
        ],
        id: "model-a",
        label: "Model A",
      },
    ],
    statusLabel: "signed in",
    vendorLabel: "Provider A",
  },
  {
    id: "missing-tool",
    installed: false,
    label: "Missing tool",
    models: [{ efforts: [], id: "model-b", label: "Model B" }],
    statusLabel: "not installed",
    vendorLabel: "Provider B",
  },
] as const satisfies readonly AssistantHarnessOption[];

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(
  props: Partial<React.ComponentProps<typeof AssistantCompanion>> = {}
): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <AssistantCompanion
        surface="pointer"
        catalog={catalog}
        messages={[]}
        onRemoveAttachment={() => undefined}
        onRequestAttachment={() => undefined}
        onSend={() => undefined}
        onStop={() => undefined}
        {...props}
      />
    )
  );
  return host;
}

function button(label: string): HTMLButtonElement {
  return host!.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`
  )!;
}

function write(textarea: HTMLTextAreaElement, text: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe(AssistantCompanion, () => {
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  it("opens the pointer pill with the keyboard and reports rail reservation state", () => {
    const onRailOpenChange = vi.fn<(open: boolean) => void>();
    const view = render({ onRailOpenChange });
    expect(view.querySelector("button")?.textContent).toContain("Ask");
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { ctrlKey: true, key: "j" })
      )
    );
    expect(
      view.querySelector('dialog[aria-label="Assistant companion"]')
    ).not.toBeNull();
    expect(onRailOpenChange).toHaveBeenLastCalledWith(true);
  });

  it("uses a touch sheet with a closing scrim", () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    render({ defaultOpen: true, onOpenChange, surface: "touch" });
    act(() => button("Close Assistant").click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("sends on Enter, preserves Shift+Enter, and supplies context and attachments", () => {
    const onSend =
      vi.fn<React.ComponentProps<typeof AssistantCompanion>["onSend"]>();
    render({
      attachments: [{ id: "attachment-1", label: "Notes" }],
      contextLabel: "Docs · survey",
      defaultOpen: true,
      onSend,
    });
    const textarea = host!.querySelector("textarea")!;
    write(textarea, "First line");
    act(() =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Enter",
          shiftKey: true,
        })
      )
    );
    expect(onSend).not.toHaveBeenCalled();
    act(() =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
      )
    );
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentIds: ["attachment-1"],
        includeContext: true,
        text: "First line",
      })
    );
  });

  it("closes the picker before the panel and disables send for an unavailable harness", () => {
    const view = render({ defaultOpen: true });
    act(() =>
      host!
        .querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!
        .click()
    );
    expect(view.querySelectorAll("dialog")).toHaveLength(2);
    const missing = [
      ...view.querySelectorAll<HTMLButtonElement>("button"),
    ].find((item) => item.textContent?.includes("Missing tool"))!;
    act(() => missing.click());
    const textarea = view.querySelector("textarea")!;
    write(textarea, "Can this send?");
    expect(button("Send message").disabled).toBe(true);
    expect(view.textContent).toContain("is not installed");

    act(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    );
    expect(view.querySelectorAll("dialog")).toHaveLength(1);
    act(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    );
    expect(
      view.querySelector('dialog[aria-label="Assistant companion"]')
    ).toBeNull();
  });

  it("keeps stop in the send slot while working", () => {
    const onStop = vi.fn<() => void>();
    render({ defaultOpen: true, onStop, working: true });
    expect(button("Send message")).toBeNull();
    act(() => button("Stop response").click());
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("offers all five honest attachment sources", () => {
    const onRequestAttachment =
      vi.fn<
        React.ComponentProps<typeof AssistantCompanion>["onRequestAttachment"]
      >();
    const view = render({ defaultOpen: true, onRequestAttachment });
    act(() => button("Add attachment").click());
    const choices = [
      ...view.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ];
    expect(choices.map((choice) => choice.textContent)).toStrictEqual([
      "Choose a document file",
      "Choose a photo file",
      "This page as text",
      "Choose a file from this device",
      "Add a link URL",
    ]);
    act(() => choices[2]?.click());
    expect(onRequestAttachment).toHaveBeenCalledWith("page");

    act(() => button("Add attachment").click());
    const linkChoice = [
      ...view.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].at(-1)!;
    act(() => linkChoice.click());
    expect(view.querySelector('[aria-label="Link URL"]')).not.toBeNull();
  });

  it("uses the shared touch-target floor for touch controls", () => {
    const css = readFileSync(
      path.join(import.meta.dirname, "AssistantCompanion.module.css"),
      "utf8"
    );
    const coarse = /@media \(pointer: coarse\) \{(?<body>[\s\S]*)\n\}/u.exec(
      css
    )?.groups?.body;
    expect(coarse, "coarse-pointer rules not found").toBeTypeOf("string");
    expect(coarse).toContain(".panel button");
    expect(coarse).toContain("min-block-size: var(--target-min)");
    expect(coarse).toContain(".sendButton");
    expect(coarse).toContain("min-inline-size: var(--target-min)");
  });
});
