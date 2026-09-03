import { act } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import PanelBlock from "./PanelBlock.js";

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

describe("ui/PanelBlock", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  it("renders eyebrow, title and body when they are given", () => {
    const el = mount(
      <PanelBlock
        body="The gateway answered, but the queue did not."
        eyebrow="Could not reach the consent store"
        title="Nothing was approved"
      />
    );
    expect(el.querySelector(".eyebrow")?.textContent).toBe(
      "Could not reach the consent store"
    );
    expect(el.querySelector("h3")?.textContent).toBe("Nothing was approved");
    expect(el.querySelector(".body")?.textContent).toContain("queue");
  });

  it("omits every optional part rather than rendering an empty one", () => {
    const el = mount(<PanelBlock facts={[{ key: "cpu", value: "12%" }]} />);
    expect(el.querySelector(".eyebrow")).toBeNull();
    expect(el.querySelector("h3")).toBeNull();
    expect(el.querySelector(".body")).toBeNull();
    expect(el.querySelector(".actions")).toBeNull();
  });

  it("is the error state as a BORDER tone, not a fill", () => {
    const el = mount(<PanelBlock title="Could not load" tone="net" />);
    expect((el.querySelector(".panel") as HTMLElement).dataset.tone).toBe(
      "net"
    );
  });

  it("renders facts as a definition list on the fixed key column", () => {
    const el = mount(
      <PanelBlock
        facts={[
          { key: "to", mono: true, value: "tom@pemberton.example" },
          {
            key: "nothing has been sent",
            net: true,
            value: "approving sends it",
          },
        ]}
      />
    );
    const keys = [...el.querySelectorAll("dt")].map((n) => n.textContent);
    expect(keys).toStrictEqual(["to", "nothing has been sent"]);
    const values = el.querySelectorAll("dd");
    expect(values[0]?.dataset.mono).toBe("true");
    expect(values[1]?.dataset.net).toBe("true");
  });

  it("keeps a fact's caveat under the fact it qualifies, out of the numeric register", () => {
    const el = mount(
      <PanelBlock
        facts={[
          {
            key: "harness runs",
            mono: true,
            note: "Measured, not limited by Conserve.",
            value: "3 runs · 9.0s active",
          },
          { key: "sweeps", mono: true, value: "2 passes" },
        ]}
      />
    );
    const notes = [...el.querySelectorAll(".factNote")];
    expect(notes).toHaveLength(1);
    expect(notes[0]?.textContent).toBe("Measured, not limited by Conserve.");
    expect(el.querySelectorAll("dd")[0]?.contains(notes[0] ?? null)).toBe(true);
  });

  it("promotes one fact to the display rung, with what it is and what it leaves out", () => {
    const el = mount(
      <PanelBlock
        figure={{
          label: "At least · 30 days",
          qualifier: "$2.10 harness-reported · 1 unpriced.",
          value: "$3.40",
        }}
      />
    );
    expect(el.querySelector(".figureLabel")?.textContent).toBe(
      "At least · 30 days"
    );
    expect(el.querySelector(".figureValue")?.textContent).toBe("$3.40");
    expect(el.querySelector(".figureQualifier")?.textContent).toBe(
      "$2.10 harness-reported · 1 unpriced."
    );
  });

  it("draws no figure at all rather than an empty one, and tones bad news", () => {
    const plain = mount(<PanelBlock title="Nothing promoted" />);
    expect(plain.querySelector(".figure")).toBeNull();
    act(() => root?.unmount());
    root = null;
    container?.remove();
    const bad = mount(
      <PanelBlock figure={{ label: "Failed", net: true, value: "12" }} />
    );
    expect((bad.querySelector(".figure") as HTMLElement).dataset.net).toBe(
      "true"
    );
    expect(bad.querySelector(".figureQualifier")).toBeNull();
  });

  it("quotes the body only when it is somebody else's words", () => {
    const quoted = mount(<PanelBlock body="Tom — the survey arrived." quote />);
    expect((quoted.querySelector(".body") as HTMLElement).dataset.quote).toBe(
      "true"
    );
  });

  it("fills its action only when asked, and runs both", () => {
    const commit = vi.fn<() => void>();
    const edit = vi.fn<() => void>();
    const el = mount(
      <PanelBlock
        action={{ filled: true, label: "Approve and send", onClick: commit }}
        action2={{ label: "Edit and approve", onClick: edit }}
        title="The survey came back"
      />
    );
    const buttons = [...el.querySelectorAll("button")];
    expect(buttons[0]?.className).toContain("primary");
    expect(buttons[1]?.className).not.toContain("primary");
    act(() => {
      buttons[0]?.click();
      buttons[1]?.click();
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledOnce();
  });

  it("draws a dangerous action outlined in net rather than filled", () => {
    const el = mount(
      <PanelBlock
        action={{
          dangerous: true,
          label: "Erase the vault",
          onClick: () => {},
        }}
      />
    );
    const button = el.querySelector("button") as HTMLButtonElement;
    expect(button.className).toContain("destructive");
    expect(button.className).not.toContain("primary");
  });

  it("drops the reading cap when the panel IS the view", () => {
    const el = mount(<PanelBlock title="Could not load" wide />);
    expect((el.querySelector(".panel") as HTMLElement).dataset.wide).toBe(
      "true"
    );
  });
});
