import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import ShellFrame from "./ShellFrame.js";
import type { ShellFrameProps } from "./ShellFrame.js";

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(el: React.ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}

describe("shell/ShellFrame", () => {
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  const base = {
    stem: <div data-testid="stem">STEM</div>,
    children: <div data-testid="main">MAIN</div>,
  };

  describe(ShellFrame, () => {
    it("renders the frame grid with the stem and the main column", () => {
      const el = render(<ShellFrame {...base} />);
      expect(el.querySelector(".window")).not.toBeNull();
      expect(el.querySelector('[data-testid="stem"]')).not.toBeNull();
      expect(el.querySelector('[data-testid="main"]')).not.toBeNull();
      expect(el.querySelector<HTMLElement>(".appBar")?.dataset.layout).toBe(
        "flat"
      );
    });

    it("offers no way to hide the stem — it never scrolls away", () => {
      // #707 invariant 1. The three-zone sidebar's collapse toggle, its drawer
      // and its scrim are all gone; a frame that can hide its own navigation
      // cannot promise "always the same distance from the reading edge".
      const el = render(<ShellFrame {...base} />);
      expect(el.querySelector('[aria-label="Hide sidebar"]')).toBeNull();
      expect(el.querySelector('[aria-label="Show sidebar"]')).toBeNull();
      expect(el.querySelector(".scrim")).toBeNull();
    });

    it("marks the frame compact so the stem becomes the bottom band", () => {
      const el = render(<ShellFrame {...base} compact />);
      expect(el.querySelector<HTMLElement>(".window")?.dataset.compact).toBe(
        "true"
      );
    });

    it("puts the status line at the bottom of the main column", () => {
      const el = render(
        <ShellFrame {...base} statusLine={<div data-testid="status">S</div>} />
      );
      const main = el.querySelector(".main")!;
      expect([...main.children].at(-1)).toBe(
        el.querySelector('[data-testid="status"]')
      );
    });

    it("renders the app title in the display face with a numeric meta line", () => {
      const el = render(
        <ShellFrame {...base} appTitle="Photos" appMeta="1,904 photos" />
      );
      expect(el.querySelector(".appTitle")?.textContent).toBe("Photos");
      expect(el.querySelector(".appMeta")?.textContent).toBe("1,904 photos");
      // The title is the app's heading, not a decorative string.
      expect(el.querySelector("h1")).not.toBeNull();
    });

    it("omits the identity block entirely when the route names nothing", () => {
      const el = render(<ShellFrame {...base} />);
      expect(el.querySelector(".appIdentity")).toBeNull();
    });

    it("disables back/forward when the callbacks say so", () => {
      const el = render(
        <ShellFrame {...base} canGoBack={false} canGoForward />
      );
      const back = el.querySelector('[aria-label="Back"]') as HTMLButtonElement;
      const fwd = el.querySelector(
        '[aria-label="Forward"]'
      ) as HTMLButtonElement;
      expect(back.disabled).toBe(true);
      expect(fwd.disabled).toBe(false);
    });

    it("fires nav callbacks", () => {
      const onBack = vi.fn<NonNullable<ShellFrameProps["onBack"]>>();
      const el = render(<ShellFrame {...base} canGoBack onBack={onBack} />);
      act(() =>
        (el.querySelector('[aria-label="Back"]') as HTMLButtonElement).click()
      );
      // This fires straight off a native button `onClick`, so the callback
      // receives the click SyntheticEvent, not a bare invocation.
      expect(onBack).toHaveBeenCalledWith(
        expect.objectContaining({ type: "click" })
      );
    });

    it("shows the New app pencil whenever the host wires one", () => {
      const el = render(<ShellFrame {...base} showNewChat />);
      expect(el.querySelector('[aria-label="New app"]')).not.toBeNull();
      act(() => root?.unmount());
      host?.remove();
      const without = render(<ShellFrame {...base} />);
      expect(without.querySelector('[aria-label="New app"]')).toBeNull();
    });

    it("uses the grid layout with a center cluster", () => {
      const el = render(
        <ShellFrame
          {...base}
          titlebarCenter={<div data-testid="center">C</div>}
        />
      );
      expect(el.querySelector<HTMLElement>(".appBar")?.dataset.layout).toBe(
        "grid"
      );
      expect(el.querySelector(".tlNav")).not.toBeNull();
      expect(
        el.querySelector('.tlContext [data-testid="center"]')
      ).not.toBeNull();
    });
  });
});
