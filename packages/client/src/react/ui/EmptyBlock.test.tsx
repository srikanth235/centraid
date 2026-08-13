import { act } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import EmptyBlock from "./EmptyBlock.js";

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

describe("ui/EmptyBlock", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  it("is the first-run form by default: a FILLED commit", () => {
    const el = mount(
      <EmptyBlock
        action={{ label: "Connect something", onClick: () => {} }}
        body="Nothing has asked to reach outside yet."
        title="Nothing is connected"
      />
    );
    expect(
      (el.querySelector(".empty") as HTMLElement).dataset.routine
    ).toBeUndefined();
    expect(
      (el.querySelector("button") as HTMLButtonElement).className
    ).toContain("primary");
  });

  it("is quiet and outlined in the routine form — the filled control is in the bar", () => {
    const el = mount(
      <EmptyBlock
        action={{ label: "Review history", onClick: () => {} }}
        body="Nothing is waiting on you."
        routine
        title="Nothing to decide"
      />
    );
    expect((el.querySelector(".empty") as HTMLElement).dataset.routine).toBe(
      "true"
    );
    const button = el.querySelector("button") as HTMLButtonElement;
    expect(button.className).not.toContain("primary");
    expect(button.className).toContain("secondary");
  });

  it("names the state as a heading, so an empty page still has an outline", () => {
    const el = mount(
      <EmptyBlock
        body="Nothing is waiting on you."
        routine
        title="Nothing to decide"
      />
    );
    expect(el.querySelector("h2")?.textContent).toBe("Nothing to decide");
  });

  it("renders no action row when the state offers nothing to do", () => {
    const el = mount(<EmptyBlock body="Nothing yet." routine title="Empty" />);
    expect(el.querySelector(".actions")).toBeNull();
  });

  it("runs both verbs, and the second one is the quiet one", () => {
    const first = vi.fn<() => void>();
    const second = vi.fn<() => void>();
    const el = mount(
      <EmptyBlock
        action={{ label: "Pair a device", onClick: first }}
        action2={{ label: "Recovery", onClick: second }}
        body="Pair this gateway with a phone or a laptop to get started."
        title="No devices yet"
      />
    );
    const buttons = [...el.querySelectorAll("button")];
    expect(buttons[1]?.className).toContain("quiet");
    act(() => {
      buttons[0]?.click();
      buttons[1]?.click();
    });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });
});
