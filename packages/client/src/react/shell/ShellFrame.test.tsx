import { readFileSync } from "node:fs";
import path from "node:path";

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

    it("seams the bar off from the content on every route", () => {
      // Including the routes that name nothing. A boundary that showed up only
      // where there is a title would read as a rendering difference.
      const css = readFileSync(
        path.join(import.meta.dirname, "chrome.module.css"),
        "utf8"
      );
      const rule = /\n\.appBar \{(?<body>[^}]*)\}/u.exec(css)?.groups?.body;
      expect(rule, ".appBar rule not found").toBeTypeOf("string");
      expect(rule!).toMatch(/border-block-end:\s*1px solid var\(--line\)/u);
    });

    it("offers the stem toggle only to a host that owns the state", () => {
      // A frame with no `stemOpen` is a host that cannot answer the question —
      // the compact band and the full-bleed windows. Drawing a dead toggle
      // there would be worse than drawing none.
      const el = render(<ShellFrame {...base} />);
      expect(el.querySelector('[aria-label="Hide sidebar"]')).toBeNull();
      expect(el.querySelector('[aria-label="Show sidebar"]')).toBeNull();
    });

    it("hides the stem without unmounting it, and never behind a scrim", () => {
      const onToggleStem = vi.fn<() => void>();
      const el = render(
        <ShellFrame {...base} stemOpen={false} onToggleStem={onToggleStem} />
      );
      // Hidden, not unmounted: the launcher keeps its scroll position and the
      // vault switcher keeps a box to anchor to.
      expect(el.querySelector('[data-testid="stem"]')).not.toBeNull();
      expect(el.querySelector<HTMLElement>(".window")?.dataset.stem).toBe(
        "hidden"
      );
      // Never a drawer: no scrim over the content, in either state.
      expect(el.querySelector(".scrim")).toBeNull();
      const toggle = el.querySelector<HTMLButtonElement>(
        '[aria-label="Show sidebar"]'
      )!;
      act(() => toggle.click());
      expect(onToggleStem).toHaveBeenCalledOnce();
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

    it("grows the bar into a header only for the full identity lockup", () => {
      // The trigger is the META line, not the title. A title with nothing
      // under it is naming the screen, which is what a titlebar has always
      // done — 31px of window furniture would crowd the content below it.
      const bare = render(<ShellFrame {...base} />);
      expect(
        bare.querySelector<HTMLElement>(".appBar")?.dataset.identity
      ).toBeUndefined();
      act(() => root?.unmount());
      host?.remove();
      const named = render(<ShellFrame {...base} appTitle="Photos" />);
      expect(
        named.querySelector<HTMLElement>(".appBar")?.dataset.identity
      ).toBeUndefined();
      act(() => root?.unmount());
      host?.remove();
      const lockup = render(
        <ShellFrame {...base} appTitle="Photos" appMeta="1,204 photos" />
      );
      expect(
        lockup.querySelector<HTMLElement>(".appBar")?.dataset.identity
      ).toBe("true");
    });

    it("makes the title the switcher when the route hands it an action", () => {
      const onActivate = vi.fn<(anchor: DOMRect) => void>();
      const el = render(
        <ShellFrame
          {...base}
          appTitle="Srikanth's vault"
          appMeta="This Mac"
          appTitleAction={{
            label: "Srikanth's vault on This Mac. Switch vault.",
            onActivate,
            open: true,
          }}
        />
      );
      const title = el.querySelector<HTMLButtonElement>("button.appTitle")!;
      // Still the title: same class, same display face, same string.
      expect(title.textContent).toContain("Srikanth's vault");
      expect(title.getAttribute("aria-expanded")).toBe("true");
      expect(title.getAttribute("aria-label")).toBe(
        "Srikanth's vault on This Mac. Switch vault."
      );
      // A route that names no action gets a heading, never a dead button.
      expect(el.querySelector("h1")).toBeNull();
      act(() => title.click());
      expect(onActivate).toHaveBeenCalledOnce();
      // Anchored to the title's own box, so the popover opens under the name
      // it is switching (jsdom hands back a plain rect, not a DOMRect).
      expect(onActivate.mock.calls[0]![0]).toMatchObject({
        bottom: expect.any(Number),
        left: expect.any(Number),
        width: expect.any(Number),
      });
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
