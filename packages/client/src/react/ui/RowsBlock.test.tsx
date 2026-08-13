import { act } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import RowsBlock from "./RowsBlock.js";

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

describe("ui/RowsBlock", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  it("renders a row's title, sub and meta", () => {
    const el = mount(
      <RowsBlock
        rows={[
          {
            id: "a",
            meta: "Expiring",
            sub: "Expires in 6 days",
            title: "Re-authorize Drive",
          },
        ]}
      />
    );
    expect(el.querySelector(".title")?.textContent).toBe("Re-authorize Drive");
    expect(el.querySelector(".sub")?.textContent).toBe("Expires in 6 days");
    expect(el.querySelector(".meta")?.textContent).toBe("Expiring");
  });

  it("tones only the sub and the meta on a net row — never the title", () => {
    const el = mount(
      <RowsBlock
        rows={[
          {
            id: "a",
            meta: "Failed",
            net: true,
            sub: "at 09:12",
            title: "Nightly backup",
          },
        ]}
      />
    );
    // The tone is a data hook on the ROW; the title rule never reads it.
    expect((el.querySelector(".row") as HTMLElement).dataset.net).toBe("true");
    expect(
      (el.querySelector(".title") as HTMLElement).dataset.net
    ).toBeUndefined();
  });

  it("gives a dangerous row an OUTLINED destructive action, never a fill", () => {
    const el = mount(
      <RowsBlock
        rows={[
          {
            action: { label: "Deny", onClick: () => {} },
            dangerous: true,
            id: "deny",
            title: "Deny this write",
          },
        ]}
      />
    );
    const button = el.querySelector("button") as HTMLButtonElement;
    expect(button.className).toContain("destructive");
    expect(button.className).not.toContain("primary");
  });

  it("runs the row's action on click", () => {
    const onClick = vi.fn<() => void>();
    const el = mount(
      <RowsBlock
        rows={[
          { action: { label: "Revoke", onClick }, id: "g", title: "Grant" },
        ]}
      />
    );
    act(() => {
      (el.querySelector("button") as HTMLButtonElement).click();
    });
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("disables the action of an off row", () => {
    const el = mount(
      <RowsBlock
        rows={[
          {
            action: { label: "Pause", onClick: () => {} },
            id: "o",
            off: true,
            title: "Paused rule",
          },
        ]}
      />
    );
    expect((el.querySelector("button") as HTMLButtonElement).disabled).toBe(
      true
    );
    expect((el.querySelector(".row") as HTMLElement).dataset.off).toBe("true");
  });

  it("carries per-row detail under the row, inside the row's own shell", () => {
    const el = mount(
      <RowsBlock
        rows={[
          {
            children: <textarea aria-label="Edit the message" />,
            id: "outbox",
            title: "Outbound email",
          },
        ]}
      />
    );
    const shell = el.querySelector(".rowShell") as HTMLElement;
    expect(shell.querySelector(".detail textarea")).toBeTruthy();
  });

  it("becomes a named group when it is given a name", () => {
    const el = mount(<RowsBlock ariaLabel="Standing grants" rows={[]} />);
    const rows = el.querySelector(".rows") as HTMLElement;
    expect(rows.tagName).toBe("FIELDSET");
    expect(rows.getAttribute("aria-label")).toBe("Standing grants");
  });

  it("stays a plain container when a section head already names it", () => {
    const el = mount(<RowsBlock rows={[]} />);
    expect((el.querySelector(".rows") as HTMLElement).tagName).toBe("DIV");
  });
});
