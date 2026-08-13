import { act } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import SectionBlock from "./SectionBlock.js";

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

describe("ui/SectionBlock", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  it("names the section as a heading, so the page has an outline", () => {
    const el = mount(<SectionBlock label="Waiting on you" />);
    expect(el.querySelector("h2")?.textContent).toBe("Waiting on you");
  });

  it("renders the count beside the label when there is one", () => {
    const el = mount(
      <SectionBlock label="Also waiting" meta="showing 3 of 12" />
    );
    expect(el.querySelector(".meta")?.textContent).toBe("showing 3 of 12");
  });

  it("draws no meta element at all when the count is absent", () => {
    const el = mount(<SectionBlock label="Standing grants" />);
    expect(el.querySelector(".meta")).toBeNull();
  });

  it("takes copy from props only — the kit ships no page prose", () => {
    const el = mount(<SectionBlock label="Runs" meta="312 runs" />);
    expect(el.textContent).toBe("Runs312 runs");
  });
});
