import { act } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import NoteBlock from "./NoteBlock.js";

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

describe("ui/NoteBlock", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  it("renders the caller's sentence as a paragraph", () => {
    const el = mount(
      <NoteBlock>
        A standing grant skips this page for one narrow thing.
      </NoteBlock>
    );
    expect(el.querySelector("p")?.textContent).toBe(
      "A standing grant skips this page for one narrow thing."
    );
  });

  it("carries rich children, not just a string", () => {
    const el = mount(
      <NoteBlock>
        <strong>Nothing</strong> has been sent.
      </NoteBlock>
    );
    expect(el.querySelector("p strong")?.textContent).toBe("Nothing");
  });
});
