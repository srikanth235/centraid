import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import DecideBlock from "./DecideBlock.js";
import type { DecideBlockProps } from "./DecideBlock.js";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(props: DecideBlockProps): HTMLDivElement {
  host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host as HTMLDivElement);
    root.render(<DecideBlock {...props} />);
  });
  return host;
}

function button(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text
  );
  if (!found) throw new Error(`no button labelled "${text}"`);
  return found as HTMLButtonElement;
}

const base: DecideBlockProps = {
  eyebrow: "Staged write · personal",
  title: "gmail.send → ravi@example.com",
};

describe("ui/DecideBlock", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    vi.clearAllMocks();
  });

  it("states its kind, its age and its title before anything is open", () => {
    const el = render({ ...base, age: "5m ago", sub: "Staged by Briefing" });
    expect(el.textContent).toContain("Staged write · personal");
    expect(el.textContent).toContain("5m ago");
    expect(el.textContent).toContain("gmail.send → ravi@example.com");
    expect(el.textContent).toContain("Staged by Briefing");
    expect(el.querySelector("dl")).toBeNull();
  });

  it("makes the whole title block the disclosure, and nothing else", () => {
    let toggles = 0;
    const el = render({
      ...base,
      onToggle: () => {
        toggles += 1;
      },
      open: false,
    });
    const disclosure = el.querySelector(
      "button[aria-expanded]"
    ) as HTMLButtonElement;
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(disclosure.textContent).toContain("gmail.send → ravi@example.com");
    expect(el.querySelectorAll("button[aria-expanded]")).toHaveLength(1);
    act(() => disclosure.click());
    expect(toggles).toBe(1);
  });

  it("renders a title block that is not a control when nothing can open", () => {
    const el = render(base);
    expect(el.querySelector("button")).toBeNull();
  });

  it("states a computed fact and edits an authorable one", () => {
    const typed: string[] = [];
    const el = render({
      ...base,
      facts: [
        { key: "size", value: "4.2 KB across 3 files" },
        {
          field: { label: "Subject", onChange: (next) => typed.push(next) },
          key: "subject",
          value: "Hi",
        },
      ],
    });
    expect(el.querySelector('input[aria-label="size"]')).toBeNull();
    expect(el.textContent).toContain("4.2 KB across 3 files");
    const input = el.querySelector(
      'input[aria-label="Subject"]'
    ) as HTMLInputElement;
    expect(input.value).toBe("Hi");
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    act(() => {
      setter?.call(input, "New subject");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(typed).toStrictEqual(["New subject"]);
  });

  it("gives a body-like field a textarea rather than a single line", () => {
    const el = render({
      ...base,
      facts: [
        {
          field: { label: "Body", multiline: true, onChange: () => undefined },
          key: "body",
          value: "See you at 6.",
        },
      ],
    });
    expect(
      (el.querySelector('textarea[aria-label="Body"]') as HTMLTextAreaElement)
        .value
    ).toBe("See you at 6.");
  });

  it("marks the value that leaves the device and the one that is numeric", () => {
    const el = render({
      ...base,
      facts: [
        { key: "to", mono: true, value: "ravi@example.com" },
        {
          key: "nothing has been sent",
          net: true,
          value: "approving sends it",
        },
      ],
    });
    const values = [...el.querySelectorAll<HTMLElement>(".factText")];
    expect(values[0]?.dataset.mono).toBe("true");
    expect(values[0]?.dataset.net).toBeUndefined();
    expect(values[1]?.dataset.net).toBe("true");
  });

  it("quotes what the write would do, and offers the standing grant in place", () => {
    const ticks: boolean[] = [];
    const el = render({
      ...base,
      check: {
        label: "Always allow this",
        on: false,
        onChange: (next) => ticks.push(next),
        sub: "Briefing sends to that address without asking.",
      },
      open: true,
      preview: { body: "See you at 6.", label: "what it would do" },
    });
    expect(el.querySelector(".previewLabel")?.textContent).toBe(
      "what it would do"
    );
    expect(el.querySelector(".previewBody")?.textContent).toBe("See you at 6.");
    const box = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(el.textContent).toContain(
      "Briefing sends to that address without asking."
    );
    act(() => box.click());
    expect(ticks).toStrictEqual([true]);
    expect(box.checked).toBe(false);
  });

  it("fills the commit, outlines the destructive verb, and states a refused one", () => {
    const el = render({
      ...base,
      actions: [
        { kind: "commit", label: "Approve", onClick: () => undefined },
        {
          disabled: true,
          hint: "The gateway cannot rebuild a request for this verb",
          kind: "outline",
          label: "Edit and approve",
          onClick: () => undefined,
        },
        { kind: "net", label: "Discard", onClick: () => undefined },
      ],
      open: true,
    });
    expect(button(el, "Approve").className).toContain("primary");
    const edit = button(el, "Edit and approve");
    expect(edit.disabled).toBe(true);
    expect(edit.title).toBe(
      "The gateway cannot rebuild a request for this verb"
    );
    const discard = button(el, "Discard");
    expect(discard.className).toContain("destructive");
    expect(discard.className).not.toContain("primary");
  });

  it("turns the border --net while an irreversible verb is confirmed", () => {
    const el = render({
      ...base,
      actions: [
        { kind: "net", label: "Do it", onClick: () => undefined },
        { kind: "quiet", label: "Keep it", onClick: () => undefined },
      ],
      confirming: true,
      note: "Nothing will be sent.",
      noteNet: true,
      open: true,
    });
    const card = el.querySelector<HTMLElement>(".card");
    expect(card?.dataset.confirm).toBe("true");
    expect(el.querySelector<HTMLElement>(".note")?.dataset.net).toBe("true");
    expect(button(el, "Do it").className).toContain("destructive");
    expect(button(el, "Keep it").className).toContain("quiet");
  });

  it("marks a decision whose consequence leaves the device", () => {
    const el = render({ ...base, net: true });
    expect(el.querySelector<HTMLElement>(".card")?.dataset.net).toBe("true");
  });
});
