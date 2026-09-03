import { act } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import ChipsBlock from "./ChipsBlock.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(node: JSX.Element): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(node);
  });
  return container;
}

const WINDOW = [
  { id: "7", label: "7 days", on: true },
  { id: "30", label: "30 days" },
  { id: "90", label: "90 days" },
];

describe("ui/ChipsBlock", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  it("names the GROUP, and lets each chip's visible text be its own name", () => {
    const el = mount(
      <ChipsBlock ariaLabel="Window" chips={WINDOW} onPick={() => {}} />
    );
    const group = el.querySelector(".chips") as HTMLElement;
    expect(group.tagName).toBe("FIELDSET");
    expect(group.getAttribute("aria-label")).toBe("Window");
    for (const chip of el.querySelectorAll("button"))
      expect(chip.getAttribute("aria-label")).toBeNull();
  });

  it("states which chip is on with aria-pressed, not a class string", () => {
    const el = mount(
      <ChipsBlock ariaLabel="Window" chips={WINDOW} onPick={() => {}} />
    );
    const pressed = [...el.querySelectorAll("button")].map((b) =>
      b.getAttribute("aria-pressed")
    );
    expect(pressed).toStrictEqual(["true", "false", "false"]);
  });

  it("reports the chip's id when it is picked", () => {
    const onPick = vi.fn<(id: string) => void>();
    const el = mount(
      <ChipsBlock ariaLabel="Window" chips={WINDOW} onPick={onPick} />
    );
    act(() => {
      el.querySelectorAll("button")[1]?.click();
    });
    expect(onPick).toHaveBeenCalledWith("30");
  });

  it("flags the numeric register so the window cannot reorder under RTL", () => {
    const el = mount(
      <ChipsBlock ariaLabel="Window" chips={WINDOW} mono onPick={() => {}} />
    );
    expect((el.querySelector(".chips") as HTMLElement).dataset.mono).toBe(
      "true"
    );
  });

  it("is not mono by default — a filter chip is a word, not a number", () => {
    const el = mount(
      <ChipsBlock
        ariaLabel="Filters"
        chips={[{ id: "all", label: "Everything", on: true }]}
        onPick={() => {}}
      />
    );
    expect(
      (el.querySelector(".chips") as HTMLElement).dataset.mono
    ).toBeUndefined();
  });
});
