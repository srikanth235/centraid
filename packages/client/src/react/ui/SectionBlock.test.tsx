import { act } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

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

  it("draws no toggle when the section does not open", () => {
    const el = mount(<SectionBlock label="Standing grants" />);
    expect(el.querySelector("button")).toBeNull();
    expect(
      (el.querySelector(".section") as HTMLElement).dataset.collapsed
    ).toBeUndefined();
  });

  it("reads Hide while the body is shown, and Show once it is not", () => {
    const el = mount(
      <SectionBlock label="On record" onToggle={() => {}} collapsed={false} />
    );
    const verb = el.querySelector(".toggle") as HTMLButtonElement;
    expect(verb.textContent).toBe("Hide");
    expect(verb.getAttribute("aria-expanded")).toBe("true");
    expect(
      (el.querySelector(".section") as HTMLElement).dataset.collapsed
    ).toBeUndefined();

    act(() => root?.unmount());
    root = null;
    container?.remove();
    const closed = mount(
      <SectionBlock label="On record" onToggle={() => {}} collapsed />
    );
    const shut = closed.querySelector(".toggle") as HTMLButtonElement;
    expect(shut.textContent).toBe("Show");
    expect(shut.getAttribute("aria-expanded")).toBe("false");
    expect(
      (closed.querySelector(".section") as HTMLElement).dataset.collapsed
    ).toBe("true");
  });

  it("stays quiet — the head never carries the view's filled control", () => {
    const el = mount(<SectionBlock label="On record" onToggle={() => {}} />);
    const verb = el.querySelector(".toggle") as HTMLButtonElement;
    expect(verb.className).toContain("quiet");
    expect(verb.className).not.toContain("primary");
  });

  it("hands the toggle back to the parent, which owns the state", () => {
    const onToggle = vi.fn<() => void>();
    const el = mount(<SectionBlock label="On record" onToggle={onToggle} />);
    act(() => {
      (el.querySelector(".toggle") as HTMLButtonElement).click();
    });
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("carries a section verb and a toggle at once, in that order", () => {
    const el = mount(
      <SectionBlock
        action={{ label: "Refresh", onClick: () => {} }}
        label="Recent activity"
        onToggle={() => {}}
      />
    );
    const verbs = [...el.querySelectorAll("button")].map((b) => b.textContent);
    expect(verbs).toStrictEqual(["Refresh", "Hide"]);
  });
});
